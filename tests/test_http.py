import http.client
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import urlencode
from live_direct.app import Application, Engine, Server
from live_direct.config import ConfigStore


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = ConfigStore(Path(self.tmp.name).resolve() / 'config.json')
        app = Application(self.store, 'a'*32, 'b'*32, 'http://localhost', Engine(self.store, {}))
        self.server = Server(('127.0.0.1', 0), app)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.tmp.cleanup()
    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        c.request(method, path, body, headers or {})
        r = c.getresponse(); out = (r.status, dict(r.getheaders()), r.read()); c.close()
        return out
    def test_auth_session_csrf_and_assets(self):
        self.assertEqual(self.req('GET', '/api/config')[0], 401)
        self.assertEqual(self.req('GET', '/login')[0], 200)
        self.assertEqual(self.req('GET', '/static/style.css')[0], 200)
        s, h, _ = self.req('POST', '/login', urlencode({'admin_token': 'a'*32}), {'Content-Type':'application/x-www-form-urlencoded'})
        self.assertEqual(s,303); self.assertIn('HttpOnly',h['Set-Cookie'])
        cookie=h['Set-Cookie'].split(';')[0]
        s,h,b=self.req('GET','/api/session',headers={'Cookie':cookie})
        import json
        csrf=json.loads(b)['csrf']
        self.assertEqual(self.req('POST','/api/config','{}',{'Cookie':cookie})[0],403)
        self.assertEqual(self.req('POST','/api/config','{}',{'Cookie':cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'})[0],200)
        self.assertEqual(self.req('POST','/api/config','{}',{'Cookie':cookie,'X-CSRF-Token':csrf,'Origin':'http://evil.example'})[0],403)
        self.assertEqual(self.req('GET','/api/subscription',headers={'Cookie':cookie})[0],200)
        self.assertEqual(self.req('POST','/api/logout','{}',{'Cookie':cookie})[0],403)
        s,h,b=self.req('POST','/api/logout','{}',{'Cookie':cookie,'X-CSRF-Token':csrf})
        self.assertEqual(s,204);self.assertIn('Max-Age=0',h['Set-Cookie'])
        self.assertEqual(self.req('GET','/api/config',headers={'Cookie':cookie})[0],401)
    def test_cold_subscription_retryable_not_empty_success(self):
        entered, release = threading.Event(), threading.Event()
        class Slow:
            warnings = []
            def discover(self, config):
                entered.set(); release.wait(3); return []
        self.store.update({'douyin': {'enabled': True}})
        self.server.app.engine.providers = {'douyin': Slow()}
        try:
            s,h,b=self.req('GET','/s/'+'b'*32+'/interface.m3u')
            self.assertEqual(s,503);self.assertEqual(h['Retry-After'],'5')
            self.assertTrue(entered.wait(1))
        finally:
            worker = self.server.app.engine._refresh_thread
            release.set()
            if worker: worker.join(3)
        self.assertEqual(self.req('GET','/s/'+'b'*32+'/interface.m3u')[0],200)
    def test_subscription_auth_and_headers(self):
        self.assertEqual(self.req('GET','/s/wrong/interface.m3u')[0],404)
        s,h,b=self.req('HEAD','/s/'+'b'*32+'/interface.m3u')
        self.assertEqual(s,200);self.assertEqual(b,b'');self.assertEqual(h['Cache-Control'],'no-store')
        self.assertEqual(self.req('POST','/s/'+'b'*32+'/interface.m3u','')[0],405)

if __name__=='__main__':unittest.main()
