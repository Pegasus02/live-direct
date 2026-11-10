"""The single-file build runs on a bare interpreter with no environment."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'tools'))
import build_aptv  # noqa: E402


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def call(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with OPENER.open(req, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.script = build_aptv.build(self.dir / 'live-direct-aptv.py')
        self.procs = []

    def tearDown(self):
        for proc in self.procs:
            proc.terminate()
            proc.wait(5)
            proc.stdout.close()
        self.tmp.cleanup()

    def start(self, *args):
        env = {k: v for k, v in os.environ.items() if k not in ('PORT', 'BIND_IP', 'PUBLIC_BASE', 'DATA_DIR', 'PYTHONPATH')}
        # -I: no repo on sys.path, so every import must come from the bundle.
        proc = subprocess.Popen([sys.executable, '-I', '-B', str(self.script), '0', *args], cwd=self.dir,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
        self.procs.append(proc)
        lines = []
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and len(lines) < 4:
            line = proc.stdout.readline()
            if not line:
                break
            lines.append(line)
        out = ''.join(lines)
        base = re.search(r'已启动: (\S+)', out)
        self.assertIsNotNone(base, out)
        return base.group(1), out

    def test_runs_without_configuration(self):
        base, out = self.start()
        self.assertTrue(base.startswith('http://127.0.0.1:'))
        self.assertEqual(call(base + '/health'), (200, b'ok'))
        status, page = call(base + '/admin')
        self.assertEqual(status, 200)
        self.assertEqual(page, (build_aptv.PKG / 'web' / 'index.html').read_bytes())
        self.assertEqual(call(base + '/static/logo-huya.png')[1], (build_aptv.PKG / 'web' / 'logo-huya.png').read_bytes())
        m3u = re.search(r'订阅地址: (\S+)', out).group(1)
        self.assertEqual(call(m3u)[1].splitlines()[0], b'#EXTM3U')
        # Saving config goes through the same CSRF check as the server build.
        csrf = json.loads(call(base + '/api/session')[1])['csrf']
        status, _ = call(base + '/api/config', json.dumps({'douyin': {'count': 3}}).encode(),
                         {'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Origin': base})
        self.assertEqual(status, 200)
        data = self.dir / 'live-direct-data'
        self.assertEqual(json.loads((data / 'config.json').read_text())['douyin']['count'], 3)
        self.assertEqual((data / 'standalone-secrets.json').stat().st_mode & 0o777, 0o600)

    def test_tokens_persist_across_restarts(self):
        first = re.search(r'订阅地址: http://[^/]+(\S+)', self.start()[1]).group(1)
        second = re.search(r'订阅地址: http://[^/]+(\S+)', self.start()[1]).group(1)
        self.assertEqual(first, second)

    def test_non_loopback_bind_requires_login(self):
        base, out = self.start('--bind', '0.0.0.0', '--public-base', 'http://192.0.2.1:1907')
        self.assertEqual(base, 'http://192.0.2.1:1907')
        self.assertIn('需管理员令牌', out)
        port = re.search(r'监听 [^:]+:(\d+)', out).group(1)
        self.assertEqual(call('http://127.0.0.1:' + port + '/admin')[0], 303)
        self.assertEqual(call('http://127.0.0.1:' + port + '/api/session')[0], 401)


if __name__ == '__main__':
    unittest.main()
