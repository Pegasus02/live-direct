import unittest
import tempfile
from pathlib import Path
from live_direct.app import Application, Engine, safe_media, clean_text
from live_direct.config import ConfigStore
from live_direct.models import Channel, Stream


class Provider:
    def __init__(self):
        self.calls = 0
        self.fail = False
        self.cookie = False
    def discover(self, config):
        if self.fail:
            raise RuntimeError('private')
        return [Channel('douyin', '123', 'Name\nInjected', 'Title')]
    def resolve(self, room, config):
        self.calls += 1
        return Stream('https://pull.douyincdn.com/live.flv', 'flv', headers={'Cookie': 'private'} if self.cookie else {})


class AppTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = ConfigStore(Path(self.tmp.name).resolve() / 'config.json')
        self.store.update({'douyin': {'enabled': True, 'rooms': ['123']}})
        self.provider = Provider()
        self.engine = Engine(self.store, {'douyin': self.provider})
        self.engine.refresh()
    def tearDown(self):
        self.tmp.cleanup()
    def test_playlist_sanitize(self):
        out = self.engine.playlist('http://localhost:1907', 'a'*32).decode()
        self.assertEqual(out.count('#EXTINF:'), 1)
        self.assertNotIn('Name\nInjected', out)
        self.assertIn('/live/douyin/123', out)
    def test_allowlist_and_cache(self):
        self.engine.resolve('douyin', '123')
        self.engine.resolve('douyin', '123')
        self.assertEqual(self.provider.calls, 1)
        with self.assertRaises(LookupError):
            self.engine.resolve('douyin', '999')
    def test_cookie_bound_rejected_and_not_cached(self):
        self.provider.cookie = True
        with self.assertRaises(ValueError):
            self.engine.resolve('douyin', '123')
        with self.assertRaises(RuntimeError):
            self.engine.resolve('douyin', '123')
    def test_disabled_immediate_rejection(self):
        self.store.update({'douyin': {'enabled': False}})
        with self.assertRaises(LookupError):
            self.engine.resolve('douyin', '123')
    def test_refresh_error_honest_cached_status(self):
        self.provider.fail = True
        self.engine.refresh()
        self.assertEqual(self.engine.status()['platforms']['douyin']['status'], 'error')
        self.assertTrue(self.engine.channels)
    def test_media_allowlist(self):
        self.assertTrue(safe_media('https://a.bilivideo.com/live.flv?x=1'))
        for u in ['https://evil.example/live.flv', 'http://a.douyincdn.com/a.flv', 'https://a.douyincdn.com@evil.example/a', 'https://a.douyincdn.com:444/a']:
            self.assertFalse(safe_media(u))
    def test_inflight_resolution_revoked(self):
        import threading
        entered, release = threading.Event(), threading.Event()
        old = self.provider.resolve
        def blocked(room, config):
            entered.set(); release.wait(3)
            return old(room, config)
        self.provider.resolve = blocked
        errors = []
        def run():
            try: self.engine.resolve('douyin', '123')
            except RuntimeError: errors.append(True)
        t = threading.Thread(target=run); t.start()
        self.assertTrue(entered.wait(2))
        with self.engine.lock:
            self.store.update({'douyin': {'enabled': False}})
            self.engine.invalidate()
        release.set(); t.join(3)
        self.assertEqual(errors, [True]); self.assertFalse(self.engine.cache)
    def test_old_discovery_cannot_publish(self):
        import threading
        entered, release = threading.Event(), threading.Event()
        old = self.provider.discover
        def blocked(config):
            entered.set(); release.wait(3); return old(config)
        self.provider.discover = blocked
        t = threading.Thread(target=self.engine.refresh); t.start()
        self.assertTrue(entered.wait(2))
        self.engine.invalidate(); release.set(); t.join(3)
        self.assertFalse(self.engine.channels)
    def test_public_base_rejects_invalid_values(self):
        for base in ['http://localhost:bad', 'http://localhost:99999', 'http://local\\nhost']:
            with self.assertRaises(ValueError):
                Application(self.store, 'a'*32, 'b'*32, base)
    def test_sessions_and_token_isolation(self):
        app = Application(self.store, 'a'*32, 'b'*32, 'http://localhost:1907', self.engine)
        self.assertIsNone(app.login('wrong', 'client'))
        sid = app.login('a'*32, 'client')
        self.assertTrue(app.session('ld_session='+sid))
        self.assertIsNone(app.session('ld_session=wrong'))
        with self.assertRaises(ValueError):
            Application(self.store, 'a'*32, 'a'*32, 'http://localhost:1907')


if __name__ == '__main__':
    unittest.main()
