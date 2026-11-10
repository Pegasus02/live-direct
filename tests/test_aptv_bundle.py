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

    def start(self, *args, extra_env=None):
        env = {k: v for k, v in os.environ.items() if k not in ('PORT', 'BIND_IP', 'PUBLIC_BASE', 'DATA_DIR', 'PYTHONPATH')
               and not k.startswith(('DOUYIN_', 'BILIBILI_', 'DOUYU_', 'HUYA_'))}
        env.update(extra_env or {})
        # -I: no repo on sys.path, so every import must come from the bundle.
        proc = subprocess.Popen([sys.executable, '-I', '-B', str(self.script), '0', *args], cwd=self.dir,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
        self.procs.append(proc)
        lines = []
        while len(lines) < 40:
            line = proc.stdout.readline()
            if not line:
                break
            lines.append(line)
            if '=====' in line and any('监听' in x for x in lines):
                break
        out = ''.join(lines)
        port = re.search(r'监听 [^:]+:(\d+)', out)
        self.assertIsNotNone(port, out)
        return 'http://127.0.0.1:' + port.group(1), out

    def read_until(self, proc, text):
        lines = []
        while len(lines) < 40:
            line = proc.stdout.readline()
            if not line:
                break
            lines.append(line)
            if text in line:
                break
        return ''.join(lines)

    def test_local_mode_needs_no_token(self):
        base, out = self.start()
        self.assertIn(f'订阅地址: {base}/interface.m3u', out)
        self.assertNotIn('/s/', out)
        self.assertEqual(call(base + '/health'), (200, b'ok'))
        status, page = call(base + '/admin')
        self.assertEqual(status, 200)
        self.assertEqual(page, (build_aptv.PKG / 'web' / 'index.html').read_bytes())
        self.assertEqual(call(base + '/static/logo-huya.png')[1], (build_aptv.PKG / 'web' / 'logo-huya.png').read_bytes())
        m3u = call(base + '/interface.m3u')[1].decode().splitlines()
        self.assertEqual(m3u[:3], ['#EXTM3U', '#EXT-X-APTV-PREVIEW: FALSE', '#EXT-X-APTV-LATENCY: FALSE'])
        self.assertEqual(json.loads(call(base + '/api/subscription')[1])['url'], base + '/interface.m3u')
        # Unknown rooms are a plain 404 on the token-free route, not a 5xx.
        self.assertEqual(call(base + '/live/douyin/123')[0], 404)
        csrf = json.loads(call(base + '/api/session')[1])['csrf']
        status, _ = call(base + '/api/config', json.dumps({'douyin': {'count': 3}}).encode(),
                         {'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Origin': base})
        self.assertEqual(status, 200)
        self.assertIn('[配置] 已保存 抖音: 已关闭，0 个主播，0 个分类', self.read_until(self.procs[-1], '已保存'))
        data = self.dir / 'live-direct-data'
        self.assertEqual(json.loads((data / 'config.json').read_text())['douyin']['count'], 3)
        self.assertFalse((data / 'standalone-secrets.json').exists())

    def test_bundle_imports_only_standard_modules(self):
        import ast
        tree = ast.parse(self.script.read_text(encoding='utf-8'))
        names = {alias.name.split('.')[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
        names |= {node.module.split('.')[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}
        self.assertTrue(names <= set(sys.stdlib_module_names), names - set(sys.stdlib_module_names))

    def test_localhost_name_works_and_other_hosts_are_refused(self):
        base, _ = self.start()
        port = base.rsplit(':', 1)[1]
        alias = 'http://localhost:' + port
        # URLs follow the Host the client used, so either name works end to end.
        self.assertEqual(json.loads(call(base + '/api/subscription', headers={'Host': 'localhost:' + port})[1])['url'], alias + '/interface.m3u')
        csrf = json.loads(call(base + '/api/session')[1])['csrf']
        post = {'Content-Type': 'application/json', 'X-CSRF-Token': csrf}
        body = json.dumps({'douyin': {'count': 2}}).encode()
        self.assertEqual(call(base + '/api/config', body, dict(post, Host='localhost:' + port, Origin=alias))[0], 200)
        # DNS rebinding: a web page reaching us under its own name gets nothing.
        for host in ('evil.example:' + port, '192.168.1.5:' + port, 'localhost:1'):
            self.assertEqual(call(base + '/admin', headers={'Host': host})[0], 403, host)
            self.assertEqual(call(base + '/interface.m3u', headers={'Host': host})[0], 403, host)
        self.assertEqual(call(base + '/api/config', body, dict(post, Origin='http://evil.example'))[0], 403)

    def test_environment_is_the_configuration(self):
        base, out = self.start(extra_env={'DOUYU_ROOMS': '9999, 288016', 'HUYA_CATEGORIES': '网游', 'HUYA_COUNT': '5'})
        self.assertIn('配置来源: 环境变量', out)
        self.assertIn('[配置] 环境变量 斗鱼: 已启用，2 个主播，0 个分类', out)
        self.assertIn('[配置] 环境变量 抖音: 已关闭', out)
        self.assertIn('已启用平台: 斗鱼、虎牙', out)
        saved = json.loads((self.dir / 'live-direct-data' / 'config.json').read_text())
        self.assertEqual(saved['huya']['categories'], ['100023'])
        self.assertEqual(saved['huya']['count'], 5)

    def test_built_in_settings_apply_and_environment_wins(self):
        from live_direct.config import DEFAULTS
        import copy
        config = copy.deepcopy(DEFAULTS)
        config['huya'].update(enabled=True, rooms=['kpl'], count=3)
        self.script = build_aptv.build(self.dir / 'configured.py', config)
        base, out = self.start()
        self.assertIn('配置来源: 内置配置', out)
        self.assertIn('[配置] 内置配置 虎牙: 已启用，1 个主播，0 个分类', out)
        self.assertIn('已启用平台: 虎牙', out)
        # A copy running inside APTV cannot export itself again.
        csrf = json.loads(call(base + '/api/session')[1])['csrf']
        self.assertEqual(call(base + '/api/export/aptv', b'{}', {'X-CSRF-Token': csrf, 'Origin': base})[0], 404)
        self.tearDown(); self.setUp()
        self.script = build_aptv.build(self.dir / 'configured.py', config)
        _, out = self.start(extra_env={'DOUYU_ROOMS': '9999'})
        self.assertIn('配置来源: 环境变量', out)
        self.assertIn('已启用平台: 斗鱼', out)

    def test_bad_environment_value_stops_with_its_name(self):
        env = {k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}
        env['DOUYU_COUNT'] = 'many'
        proc = subprocess.run([sys.executable, '-I', '-B', str(self.script), '0'], cwd=self.dir, env=env,
                              capture_output=True, text=True, timeout=20)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('设置有误: DOUYU_COUNT: 格式不对', proc.stdout + proc.stderr)

    def test_corrupt_config_is_set_aside(self):
        data = self.dir / 'live-direct-data'
        data.mkdir()
        (data / 'config.json').write_text('{not json')
        base, out = self.start()
        self.assertIn('使用默认配置', out)
        self.assertEqual(call(base + '/admin')[0], 200)
        self.assertEqual(len(list(data.glob('config.broken-*.json'))), 1)

    def test_non_loopback_bind_keeps_tokens_and_login(self):
        base, out = self.start('--bind', '0.0.0.0', '--public-base', 'http://192.0.2.1:1907')
        self.assertIn('管理员令牌见', out)
        self.assertRegex(out, r'订阅地址: http://192\.0\.2\.1:1907/s/[A-Za-z0-9_-]{24,}/interface\.m3u')
        self.assertEqual(call(base + '/admin')[0], 303)
        self.assertEqual(call(base + '/api/session')[0], 401)
        self.assertEqual(call(base + '/interface.m3u')[0], 404)


if __name__ == '__main__':
    unittest.main()
