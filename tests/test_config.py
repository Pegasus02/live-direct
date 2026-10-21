import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from live_direct.config import ConfigError, ConfigStore, DEFAULTS


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        # macOS /var is itself a symlink; use the trusted resolved temp root.
        self.root = Path(self.temp.name).resolve()
        self.path = self.root / "private" / "config.json"
        self.store = ConfigStore(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def test_provider_limits_and_positive_room_ids(self):
        good = {'douyin': {'rooms': [str(i+1) for i in range(100)], 'categories': [str(i) for i in range(8)]}, 'bilibili': {'rooms': ['000123'], 'areas': [str(i) for i in range(16)], 'top_per_area': 50, 'sessdata': 'x'*4096}}
        self.store.update(good)
        self.assertEqual(self.store.get()['bilibili']['rooms'], ['123'])
        for patch in [{'douyin': {'rooms': [str(i+1) for i in range(101)]}}, {'douyin': {'categories': [str(i) for i in range(9)]}}, {'bilibili': {'areas': [str(i) for i in range(17)]}}, {'bilibili': {'top_per_area': 51}}, {'bilibili': {'sessdata': 'x'*4097}}, {'bilibili': {'rooms': ['0']}}, {'bilibili': {'rooms': ['https://live.bilibili.com/0']}}]:
            with self.subTest(patch=next(iter(patch.values())).keys()):
                with self.assertRaises(ConfigError): self.store.update(patch)

    def test_conservative_defaults_and_defensive_copy(self):
        config = self.store.get()
        self.assertFalse(config["douyin"]["enabled"])
        self.assertFalse(config["bilibili"]["enabled"])
        self.assertEqual(config["douyin"]["rooms"], [])
        config["douyin"]["rooms"].append("999")
        self.assertEqual(self.store.get()["douyin"]["rooms"], [])
        self.assertFalse(self.path.exists())

    def test_secret_redaction_preservation_clear_and_reload(self):
        result = self.store.update({"bilibili": {"sessdata": "test-secret%2Fvalue"}})
        self.assertNotIn("sessdata", result["bilibili"])
        self.assertTrue(result["bilibili"]["sessdata_set"])
        for patch_value in ({"douyin": {"count": 2}}, {"bilibili": {"sessdata": ""}}, {}):
            self.store.update(patch_value)
            self.assertEqual(self.store.get()["bilibili"]["sessdata"], "test-secret%2Fvalue")
        self.assertEqual(ConfigStore(self.path).get()["bilibili"]["sessdata"], "test-secret%2Fvalue")
        self.assertNotIn("test-secret", json.dumps(self.store.get(public=True)))
        self.store.update({"bilibili": {"clear_sessdata": True}})
        self.assertFalse(self.store.get(public=True)["bilibili"]["sessdata_set"])
        self.assertNotIn("clear_sessdata", self.path.read_text())

    def test_full_whitelist_and_scalar_validation(self):
        invalid = [None, [], {"__proto__": {}}, {"douyin": {"url": "https://bad.test"}},
                   {"douyin": {"enabled": 1}}, {"douyin": {"count": True}},
                   {"douyin": {"count": 101}}, {"bilibili": {"min_online": -1}},
                   {"bilibili": {"quality": 999}}, {"douyin": {"quality": "arbitrary"}},
                   {"bilibili": {"sessdata_set": True}}, {"bilibili": {"clear_sessdata": "yes"}},
                   {"bilibili": {"sessdata": "cookie; injected=value"}},
                   {"bilibili": {"sessdata": "secret\r\nInjected: x"}},
                   {"bilibili": {"sessdata": "secret", "clear_sessdata": True}},
                   {"douyin": {"categories": ["<script>"]}}, {"bilibili": {"areas": ["../1"]}}]
        for value in invalid:
            with self.subTest(patch=value), self.assertRaises(ConfigError):
                self.store.update(value)
        self.assertEqual(self.store.get(), DEFAULTS)
        self.assertFalse(self.path.exists())

    def test_lists_normalize_and_reject_arbitrary_links(self):
        result = self.store.update({"douyin": {"rooms": ["https://live.douyin.com/abc_12", "abc_12"], "categories": ["游戏", "103"]}, "bilibili": {"rooms": ["https://live.bilibili.com/123/"], "areas": ["网游", "赛事"]}})
        self.assertEqual(result["douyin"]["rooms"], ["abc_12"])
        self.assertEqual(result["bilibili"]["rooms"], ["123"])
        bad = ["https://live.douyin.com.evil.test/123", "https://evil.test/123", "https://live.douyin.com@evil.test/123", "https://live.douyin.com:443/123", "https://live.douyin.com/123?token=abc", "https://live.douyin.com/a/b", "file:///etc/passwd", "../123", "123\nInjected"]
        for room in bad:
            with self.subTest(room=room), self.assertRaises(ConfigError):
                self.store.update({"douyin": {"rooms": [room]}})

    def test_private_persistence_and_existing_permissions_repaired(self):
        self.store.update({})
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.path.parent.stat().st_mode), 0o700)
        os.chmod(self.path, 0o644)
        ConfigStore(self.path)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertFalse(list(self.path.parent.glob("*.tmp")))

    def test_atomic_replace_failure_keeps_old_state(self):
        self.store.update({"douyin": {"count": 3}})
        before = self.path.read_bytes()
        with patch("live_direct.config.os.replace", side_effect=OSError("disk failure")):
            with self.assertRaises(ConfigError):
                self.store.update({"douyin": {"count": 8}})
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual(self.store.get()["douyin"]["count"], 3)
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])

    def test_symlink_file_and_directory_rejected(self):
        target = self.root / "target.json"
        target.write_text('{}')
        self.path.parent.mkdir()
        self.path.symlink_to(target)
        with self.assertRaises(ConfigError):
            ConfigStore(self.path)
        with self.assertRaises(ConfigError):
            self.store.update({})
        self.assertEqual(target.read_text(), '{}')
        real = self.root / "real"
        real.mkdir()
        link = self.root / "link"
        link.symlink_to(real, target_is_directory=True)
        with self.assertRaises(ConfigError):
            ConfigStore(link / "config.json")

    def test_hardlink_and_nonregular_rejected(self):
        self.path.parent.mkdir()
        target = self.root / "target"
        target.write_text('{}')
        os.link(target, self.path)
        with self.assertRaises(ConfigError):
            ConfigStore(self.path)
        folder = self.root / "folder.json"
        folder.mkdir()
        with self.assertRaises(ConfigError):
            ConfigStore(folder)

    def test_bad_stored_json_never_silently_resets(self):
        self.path.parent.mkdir()
        for content in ('{"douyin":{},"douyin":{}}', '{bad json', '{"arbitrary":1}', '{"bilibili":{"sessdata":"secret\\nvalue"}}'):
            self.path.write_text(content)
            with self.subTest(content=content), self.assertRaises(ConfigError) as error:
                ConfigStore(self.path)
            self.assertNotIn("secret", str(error.exception))


if __name__ == '__main__':
    unittest.main()
