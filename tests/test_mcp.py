import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from live_direct.app import Application, Engine, Server
from live_direct.config import ConfigStore

TOKEN = 'a' * 32


class MCPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = ConfigStore(Path(self.tmp.name).resolve() / 'config.json')
        app = Application(self.store, TOKEN, 'b' * 32, 'http://localhost', Engine(self.store, {}))
        self.server = Server(('127.0.0.1', 0), app)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def rpc(self, payload, token=TOKEN, method='POST'):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        body = payload if isinstance(payload, str) else json.dumps(payload)
        conn.request(method, '/mcp', body, headers)
        response = conn.getresponse()
        out = response.status, response.read()
        conn.close()
        return out

    def call(self, name, arguments=None):
        status, body = self.rpc({'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call',
                                 'params': {'name': name, 'arguments': arguments or {}}})
        self.assertEqual(status, 200)
        return json.loads(body)['result']

    def test_requires_bearer_token(self):
        self.assertEqual(self.rpc({'jsonrpc': '2.0', 'id': 1, 'method': 'ping'}, token=None)[0], 401)
        self.assertEqual(self.rpc({'jsonrpc': '2.0', 'id': 1, 'method': 'ping'}, token='b' * 32)[0], 401)

    def test_get_is_not_allowed(self):
        self.assertEqual(self.rpc('{}', method='GET')[0], 405)

    def test_initialize_echoes_supported_version(self):
        status, body = self.rpc({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                                 'params': {'protocolVersion': '2025-11-25', 'capabilities': {},
                                            'clientInfo': {'name': 't', 'version': '1'}}})
        self.assertEqual(status, 200)
        result = json.loads(body)['result']
        self.assertEqual(result['protocolVersion'], '2025-11-25')
        self.assertIn('tools', result['capabilities'])
        self.assertEqual(result['serverInfo']['name'], 'live-direct')

    def test_tools_list_carries_cache_hints(self):
        status, body = self.rpc({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'})
        self.assertEqual(status, 200)
        result = json.loads(body)['result']
        names = {tool['name'] for tool in result['tools']}
        self.assertTrue({'status', 'get_config', 'list_channels', 'resolve_stream',
                         'update_config', 'refresh'} <= names)
        self.assertEqual(result['ttlMs'], 0)
        self.assertEqual(result['cacheScope'], 'private')
        for tool in result['tools']:
            self.assertIn('inputSchema', tool)
            self.assertEqual(tool['inputSchema'].get('type'), 'object')

    def test_status_tool(self):
        result = self.call('status')
        self.assertFalse(result['isError'])
        payload = json.loads(result['content'][0]['text'])
        self.assertIn('platforms', payload)
        self.assertIn('channel_count', payload)

    def test_update_config_then_read_back(self):
        result = self.call('update_config', {'patch': {'douyu': {'enabled': True, 'rooms': ['9999']}}})
        self.assertFalse(result['isError'])
        self.assertTrue(self.store.get()['douyu']['enabled'])
        self.assertEqual(self.store.get()['douyu']['rooms'], ['9999'])
        config = json.loads(self.call('get_config')['content'][0]['text'])['config']
        self.assertEqual(config['douyu']['rooms'], ['9999'])

    def test_invalid_patch_is_reported_not_raised(self):
        result = self.call('update_config', {'patch': {'douyu': {'count': -5}}})
        self.assertTrue(result['isError'])
        self.assertIn('error', json.loads(result['content'][0]['text']))

    def test_credentials_are_redacted(self):
        self.store.update({'bilibili': {'enabled': True, 'sessdata': 'topsecret'}})
        text = self.call('get_config')['content'][0]['text']
        self.assertNotIn('topsecret', text)
        self.assertIn('sessdata_set', text)

    def test_unknown_tool_is_jsonrpc_error(self):
        status, body = self.rpc({'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call',
                                 'params': {'name': 'nope', 'arguments': {}}})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['error']['code'], -32602)

    def test_notification_returns_no_body(self):
        status, body = self.rpc({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        self.assertEqual(status, 202)
        self.assertEqual(body, b'')

    def test_unknown_method_is_jsonrpc_error(self):
        status, body = self.rpc({'jsonrpc': '2.0', 'id': 9, 'method': 'resources/list'})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['error']['code'], -32601)


if __name__ == '__main__':
    unittest.main()
