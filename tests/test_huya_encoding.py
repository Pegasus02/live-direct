"""Bounded Huya-only unsolicited gzip response handling."""
import gzip
import unittest
from unittest.mock import Mock, patch
from live_direct import net
from live_direct.models import ProviderError
from tests.test_douyin_net import Response


class HuyaEncodingTests(unittest.TestCase):
    def fetch(self, body, encoding='gzip', host='www.huya.com', limit=1000):
        connection = Mock()
        connection.getresponse.return_value = Response(headers={'Content-Encoding': encoding}, body=body)
        with patch.object(net.http.client, 'HTTPSConnection', return_value=connection), patch.object(net, 'MAX_BYTES', limit):
            return net.fetch_text('https://' + host + '/10188')

    def test_huya_gzip_and_identity(self):
        raw = '虎牙直播'.encode()
        self.assertEqual(self.fetch(gzip.compress(raw)), raw.decode())
        self.assertEqual(self.fetch(raw, 'identity'), raw.decode())

    def test_output_bomb_and_wire_limit(self):
        with self.assertRaises(ProviderError):
            self.fetch(gzip.compress(b'a' * 10000), limit=100)
        with self.assertRaises(ProviderError):
            self.fetch(b'a' * 101, 'identity', limit=100)

    def test_truncated_corrupt_concatenated_trailing(self):
        valid = gzip.compress(b'hello')
        for body in (valid[:-4], b'not gzip', valid + valid, valid + b'junk'):
            with self.subTest(body=body), self.assertRaises(ProviderError):
                self.fetch(body)

    def test_other_encodings_and_hosts_still_rejected(self):
        for host, encoding in [('www.huya.com', 'br'), ('www.douyu.com', 'gzip'), ('live.douyin.com', 'gzip')]:
            with self.subTest(host=host, encoding=encoding), self.assertRaises(ProviderError):
                self.fetch(gzip.compress(b'hello'), encoding, host)
