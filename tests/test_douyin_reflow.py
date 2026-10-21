import copy
import time
import unittest

from live_direct.models import ProviderError, RoomOfflineError
from live_direct.providers.douyin import Douyin

LINK = 'https://v.douyin.com/Example123/'
INTERNAL = '7699075811013610266'
WEB = '513132823765'


def fixture(status=2, web=WEB):
    return {'status_code': 0, 'data': {'room': {
        'id_str': INTERNAL, 'status': status, 'title': 'Live title',
        'owner': {'web_rid': web, 'nickname': 'Fixture anchor'},
        'stream_url': {'flv_pull_url': {'FULL_HD1': 'https://pull.douyincdn.com/live/test.flv?sign=fixture'}}}}}


class Client:
    def __init__(self, body=None):
        self.body = body if body is not None else fixture()
        self.calls = []

    def resolve_douyin_share(self, link):
        self.calls.append(('share', link))
        return INTERNAL

    def fetch_douyin_reflow(self, internal):
        self.calls.append(('reflow', internal))
        return copy.deepcopy(self.body)

    def fetch_text(self, url, headers=None):
        self.calls.append(('html', url))
        return '<html><title>验证码中间页</title></html>'


class ReflowTests(unittest.TestCase):
    def test_share_recovers_manual_without_html_and_resolves_web_id(self):
        client = Client()
        provider = Douyin(client)
        cfg = {'enabled': True, 'rooms': [WEB], 'share_links': [LINK]}
        channels = provider.discover(cfg)
        self.assertEqual([c.room_id for c in channels], [WEB])
        self.assertEqual(provider.warnings, [])
        self.assertEqual(provider.resolve(WEB, cfg).format, 'flv')
        self.assertFalse(any(k == 'html' for k, _ in client.calls))
        self.assertEqual(sum(k == 'share' for k, _ in client.calls), 1)

    def test_expired_mapping_re_resolves_share_and_removed_link_not_used(self):
        client = Client()
        provider = Douyin(client)
        provider._remember(WEB, INTERNAL, LINK)
        provider._identities[WEB] = (INTERNAL, LINK, time.monotonic() - 1)
        provider.resolve(WEB, {'share_links': [LINK]})
        self.assertEqual(client.calls[0], ('share', LINK))
        client.calls.clear()
        with self.assertRaises(ProviderError):
            provider.resolve(WEB, {'share_links': []})
        self.assertEqual([k for k, _ in client.calls], ['html'])

    def test_reflow_offline_and_failure_are_distinct(self):
        with self.assertRaises(RoomOfflineError):
            Douyin(Client(fixture(4)))._shared_room(LINK)
        for body in ({'status_code': 10011}, fixture(None), {'status_code': 0, 'data': {}},
                     {'status_code': 0, 'data': {'room': {'status': 2}}}):
            with self.subTest(body=body), self.assertRaises(ProviderError) as cm:
                Douyin(Client(body))._shared_room(LINK)
            self.assertNotIsInstance(cm.exception, RoomOfflineError)

    def test_reflow_identity_mismatch_and_untrusted_stream_rejected(self):
        provider = Douyin(Client(fixture(web='other')))
        with self.assertRaises(ProviderError):
            provider._shared_room(LINK, WEB)
        body = fixture()
        body['data']['room']['stream_url']['flv_pull_url']['FULL_HD1'] = 'https://evil.test/test.flv'
        provider = Douyin(Client(body))
        self.assertEqual(provider.discover({'enabled': True, 'share_links': [LINK]}), [])
        self.assertIn('A Douyin room has no trusted stream', provider.warnings)

    def test_category_identity_allows_api_resolution(self):
        client = Client()
        provider = Douyin(client)
        provider._remember(WEB, INTERNAL)
        stream = provider.resolve(WEB, {})
        self.assertEqual(stream.format, 'flv')
        self.assertEqual(client.calls, [('reflow', INTERNAL)])

    def test_lookup_does_not_slide_share_expiry_and_drops_expired_category(self):
        client = Client()
        provider = Douyin(client)
        provider._remember(WEB, INTERNAL, LINK)
        original_expiry = provider._identities[WEB][2]
        provider.resolve(WEB, {'share_links': [LINK]})
        self.assertEqual(provider._identities[WEB][2], original_expiry)
        provider._identities[WEB] = (INTERNAL, '', time.monotonic() - 1)
        client.calls.clear()
        with self.assertRaises(ProviderError):
            provider.resolve(WEB, {})
        self.assertEqual([k for k, _ in client.calls], ['html'])
        self.assertNotIn(WEB, provider._identities)

    def test_malformed_nested_metadata_is_safe_provider_error(self):
        body = fixture()
        body['data']['room']['owner']['avatar_thumb'] = ['invalid']
        with self.assertRaises(ProviderError) as cm:
            Douyin(Client(body))._shared_room(LINK)
        self.assertNotIsInstance(cm.exception, RoomOfflineError)

    def test_captcha_not_offline(self):
        with self.assertRaises(ProviderError) as cm:
            Douyin(Client()).resolve(WEB, {})
        self.assertNotIsInstance(cm.exception, RoomOfflineError)
        self.assertIn('verification', str(cm.exception))
