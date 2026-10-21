import json
import unittest
from unittest.mock import patch

from live_direct import net
from live_direct.models import ProviderError, RoomOfflineError
from live_direct.providers.douyin import Douyin, flight_data, normalize_room as dy_room, select_stream as dy_stream
from live_direct.providers.bilibili import Bilibili, normalize_room as bili_room, select_stream


def flight(value):
    return '<script>self.__pace_f.push(' + json.dumps([1, 'a:' + json.dumps(value)]) + ')</script>'


def dy_fixture(rid='123', status=2):
    room = {'id_str': 'canonical', 'status': status, 'title': 'Fixture title',
            'owner': {'nickname': 'Fixture anchor'}, 'room_view_stats': {'display_value': '50'},
            'stream_url': {'flv_pull_url': {'HD1': 'http://pull.douyincdn.com/live/test.flv?signature=fixture'}}}
    return {'room': room, 'web_rid': rid}


def play_fixture(flv=True, codec='avc'):
    return {'playurl_info': {'playurl': {'stream': [{
        'protocol_name': 'http_stream' if flv else 'http_hls', 'format': [{
            'format_name': 'flv' if flv else 'ts', 'codec': [{
                'codec_name': codec, 'current_qn': 150, 'accept_qn': [150, 10000],
                'base_url': '/live/fixture.' + ('flv' if flv else 'm3u8'),
                'url_info': [{'host': 'https://a.bilivideo.com', 'extra': '?signature=x%2Fy&ts=1'}]}]}]}]}}}


class Fake:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def _fetch(self, url, headers):
        self.calls.append((url, headers))
        for key, value in self.responses.items():
            if key in url:
                if isinstance(value, Exception):
                    raise value
                return value
        raise AssertionError('Unexpected fixture request')

    def fetch_json(self, url, headers=None):
        return self._fetch(url, headers)

    def fetch_text(self, url, headers=None):
        return self._fetch(url, headers)

    def fetch_json_with_headers(self, url, headers=None):
        val = self._fetch(url, headers)
        if isinstance(val, tuple):
            return val
        return [], val


