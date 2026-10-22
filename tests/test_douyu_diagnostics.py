"""Independent fixture-only checks for the opt-in diagnostic playlist."""
import copy
import http.client
import tempfile
import threading
import time
import unittest
from pathlib import Path

from live_direct.app import Application, Engine, Server
from live_direct.config import ConfigStore
from live_direct.models import Channel, ProviderError, Stream
from live_direct.providers.douyu import Douyu, ORIGIN, PLAY_API


KEY = {'error': 0, 'data': {'rand_str': 'r', 'key': 'k', 'enc_time': 1, 'enc_data': 'e'}}


def play(lines=('hw-h5', 'hs-h5'), base='https://hw-tct.douyucdn.cn/live', cdn='hw-h5'):
    return {'error': 0, 'data': {'rtmp_cdn': cdn, 'cdnsWithName': [{'cdn': c} for c in lines],
                               'rtmp_url': base, 'rtmp_live': 'fixture.flv?sign=fixture'}}


class Client:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def fetch_json(self, url, headers=None, form=None):
        self.calls.append((url, copy.deepcopy(form)))
        return copy.deepcopy(self.responses.pop(0))


class DiagnosticProviderTests(unittest.TestCase):
    def test_fresh_advertisement_precedes_each_selected_line(self):
        for cdn in ('hw-h5', 'hs-h5'):
            with self.subTest(cdn=cdn):
                client = Client([KEY, play(), play(cdn=cdn)])
                stream = Douyu(client).resolve_cdn('123', {'quality': 0}, cdn)
                self.assertEqual(stream.format, 'flv')
                self.assertEqual(len(client.calls), 3)
                self.assertTrue(client.calls[0][0].startswith(ORIGIN + '/wgapi/'))
                self.assertEqual(client.calls[1][0], PLAY_API + '/lapi/live/getH5PlayV1/123')
                self.assertEqual(client.calls[1][0], client.calls[2][0])
                self.assertNotIn('cdn', client.calls[1][1])
                self.assertEqual(client.calls[2][1]['cdn'], cdn)
                self.assertEqual(client.calls[2][1]['rate'], '0')
                self.assertEqual(client.calls[1][1]['auth'], client.calls[2][1]['auth'])

    def test_unlisted_or_malformed_advertisement_never_requests_line(self):
        for response in (play(('other',)), {'error': 0, 'data': {}},
                         {'error': 0, 'data': {'cdnsWithName': 'hw-h5'}},
                         {'error': 0, 'data': {'cdnsWithName': [None, 'hw-h5', {'cdn': 'hw-h5.evil'}]}},
                         {'error': 1}, {'error': 0, 'data': None}):
            client = Client([KEY, response])
            with self.assertRaises(ProviderError):
                Douyu(client).resolve_cdn('123', {}, 'hw-h5')
            self.assertEqual(len(client.calls), 2)

    def test_advertisement_is_not_reused_for_next_probe(self):
        client = Client([KEY, play(), play(), KEY, play(('hs-h5',))])
        provider = Douyu(client)
        provider.resolve_cdn('123', {}, 'hw-h5')
        with self.assertRaises(ProviderError):
            provider.resolve_cdn('123', {}, 'hw-h5')
        self.assertEqual(len(client.calls), 5)

    def test_selected_line_mismatch_or_missing_never_mislabeled(self):
        for requested in ('hw-h5', 'hs-h5'):
            for returned in ('other', None, '', 'hs-h5' if requested == 'hw-h5' else 'hw-h5'):
                with self.subTest(requested=requested, returned=returned):
                    client = Client([KEY, play(), play(cdn=returned)])
                    with self.assertRaisesRegex(ProviderError, 'line not selected'):
                        Douyu(client).resolve_cdn('123', {}, requested)
                    self.assertEqual(len(client.calls), 3)

    def test_reject_inputs_before_network(self):
        client = Client([])
        for cdn in ('arbitrary', 'https://example.test', 'hw-h5/other', ''):
            with self.assertRaises(ProviderError):
                Douyu(client).resolve_cdn('123', {}, cdn)
        for room in ('../123', '0', '123/other', 'https://evil.example/123'):
            with self.assertRaises(ProviderError):
                Douyu(client).resolve_cdn(room, {}, 'hw-h5')
        self.assertEqual(client.calls, [])

    def test_upstream_failure_and_untrusted_media_are_rejected(self):
        for responses in ([{'error': 1}], [KEY, play(), {'error': 1}],
                          [KEY, play(), play(base='https://evil.example/live')],
                          [KEY, play(), {'error': 0, 'data': {}}]):
            with self.assertRaises(ProviderError):
                Douyu(Client(responses)).resolve_cdn('123', {}, 'hw-h5')


