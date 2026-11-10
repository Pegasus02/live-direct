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
    def test_export_aptv_script_carries_current_settings(self):
        import ast, json
        s, h, _ = self.req('POST', '/login', urlencode({'admin_token': 'a'*32}), {'Content-Type': 'application/x-www-form-urlencoded'})
        cookie = h['Set-Cookie'].split(';')[0]
        csrf = json.loads(self.req('GET', '/api/session', headers={'Cookie': cookie})[2])['csrf']
        self.store.update({'douyu': {'enabled': True, 'rooms': ['9999']}, 'bilibili': {'sessdata': 'secretvalue'}})
        self.assertEqual(self.req('POST', '/api/export/aptv', '{}', {'Cookie': cookie})[0], 403)
        self.assertEqual(self.req('POST', '/api/export/aptv', '{}', {'X-CSRF-Token': csrf})[0], 401)
        s, h, body = self.req('POST', '/api/export/aptv', '{}', {'Cookie': cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json'})
        self.assertEqual(s, 200)
        self.assertRegex(h['Content-Disposition'], r'^attachment; filename="live-direct-aptv-[0-9-]+\.py"$')
        tree = ast.parse(body.decode())
        config = next(ast.literal_eval(n.value) for n in tree.body
                      if isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '') == '_CONFIG')
        self.assertEqual(config, self.store.get())
        self.assertEqual(config['bilibili']['sessdata'], 'secretvalue')
    def test_client_disconnect_is_not_logged_as_error(self):
        from unittest import mock
        from live_direct import app as app_module
        lines = []
        self.server.app.engine.log = lines.append
        for error in (BrokenPipeError, ConnectionResetError, KeyError):
            with mock.patch.object(app_module.Handler, 'serve', side_effect=error):
                with self.assertRaises((http.client.RemoteDisconnected, ConnectionError)):
                    self.req('GET', '/health')
        self.assertEqual(lines, ['[请求] 处理出错 (KeyError)'])
    def test_auth_session_csrf_and_assets(self):
        self.assertEqual(self.req('GET', '/api/config')[0], 401)
        self.assertEqual(self.req('GET', '/login')[0], 200)
        self.assertEqual(self.req('GET', '/static/style.css')[0], 200)
        for path, typ in (('/static/icon.svg', 'image/svg+xml'), ('/static/icon-180.png', 'image/png'), ('/static/logo-douyu.png', 'image/png'), ('/static/logo-huya.png', 'image/png'), ('/favicon.ico', 'image/svg+xml')):
            s, h, b = self.req('GET', path)
            self.assertEqual((s, h['Content-Type']), (200, typ)); self.assertTrue(b)
        self.assertEqual(self.req('GET', '/api/meta')[0], 401)
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
        self.server.app.engine.providers = {'douyu': object(), 'bilibili': object()}
        s,h,b=self.req('GET','/api/meta',headers={'Cookie':cookie})
        meta=json.loads(b)['platforms']
        self.assertEqual([p['id'] for p in meta], ['douyu', 'bilibili'])
        self.assertIn({'id': '1_2', 'name': '娱乐'}, meta[0]['categories'])
        self.assertIn({'id': '2', 'name': '网游'}, meta[1]['categories'])
        self.assertEqual(self.req('POST','/api/logout','{}',{'Cookie':cookie})[0],403)
        s,h,b=self.req('POST','/api/logout','{}',{'Cookie':cookie,'X-CSRF-Token':csrf})
        self.assertEqual(s,204);self.assertIn('Max-Age=0',h['Set-Cookie'])
        self.assertEqual(self.req('GET','/api/config',headers={'Cookie':cookie})[0],401)
    def test_live_and_hls_redirects(self):
        from live_direct.models import Channel, Stream
        class Flv:
            def discover(self, config): return [Channel('douyu', '1', 'x')]
            def resolve(self, room, config): return Stream('https://hw-tct.douyucdn.cn/live/a.flv', 'flv')
        class Both:
            hls = True
            def discover(self, config): return [Channel('huya', '2', 'y')]
            def resolve(self, room, config, formats=('flv', 'hls')):
                return Stream('https://al.hls.huya.com/src/a.m3u8', 'hls') if formats == ('hls',) else Stream('https://al.flv.huya.com/src/a.flv', 'flv')
        self.store.update({'douyu': {'enabled': True}, 'huya': {'enabled': True}})
        engine = self.server.app.engine
        engine.providers = {'douyu': Flv(), 'huya': Both()}
        engine.refresh()
        base = '/s/' + 'b'*32
        s, h, _ = self.req('GET', base + '/live/huya/2')
        self.assertEqual((s, h['Location']), (302, 'https://al.flv.huya.com/src/a.flv'))
        s, h, _ = self.req('GET', base + '/hls/huya/2')
        self.assertEqual((s, h['Location']), (302, 'https://al.hls.huya.com/src/a.m3u8'))
        self.assertEqual(self.req('GET', base + '/live/douyu/1')[0], 302)
        self.assertEqual(self.req('GET', base + '/hls/douyu/1')[0], 404)
        self.assertEqual(self.req('GET', '/s/' + 'c'*32 + '/hls/huya/2')[0], 404)
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
    def test_explicit_auth_disabled_still_requires_csrf(self):
        import json
        self.server.app.auth_enabled = False
        self.assertEqual(self.req('GET','/admin')[0],200)
        self.assertEqual(self.req('GET','/login')[0],303)
        self.assertEqual(self.req('GET','/api/config')[0],200)
        s,h,b=self.req('GET','/api/session')
        data=json.loads(b);self.assertFalse(data['auth_enabled'])
        self.assertEqual(self.req('POST','/api/config','{}')[0],403)
        hdr={'X-CSRF-Token':data['csrf'],'Content-Type':'application/json'}
        self.assertEqual(self.req('POST','/api/config','{}',hdr)[0],200)
        self.assertEqual(self.req('POST','/api/config','{}',dict(hdr,Origin='http://evil.example'))[0],403)
        self.assertEqual(self.req('GET','/s/wrong/interface.m3u')[0],404)
    def test_platform_pages_share_auth_and_reject_unknown(self):
        import json
        for path in ['/admin/douyin','/admin/bilibili','/admin/douyu','/admin/huya']:
            self.assertEqual(self.req('GET',path)[0],303)
        self.server.app.auth_enabled = False
        s,h,b = self.req('GET', '/static/qrcode.min.js')
        self.assertEqual(s, 200)
        self.assertTrue(len(b) > 1000)

        # Mock bilibili provider qr methods
        class QRProvider:
            def qrcode_generate(self):
                return {'url': 'https://passport.bilibili.com/qr', 'qrcode_key': 'key_abc'}
            def qrcode_poll(self, key):
                return {'status': 'success', 'sessdata': 'auto_saved_sess', 'message': 'OK'}

        self.server.app.engine.providers['bilibili'] = QRProvider()
        s,h,b = self.req('GET','/api/session')
        csrf = json.loads(b)['csrf']
        hdr = {'X-CSRF-Token': csrf, 'Content-Type': 'application/json'}

        s,h,b = self.req('POST', '/api/bilibili/qrcode/generate', '{}', hdr)
        self.assertEqual(s, 200)
        self.assertEqual(json.loads(b)['qrcode_key'], 'key_abc')

        s,h,b = self.req('POST', '/api/bilibili/qrcode/poll', json.dumps({'qrcode_key': 'key_abc'}), hdr)
        self.assertEqual(s, 200)
        resp_data = json.loads(b)
        self.assertEqual(resp_data['status'], 'success')
        self.assertNotIn('sessdata', resp_data)  # SESSDATA must be stripped from response!
        # Confirm store updated
        self.assertEqual(self.store.get()['bilibili']['sessdata'], 'auto_saved_sess')

        for path in ['/admin','/admin/douyin','/admin/bilibili','/admin/douyu','/admin/huya']:
            s,h,b=self.req('GET',path)
            self.assertEqual(s,200);self.assertIn(b'<!doctype html>',b)
        self.assertEqual(self.req('GET','/admin/unknown')[0],404)
    def test_fixed_subscription_opt_in_rejects_legacy_routes(self):
        from unittest.mock import patch
        from live_direct.models import Channel, Stream
        engine = self.server.app.engine
        self.assertEqual(self.req('GET', '/interface.m3u')[0], 404)
        self.assertEqual(self.req('GET', '/live/douyin/123')[0], 404)
        self.server.app.fixed_subscription = True
        engine.channels = {('douyin', '123'): Channel('douyin', '123', 'Sample', '', '')}
        with patch.object(engine, 'maybe_refresh'):
            s,h,b = self.req('GET', '/interface.m3u')
            self.assertEqual(s, 200)
            self.assertIn(b'http://localhost/live/douyin/123', b)
            self.assertNotIn(b'/s/', b)
            self.assertEqual(self.req('HEAD', '/interface.m3u')[2], b'')
            self.assertEqual(self.req('POST', '/interface.m3u', '')[0], 405)
            legacy = self.req('GET', '/s/'+'b'*32+'/interface.m3u')
            self.assertEqual(legacy[0], 404)
            for suffix in ['live/douyin/123', 'diagnostics/douyu.m3u', 'probe/douyu/123/hw-h5']:
                self.assertEqual(self.req('GET', '/s/'+'b'*32+'/'+suffix)[0], 404)
            self.assertEqual(self.req('HEAD', '/s/'+'b'*32+'/interface.m3u')[0], 404)
            with patch.object(engine, 'resolve', return_value=Stream('https://example.com/live.flv', 'flv', '', {})):
                self.assertEqual(self.req('GET', '/live/douyin/123')[0], 302)
                self.assertEqual(self.req('POST', '/live/douyin/123', '')[0], 405)
            with patch.object(engine, 'resolve', side_effect=LookupError):
                self.assertEqual(self.req('GET', '/live/unknown/123')[0], 404)
        self.assertEqual(self.req('GET', '/api/config')[0], 401)
        self.assertEqual(self.req('GET', '/admin')[0], 303)
        self.assertEqual(self.req('GET', '/s/wrong/interface.m3u')[0], 404)
        for path in ['/live/douyin/123/extra', '/live/douyin/abc', '/interface.m3u?x=1']:
            self.assertEqual(self.req('GET', path)[0], 404)

    def test_subscription_auth_and_headers(self):
        self.assertEqual(self.req('GET','/s/wrong/interface.m3u')[0],404)
        s,h,b=self.req('HEAD','/s/'+'b'*32+'/interface.m3u')
        self.assertEqual(s,200);self.assertEqual(b,b'');self.assertEqual(h['Cache-Control'],'no-store')
        self.assertEqual(self.req('POST','/s/'+'b'*32+'/interface.m3u','')[0],405)

if __name__=='__main__':unittest.main()