class ProvidersTest(unittest.TestCase):
    def test_disabled_does_no_io(self):
        client = Fake({})
        self.assertEqual(Douyin(client).discover({}), [])
        self.assertEqual(Bilibili(client).discover({}), [])
        self.assertEqual(client.calls, [])

    def test_room_input_boundaries(self):
        self.assertEqual(dy_room('https://live.douyin.com/abc_1'), 'abc_1')
        self.assertEqual(bili_room('https://live.bilibili.com/h5/12'), '12')
        for bad in ['https://evil.test/12', 'https://live.bilibili.com.evil.test/12',
                    'https://user@live.bilibili.com/12', 'https://live.bilibili.com:444/12',
                    'https://b23.tv/example', '１２', '12?x', '0']:
            with self.subTest(bad=bad), self.assertRaises(ProviderError):
                bili_room(bad)
        with self.assertRaises(ProviderError):
            dy_room('https://live.douyin.com/12?url=evil')

    def test_douyin_manual_auto_and_threshold(self):
        manual = dy_fixture()
        auto = dy_fixture('456')
        auto['room']['id_str'] = 'other'
        roompage = flight([0, 0, 0, {'state': {'roomStore': {'roomInfo': manual}}}])
        catpage = flight([0, 0, 0, {'roomsData': {'data': [manual, auto]}}])
        client = Fake({'/123': roompage, '/categorynew/4_103': catpage})
        provider = Douyin(client)
        channels = provider.discover({'enabled': True, 'rooms': ['123'], 'categories': ['游戏'], 'count': 1})
        self.assertEqual([c.room_id for c in channels], ['123', '456'])
        stream = provider.resolve('123', {})
        self.assertEqual(stream.format, 'flv')
        self.assertTrue(stream.url.startswith('https://'))
        self.assertNotIn('signature', repr(stream))
        self.assertEqual(Douyin(client).discover({'enabled': True, 'categories': ['103'], 'min_viewers': 51}), [])

    def test_flight_never_executes(self):
        self.assertEqual(flight_data('<script>self.__pace_f.push(alert(1))</script>'), [])
        client = Fake({'/123': '<html>blocked</html>'})
        with self.assertRaises(ProviderError) as error:
            Douyin(client).resolve('123', {})
        self.assertNotIsInstance(error.exception, RoomOfflineError)

    def test_douyin_hls_fallback(self):
        stream = dy_stream({'flv_pull_url': {'HD1': 'https://evil.test/f.flv'},
                            'hls_pull_url_map': {'SD1': 'https://a.douyinliving.com/f.m3u8'}})
        self.assertEqual((stream.format, stream.quality), ('hls', 'SD1'))

    def test_bili_codec_preference_and_fallback(self):
        data = play_fixture(True, 'hevc')
        data['playurl_info']['playurl']['stream'] += play_fixture(False)['playurl_info']['playurl']['stream']
        self.assertEqual(select_stream(data).format, 'hls')
        self.assertEqual(select_stream(data, False).format, 'flv')
        data['playurl_info']['playurl']['stream'] += play_fixture()['playurl_info']['playurl']['stream']
        stream = select_stream(data)
        self.assertEqual(stream.format, 'flv')
        self.assertTrue(stream.url.endswith('?signature=x%2Fy&ts=1'))
        self.assertNotIn('Cookie', stream.headers)

    def test_bili_manual_canonical_area_and_cookie(self):
        client = Fake({'/get_info': {'code': 0, 'data': {'room_id': 123, 'live_status': 1, 'title': 'Fixture'}},
                       '/getList': {'code': 0, 'data': [{'id': 2, 'name': '网游'}]},
                       '/getRoomList': {'code': 0, 'data': [{'roomid': 456, 'online': 500}]},
                       '/getRoomPlayInfo': {'code': 0, 'data': play_fixture()}})
        provider = Bilibili(client)
        config = {'enabled': True, 'rooms': ['12'], 'areas': ['网游'], 'sessdata': 'fixture%2Fsession'}
        channels = provider.discover(config)
        self.assertEqual([c.room_id for c in channels], ['123'])
        self.assertEqual(provider.resolve('12', config).quality, '150')
        self.assertTrue(all(url.startswith('https://api.live.bilibili.com/') for url, _ in client.calls))
        self.assertTrue(all(h.get('Cookie') == 'SESSDATA=fixture%2Fsession' for _, h in client.calls))
        self.assertEqual(provider.session_status(config), {'configured': True, 'validated': False})

    def test_bili_failure_is_not_offline_and_messages_redacted(self):
        client = Fake({'/get_info': {'code': -352, 'message': 'https://secret.example/?cookie=secret'}})
        with self.assertRaises(ProviderError) as e:
            Bilibili(client).resolve('123', {})
        self.assertNotIn('secret', str(e.exception))
        with self.assertRaises(ProviderError):
            Bilibili(client).resolve('123', {'sessdata': 'bad; second=cookie'})

    def test_bili_qrcode_generate_and_poll(self):
        client = Fake({
            '/web/qrcode/generate': {'code': 0, 'data': {'url': 'https://passport.bilibili.com/scan?key=abc', 'qrcode_key': 'key_12345678'}},
            '/web/qrcode/poll': ([('Set-Cookie', 'SESSDATA=secret_sessdata%2F123; Path=/')],
                                 {'code': 0, 'data': {'code': 0, 'message': '0'}})
        })
        provider = Bilibili(client)
        gen = provider.qrcode_generate()
        self.assertEqual(gen['qrcode_key'], 'key_12345678')
        poll = provider.qrcode_poll('key_12345678')
        self.assertEqual(poll['status'], 'success')
        self.assertEqual(poll['sessdata'], 'secret_sessdata%2F123')

        # Test fallback to data.url if Set-Cookie header missing
        client2 = Fake({
            '/web/qrcode/poll': ([], {'code': 0, 'data': {'code': 0, 'url': 'https://passport.biligame.com/crossDomain?SESSDATA=sessdata_from_url'}})
        })
        poll2 = Bilibili(client2).qrcode_poll('key_12345678')
        self.assertEqual(poll2['status'], 'success')
        self.assertEqual(poll2['sessdata'], 'sessdata_from_url')

        # Test waiting / scanned / expired
        for c, st in [(86101, 'waiting'), (86090, 'scanned'), (86038, 'expired')]:
            cl = Fake({'/web/qrcode/poll': ([], {'code': 0, 'data': {'code': c}})})
            self.assertEqual(Bilibili(cl).qrcode_poll('key_12345678')['status'], st)

        # Bad key rejection
        with self.assertRaises(ProviderError):
            provider.qrcode_poll('bad;inject')

    def test_network_api_and_media_boundaries(self):
        for url in ['http://api.live.bilibili.com/a', 'https://127.0.0.1/a',
                    'https://api.live.bilibili.com.evil.test/a', 'https://api.live.bilibili.com:444/a']:
            with self.assertRaises(ProviderError):
                net.validate_url(url)
        for url in ['https://evilbilivideo.com/f.flv', 'https://a.bilivideo.com@evil.test/f.flv',
                    'https://a.bilivideo.com:123/f.flv', 'https://a.bilivideo.com/f.flv#x',
                    'https://a.bilivideo.com/f.flv\r\nX:evil']:
            with self.assertRaises(ProviderError):
                net.media_url(url, 'bilibili', 'flv')
        with self.assertRaises(ProviderError):
            net.fetch_text('https://live.douyin.com/', {'Cookie': 'secret'})

    def test_network_rejects_redirects_and_limits_body(self):
        class Response:
            status = 302
            def getheader(self, name, default=None):
                return default
        class Connection:
            sock = None
            def __init__(self, *a, **kw): pass
            def request(self, *a, **kw): pass
            def getresponse(self): return Response()
            def close(self): pass
        with patch('live_direct.net.http.client.HTTPSConnection', Connection):
            with self.assertRaises(ProviderError):
                net.fetch_json('https://api.live.bilibili.com/test')
        Response.status = 200
        Response.getheader = lambda self, name, default=None: str(net.MAX_BYTES + 1) if name == 'Content-Length' else default
        with patch('live_direct.net.http.client.HTTPSConnection', Connection):
            with self.assertRaises(ProviderError):
                net.fetch_json('https://api.live.bilibili.com/test')


if __name__ == '__main__':
    unittest.main()