class Provider:
    def __init__(self):
        self.calls = []
        self.stream = Stream('https://hw-tct.douyucdn.cn/live/fixture.flv', 'flv')
        self.hook = None

    def resolve_cdn(self, room, config, cdn):
        self.calls.append((room, cdn))
        if self.hook:
            self.hook()
        return self.stream

    def resolve(self, room, config):
        self.calls.append((room, 'baseline'))
        return self.stream


class DiagnosticHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = ConfigStore(Path(self.tmp.name).resolve() / 'config.json')
        self.store.update({'douyu': {'enabled': True}})
        self.provider = Provider()
        self.engine = Engine(self.store, {'douyu': self.provider})
        self.engine.channels = {('douyin', '7'): Channel('douyin', '7', 'Other'),
                                ('douyu', '123'): Channel('douyu', '123', 'First\nname'),
                                ('douyu', '456'): Channel('douyu', '456', 'Second')}
        self.engine.updated = time.monotonic()
        self.prefix = '/s/' + 'b' * 32
        self.server = Server(('127.0.0.1', 0), Application(
            self.store, 'a' * 32, 'b' * 32, 'http://localhost', self.engine))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.config_before = self.store.path.read_bytes()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def req(self, path, method='GET'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        connection.request(method, path)
        response = connection.getresponse()
        out = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return out

    def test_playlist_first_room_fixed_entries_and_production_unchanged(self):
        before = self.engine.playlist('http://localhost', 'b' * 32)
        status, headers, body = self.req(self.prefix + '/diagnostics/douyu.m3u')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'audio/x-mpegurl; charset=utf-8')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        text = body.decode()
        urls = [line for line in text.splitlines() if not line.startswith('#')]
        self.assertEqual(urls, ['http://localhost' + self.prefix + route for route in (
            '/live/douyu/123', '/probe/douyu/123/hw-h5', '/probe/douyu/123/hs-h5')])
        self.assertEqual(text.count('#EXTINF:'), 3)
        self.assertNotIn('Second', text)
        self.assertNotIn('First\nname', text)
        self.assertNotIn('douyucdn', text)
        self.assertEqual(self.provider.calls, [])
        self.assertEqual(before, self.engine.playlist('http://localhost', 'b' * 32))
        self.assertEqual(self.config_before, self.store.path.read_bytes())

    def test_get_head_and_baseline(self):
        for method in ('GET', 'HEAD'):
            status, headers, body = self.req(self.prefix + '/diagnostics/douyu.m3u', method)
            self.assertEqual(status, 200)
            if method == 'HEAD':
                self.assertEqual(body, b'')
                self.assertGreater(int(headers['Content-Length']), 0)
            for cdn in ('hw-h5', 'hs-h5'):
                status, headers, body = self.req(self.prefix + '/probe/douyu/123/' + cdn, method)
                self.assertEqual(status, 302)
                self.assertEqual(headers['Location'], self.provider.stream.url)
                self.assertEqual(body, b'')
        self.assertEqual(self.req(self.prefix + '/live/douyu/123')[0], 302)
        self.assertEqual(self.provider.calls[-1], ('123', 'baseline'))
        self.assertEqual(self.config_before, self.store.path.read_bytes())
        # Diagnostic results never populate or reuse the normal resolver cache.
        self.assertEqual(len([call for call in self.provider.calls if call[1] != 'baseline']), 4)

    def test_auth_methods_malformed_unknown_rooms_and_cdn(self):
        for route in ('/diagnostics/douyu.m3u', '/probe/douyu/123/hw-h5'):
            self.assertEqual(self.req('/s/wrong' + route)[0], 404)
            for method in ('POST', 'PUT', 'DELETE', 'OPTIONS'):
                self.assertEqual(self.req(self.prefix + route, method)[0], 405)
        for route in ('/probe/douyu/999/hw-h5', '/probe/douyu/0/hw-h5',
                      '/probe/douyu/0123/hw-h5', '/probe/douyu/123/other',
                      '/probe/douyu/123/https://evil.example', '/probe/huya/123/hw-h5',
                      '/probe/douyu/123/hw-h5/', '/probe/douyu/123/hw-h5?cdn=other',
                      '/probe/douyu/%31%32%33/hw-h5', '/probe/douyu/123',
                      '/diagnostics/douyu.m3u/extra'):
            with self.subTest(route=route):
                self.assertEqual(self.req(self.prefix + route)[0], 404)
        self.assertEqual(self.provider.calls, [])

    def test_disabled_missing_provider_and_removed_channel(self):
        for setup in ('disabled', 'missing_provider', 'missing_room'):
            with self.subTest(setup=setup):
                self.store.update({'douyu': {'enabled': setup != 'disabled'}})
                self.engine.providers = {} if setup == 'missing_provider' else {'douyu': self.provider}
                if setup == 'missing_room':
                    self.engine.channels = {}
                for route in ('/diagnostics/douyu.m3u', '/probe/douyu/123/hw-h5'):
                    self.assertEqual(self.req(self.prefix + route)[0], 404)
        self.assertEqual(self.provider.calls, [])

    def test_inflight_revocation_and_stream_safety(self):
        self.provider.hook = self.engine.invalidate
        self.assertEqual(self.req(self.prefix + '/probe/douyu/123/hw-h5')[0], 404)
        self.provider.hook = None
        self.engine.channels = {('douyu', '123'): Channel('douyu', '123', 'Test')}
        for stream in (Stream('https://evil.example/a.flv', 'flv'),
                       Stream(self.provider.stream.url, 'flv', headers={'Cookie': 'secret'})):
            self.provider.stream = stream
            self.assertEqual(self.req(self.prefix + '/probe/douyu/123/hw-h5')[0], 503)
        self.assertEqual(self.engine.cache, {})

    def test_each_inflight_revocation_condition_rejects(self):
        for condition in ('generation', 'disabled', 'membership'):
            with self.subTest(condition=condition):
                self.store.update({'douyu': {'enabled': True}})
                self.engine.channels = {('douyu', '123'): Channel('douyu', '123', 'Test')}
                def revoke():
                    with self.engine.lock:
                        if condition == 'generation':
                            self.engine.generation += 1
                        elif condition == 'disabled':
                            self.store.update({'douyu': {'enabled': False}})
                        else:
                            self.engine.channels.clear()
                self.provider.hook = revoke
                self.assertEqual(self.req(self.prefix + '/probe/douyu/123/hw-h5')[0], 404)
        self.assertEqual(self.engine.cache, {})

    def test_upstream_unadvertised_line_is_unavailable(self):
        client = Client([KEY, play(('hs-h5',))])
        self.engine.providers = {'douyu': Douyu(client)}
        self.assertEqual(self.req(self.prefix + '/probe/douyu/123/hw-h5')[0], 503)
        self.assertEqual(len(client.calls), 2)

    def test_busy_is_bounded_and_slot_released_after_failure(self):
        for _ in range(6):
            self.assertTrue(self.engine.resolve_slots.acquire(False))
        self.assertEqual(self.req(self.prefix + '/probe/douyu/123/hw-h5')[0], 503)
        self.assertEqual(self.provider.calls, [])
        for _ in range(6):
            self.engine.resolve_slots.release()
        self.provider.stream = Stream('https://evil.example/a.flv', 'flv')
        self.assertEqual(self.req(self.prefix + '/probe/douyu/123/hw-h5')[0], 503)
        for _ in range(6):
            self.assertTrue(self.engine.resolve_slots.acquire(False))
        for _ in range(6):
            self.engine.resolve_slots.release()


if __name__ == '__main__':
    unittest.main()
