"""APTV-confirmed CDN preference, independent mocked provider responses."""
import unittest
from unittest.mock import Mock
from live_direct.providers.douyu import Douyu
from live_direct.models import ProviderError
from tests.test_douyu_diagnostics import play


class PreferenceTests(unittest.TestCase):
    def provider(self, responses):
        p = Douyu()
        p._room = Mock(return_value={'id': '123'})
        p._play = Mock(side_effect=responses)
        return p

    def test_prefers_hw_same_requested_quality(self):
        p = self.provider([play(cdn='scdn')['data'], play(base='https://hw.douyucdn.cn/live')['data']])
        self.assertIn('hw.douyucdn.cn', p.resolve('123', {'quality': 4}).url)
        self.assertEqual(p._play.call_args_list[-1].args, ('123', 4, 'hw-h5'))

    def test_failed_hw_uses_hs(self):
        p = self.provider([play(cdn='scdn')['data'], ProviderError('failed'), play(cdn='hs-h5', base='https://hs.douyucdn.cn/live')['data']])
        self.assertIn('hs.douyucdn.cn', p.resolve('123', {}).url)

    def test_silent_hw_fallback_uses_hs(self):
        p = self.provider([play(cdn='scdn')['data'], play(cdn='scdn')['data'], play(cdn='hs-h5', base='https://hs.douyucdn.cn/live')['data']])
        self.assertIn('hs.douyucdn.cn', p.resolve('123', {}).url)

    def test_unadvertised_not_requested(self):
        p = self.provider([play(lines=('other',), cdn='scdn')['data']])
        self.assertEqual(p.resolve('123', {}).format, 'flv')
        self.assertEqual(p._play.call_count, 1)

    def test_all_preferred_fail_retains_default(self):
        p = self.provider([play(cdn='scdn', base='https://default.douyucdn.cn/live')['data'], ProviderError('hw'), ProviderError('hs')])
        self.assertIn('default.douyucdn.cn', p.resolve('123', {}).url)
