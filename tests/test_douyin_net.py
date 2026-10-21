"""Network boundary tests: all connections are mocked, never live upstreams."""
import json
import unittest
from unittest.mock import Mock, patch

from live_direct import net
from live_direct.models import ProviderError


ROOM = '7699075811013610266'
SHARE = 'https://v.douyin.com/Ab_c-123/'


class Response:
    def __init__(self, status=200, headers=None, body=b''):
        self.status = status
        self.headers = headers or {}
        self.body = body

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def read1(self, size):
        chunk, self.body = self.body[:size], self.body[size:]
        return chunk


class DouyinNetTests(unittest.TestCase):
    def connect(self, responses):
        connections = []
        for response in responses:
            connection = Mock()
            connection.getresponse.return_value = response
            connections.append(connection)
        factory = Mock(side_effect=connections)
        return factory, connections

    def test_share_extracts_terminal_without_request_and_ignores_set_cookie(self):
        factory, connections = self.connect([
            Response(302, {'Location': '/Next/', 'Set-Cookie': 'secret=forbidden'}),
            Response(302, {'Location': 'https://webcast.amemv.com/douyin/webcast/reflow/' + ROOM + '?source=copy'}),
        ])
        with patch.object(net.http.client, 'HTTPSConnection', factory):
            self.assertEqual(net.resolve_douyin_share(SHARE), ROOM)
        self.assertEqual(factory.call_count, 2)
        for connection in connections:
            args, kwargs = connection.request.call_args
            self.assertEqual(args[0], 'HEAD')
            self.assertEqual(kwargs['headers']['User-Agent'], net.DOUYIN_MOBILE_UA)
            self.assertNotIn('Cookie', kwargs['headers'])
            connection.close.assert_called_once()
        self.assertTrue(all(call.kwargs['timeout'] <= net.TIMEOUT for call in factory.call_args_list))

    def test_recognized_paths_and_explicit_official_query(self):
        for target in [
            'https://webcast.amemv.com/reflow/' + ROOM,
            'https://www.iesdouyin.com/douyin/webcast/reflow/' + ROOM + '/',
            'https://live.douyin.com/landing?room_id=' + ROOM,
            'https://www.douyin.com/landing?room_id=' + ROOM,
        ]:
            with self.subTest(target=target):
                factory, _ = self.connect([Response(302, {'Location': target})])
                with patch.object(net.http.client, 'HTTPSConnection', factory):
                    self.assertEqual(net.resolve_douyin_share(SHARE), ROOM)
                self.assertEqual(factory.call_count, 1)

    def test_invalid_initial_urls_never_connect(self):
        for url in [None, 123, 'http://v.douyin.com/abc/',
                    'https://v.douyin.com/', 'https://v.douyin.com/a/b',
                    'https://v.douyin.com/a?x=1', 'https://v.douyin.com/a?',
                    'https://v.douyin.com/a#', 'https://v.douyin.com/a#x',
                    'https://user:secret@v.douyin.com/a',
                    'https://v.douyin.com:444/a', 'https://v.douyin.com.evil.test/a',
                    'https://v.douyin.com/a\n', 'https://v.douyin.com/a%0d',
                    'https://v.douyin.com/１２', 'https://www.douyin.com/abc']:
            with self.subTest(url=url), patch.object(net.http.client, 'HTTPSConnection') as factory:
                with self.assertRaises(ProviderError):
                    net.resolve_douyin_share(url)
                factory.assert_not_called()

    def test_bad_terminal_locations_validated_before_extraction(self):
        for target in [
            'https://evil.test/reflow/' + ROOM,
            'https://webcast.amemv.com.evil.test/reflow/' + ROOM,
            'http://webcast.amemv.com/reflow/' + ROOM,
            'https://user:secret@webcast.amemv.com/reflow/' + ROOM,
            'https://webcast.amemv.com:444/reflow/' + ROOM,
            'https://webcast.amemv.com/reflow/' + ROOM + '#secret',
            '\nhttps://webcast.amemv.com/reflow/' + ROOM,
            'https://webcast.amemv.com/reflow/' + ROOM + '?x=%0d%0aSecret',
            'https://webcast.amemv.com\\@evil.test/reflow/' + ROOM,
            None, '',
        ]:
            with self.subTest(target=target):
                factory, connections = self.connect([Response(302, {'Location': target})])
                with patch.object(net.http.client, 'HTTPSConnection', factory):
                    with self.assertRaises(ProviderError) as error:
                        net.resolve_douyin_share(SHARE)
                self.assertNotIn('secret', str(error.exception).lower())
                self.assertEqual(factory.call_count, 1)
                connections[0].close.assert_called_once()

    def test_arbitrary_digits_not_room_and_duplicate_query_rejected(self):
        for target in ['https://www.douyin.com/video/' + ROOM,
                       'https://live.douyin.com/' + ROOM,
                       'https://webcast.amemv.com/other/' + ROOM,
                       'https://www.douyin.com/?other=' + ROOM,
                       'https://www.douyin.com/?room_id=' + ROOM + '&room_id=' + ROOM]:
            with self.subTest(target=target):
                factory, _ = self.connect([Response(302, {'Location': target}), Response(200)])
                with patch.object(net.http.client, 'HTTPSConnection', factory):
                    with self.assertRaises(ProviderError):
                        net.resolve_douyin_share(SHARE)
                self.assertEqual(factory.call_count, 2)

    def test_loop_and_four_request_limit(self):
        factory, _ = self.connect([Response(302, {'Location': SHARE})])
        with patch.object(net.http.client, 'HTTPSConnection', factory):
            with self.assertRaises(ProviderError):
                net.resolve_douyin_share(SHARE)
        self.assertEqual(factory.call_count, 1)
        factory, _ = self.connect([Response(302, {'Location': '/hop' + str(i)}) for i in range(4)])
        with patch.object(net.http.client, 'HTTPSConnection', factory):
            with self.assertRaises(ProviderError):
                net.resolve_douyin_share(SHARE)
        self.assertEqual(factory.call_count, 4)

    def test_fourth_location_validated_even_without_fifth_request(self):
        for target, success in [
            ('https://webcast.amemv.com/reflow/' + ROOM, True),
            ('https://evil.test/reflow/' + ROOM, False),
        ]:
            responses = [Response(302, {'Location': '/hop' + str(i)}) for i in range(3)]
            responses.append(Response(302, {'Location': target}))
            factory, _ = self.connect(responses)
            with patch.object(net.http.client, 'HTTPSConnection', factory):
                if success:
                    self.assertEqual(net.resolve_douyin_share(SHARE), ROOM)
                else:
                    with self.assertRaises(ProviderError):
                        net.resolve_douyin_share(SHARE)
            self.assertEqual(factory.call_count, 4)

    def test_shared_total_deadline_and_safe_transport_error(self):
        factory, _ = self.connect([Response(302, {'Location': '/next'})])
        with patch.object(net.http.client, 'HTTPSConnection', factory), patch.object(
                net.time, 'monotonic', side_effect=[0, 1, 2, net.TIMEOUT + 1]):
            with self.assertRaises(ProviderError):
                net.resolve_douyin_share(SHARE)
        with patch.object(net.http.client, 'HTTPSConnection', side_effect=OSError('secret cookie')):
            with self.assertRaises(ProviderError) as error:
                net.resolve_douyin_share(SHARE)
        self.assertNotIn('secret', str(error.exception))

    def test_reflow_fixed_request_full_json_and_cookie_isolation(self):
        payload = {'status_code': 0, 'data': {'room': {'id_str': ROOM}}, 'extra': {'ok': True}}
        factory, connections = self.connect([Response(body=json.dumps(payload).encode())])
        with patch.object(net.http.client, 'HTTPSConnection', factory):
            self.assertEqual(net.fetch_douyin_reflow(ROOM), payload)
        self.assertEqual(factory.call_args.args, ('webcast.amemv.com',))
        args, kwargs = connections[0].request.call_args
        self.assertEqual(args, ('GET', '/webcast/room/reflow/info/?type_id=0&live_id=1&room_id=' + ROOM + '&app_id=1128'))
        self.assertEqual(kwargs['headers']['Cookie'], net._DOUYIN_SHARE_COOKIE)
        self.assertIn('client_share', kwargs['headers']['Cookie'])
        self.assertNotIn('webcast.amemv.com', net.API_HOSTS)
        connections[0].close.assert_called_once()
        for host in ['live.douyin.com', 'passport.bilibili.com', 'webcast.amemv.com']:
            with patch.object(net.http.client, 'HTTPSConnection') as factory:
                with self.assertRaises(ProviderError):
                    net.fetch_json('https://' + host + '/', {'Cookie': 'secret'})
                factory.assert_not_called()

    def test_reflow_invalid_ids_no_io(self):
        for room_id in [None, 123, 7699075811013610266, '', ROOM + '0', ROOM[:-1],
                        '９' * 19, ROOM + '\n', ROOM + '&token=secret']:
            with self.subTest(room_id=room_id), patch.object(net.http.client, 'HTTPSConnection') as factory:
                with self.assertRaises(ProviderError):
                    net.fetch_douyin_reflow(room_id)
                factory.assert_not_called()

    def test_reflow_bounds_errors_redirects_never_followed(self):
        for response in [Response(302, {'Location': 'https://evil.test/secret'}),
                         Response(200, {'Content-Encoding': 'gzip'}),
                         Response(200, {'Content-Length': str(net.MAX_BYTES + 1)}),
                         Response(200, {'Content-Length': 'secret'}),
                         Response(body=b'invalid secret json')]:
            factory, connections = self.connect([response])
            with patch.object(net.http.client, 'HTTPSConnection', factory):
                with self.assertRaises(ProviderError) as error:
                    net.fetch_douyin_reflow(ROOM)
            self.assertNotIn('secret', str(error.exception))
            self.assertEqual(factory.call_count, 1)
            connections[0].close.assert_called_once()
        factory, _ = self.connect([Response(body=b'x' * 33)])
        with patch.object(net.http.client, 'HTTPSConnection', factory), patch.object(net, 'MAX_BYTES', 32):
            with self.assertRaises(ProviderError):
                net.fetch_douyin_reflow(ROOM)

    def test_general_api_redirect_policy_unchanged(self):
        factory, _ = self.connect([Response(302, {'Location': 'https://evil.test/'})])
        with patch.object(net.http.client, 'HTTPSConnection', factory):
            with self.assertRaises(ProviderError):
                net.fetch_text('https://live.douyin.com/')
        self.assertEqual(factory.call_count, 1)


if __name__ == '__main__':
    unittest.main()
