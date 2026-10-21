"""Independent, strict, private JSON configuration (standard library only).

HTTP contract: GET /api/config -> store.get(public=True); POST /api/config
accepts a partial object -> store.update(patch), already redacted. Config keys
are exactly the registered platform names, NOT an original NAS API configuration.
Private get() is for providers only. Public responses omit sessdata and expose
bilibili.sessdata_set (configured, not remotely validated). An omitted or empty
sessdata preserves the current value; clear_sessdata:true explicitly clears it.
The clear flag is transient, never persisted. See web/README.md for UI routes.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
import secrets
import stat
import threading
from urllib.parse import urlsplit


DEFAULTS = {
    "douyin": {"enabled": False, "rooms": [], "share_links": [], "categories": [], "count": 10,
               "min_viewers": 0, "quality": "FULL_HD1"},
    "bilibili": {"enabled": False, "rooms": [], "areas": [], "top_per_area": 10,
                 "min_online": 0, "quality": 10000, "prefer_avc": True,
                 "sessdata": ""},
    "douyu": {"enabled": False, "rooms": [], "categories": [], "count": 10,
              "min_viewers": 0, "quality": 0},
    "huya": {"enabled": False, "rooms": [], "categories": [], "count": 10,
             "min_viewers": 0, "quality": 0},
}
DOUYIN_QUALITIES = ("FULL_HD1", "HD1", "SD2", "SD1")
BILIBILI_QUALITIES = (0, 80, 150, 250, 400, 10000, 20000, 30000)
DOUYU_QUALITIES = (0, 4, 3, 2)
HUYA_QUALITIES = (0, 20000, 14000, 4000, 2000, 500)
# Room ID pattern, whether IDs are positive integers, and exact official room hosts.
ROOMS = {
    "douyin": (r"[A-Za-z0-9_-]{1,64}", False, ("live.douyin.com",)),
    "bilibili": (r"[0-9]{1,20}", True, ("live.bilibili.com",)),
    "douyu": (r"[0-9]{1,12}", True, ("www.douyu.com", "douyu.com")),
    "huya": (r"(?![gGmMlL]$)[A-Za-z0-9_-]{1,64}", False, ("www.huya.com", "huya.com")),
}
_MAX_BYTES = 262144


class ConfigError(ValueError):
    """Invalid configuration; messages contain field names, never values."""


def _integer(value, low, high, field):
    if type(value) is not int or not low <= value <= high:
        raise ConfigError(f"{field}: integer must be between {low} and {high}")


def _room(value, platform):
    if not isinstance(value, str) or len(value) > 256:
        raise ConfigError(f"{platform}.rooms: invalid room")
    value = value.strip()
    pattern, numeric, hosts = ROOMS[platform]
    if not re.fullmatch(pattern, value):
        try:
            parts = urlsplit(value)
            if (parts.scheme not in ("https", "http") or parts.netloc not in hosts
                    or parts.query or parts.fragment):
                raise ValueError
            room = parts.path.strip("/")
            if parts.path not in ("/" + room, "/" + room + "/") or not re.fullmatch(pattern, room):
                raise ValueError
            value = room
        except ValueError:
            raise ConfigError(f"{platform}.rooms: use a room ID or exact platform room link") from None
    if numeric:
        if int(value) <= 0:
            raise ConfigError(f"{platform}.rooms: expected positive ID")
        return str(int(value))
    return value


def _share_links(value):
    """Extract one exact short URL per share text, without resolving any links."""
    field = "douyin.share_links"
    if not isinstance(value, list) or len(value) > 100:
        raise ConfigError(f"{field}: expected a list of at most 100 items")
    result = []
    for item in value:
        if (not isinstance(item, str) or len(item) > 2048
                or any(ord(c) < 32 and c not in "\r\n\t" for c in item)):
            raise ConfigError(f"{field}: invalid share text")
        # Count all URL starts, not just allowed-host matches: a second URL must
        # never be silently discarded. Also reject scheme-relative/www links.
        starts = list(re.finditer(r"(?:[A-Za-z][A-Za-z0-9+.-]*:)?//|www\.", item, re.IGNORECASE))
        links = list(re.finditer(r"https://[^\s<>\"'（）()【】\[\]，。！？；、]+", item))
        if (len(starts) != 1 or len(links) != 1
                or starts[0].start() != links[0].start()
                or (links[0].start() and re.match(r"[A-Za-z0-9_./:@%+\\-]", item[links[0].start() - 1]))
                or not re.fullmatch(r"https://v\.douyin\.com/[A-Za-z0-9_-]+/", links[0].group())):
            raise ConfigError(f"{field}: use one exact Douyin short URL per item")
        link = links[0].group()
        if link not in result:
            result.append(link)
    return result


def _strings(value, field, pattern, maximum=200):
    if not isinstance(value, list) or len(value) > maximum:
        raise ConfigError(f"{field}: expected a list of at most {maximum} items")
    result = []
    for item in value:
        if not isinstance(item, str) or not re.fullmatch(pattern, item):
            raise ConfigError(f"{field}: invalid identifier")
        if item not in result:
            result.append(item)
    return result


def _validate(config):
    if not isinstance(config, dict) or set(config) != set(DEFAULTS):
        raise ConfigError("config: only registered platforms are allowed")
    for platform, values in config.items():
        if not isinstance(values, dict) or set(values) != set(DEFAULTS[platform]):
            raise ConfigError(f"{platform}: unknown or missing fields")
        if type(values["enabled"]) is not bool:
            raise ConfigError(f"{platform}.enabled: expected boolean")
        rooms = values["rooms"]
        if not isinstance(rooms, list) or len(rooms) > 100:
            raise ConfigError(f"{platform}.rooms: expected at most 100 rooms")
        values["rooms"] = list(dict.fromkeys(_room(room, platform) for room in rooms))
    dy, bili = config["douyin"], config["bilibili"]
    dy["share_links"] = _share_links(dy["share_links"])
    name = r"[A-Za-z0-9_\-\u4e00-\u9fff]{1,64}"
    for platform in ("douyin", "douyu", "huya"):
        config[platform]["categories"] = _strings(config[platform]["categories"], f"{platform}.categories", name, 8)
    bili["areas"] = _strings(bili["areas"], "bilibili.areas", name, 16)
    for platform, limit, minimum, maximum in (("douyin", "count", "min_viewers", 100),
                                              ("bilibili", "top_per_area", "min_online", 50),
                                              ("douyu", "count", "min_viewers", 100),
                                              ("huya", "count", "min_viewers", 100)):
        values = config[platform]
        _integer(values[limit], 0, maximum, f"{platform}.{limit}")
        _integer(values[minimum], 0, 1000000000, f"{platform}.{minimum}")
    if not isinstance(dy["quality"], str) or dy["quality"] not in DOUYIN_QUALITIES:
        raise ConfigError("douyin.quality: unsupported quality")
    for platform, qualities in (("douyu", DOUYU_QUALITIES), ("huya", HUYA_QUALITIES)):
        if type(config[platform]["quality"]) is not int or config[platform]["quality"] not in qualities:
            raise ConfigError(f"{platform}.quality: unsupported quality")
    if type(bili["quality"]) is not int or bili["quality"] not in BILIBILI_QUALITIES:
        raise ConfigError("bilibili.quality: unsupported quality")
    if type(bili["prefer_avc"]) is not bool:
        raise ConfigError("bilibili.prefer_avc: expected boolean")
    secret = bili["sessdata"]
    if not isinstance(secret, str) or len(secret) > 4096 or any(ord(c) < 33 or ord(c) > 126 or c in ";," for c in secret):
        raise ConfigError("bilibili.sessdata: expected a single cookie value")
    return config


def _public(config):
    result = copy.deepcopy(config)
    result["bilibili"]["sessdata_set"] = bool(result["bilibili"].pop("sessdata"))
    return result


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ConfigError("config: duplicate JSON keys")
        result[key] = value
    return result


class ConfigStore:
    """One-process thread-safe store; all path components reject symlinks.

    Writes use a private temporary file in the same anchored directory, fsync,
    and atomic replace. No credentials are interpolated into exception messages.
    Caller should use a single store per configuration file (no multiprocess CAS).
    """
    def __init__(self, path):
        self.path = Path(os.path.abspath(os.path.expanduser(os.fspath(path))))
        self._lock = threading.RLock()
        with self._lock:
            directory = self._directory(create=False)
            try:
                self._config = self._load(directory) if directory is not None else copy.deepcopy(DEFAULTS)
            finally:
                if directory is not None:
                    os.close(directory)

    def _directory(self, create):
        fd = os.open(self.path.anchor, os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in self.path.parent.parts[1:]:
                try:
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                except FileNotFoundError:
                    if not create:
                        os.close(fd)
                        return None
                    try:
                        os.mkdir(part, 0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            return fd
        except OSError:
            os.close(fd)
            raise ConfigError("config: unsafe or inaccessible directory") from None

    def _load(self, directory):
        try:
            fd = os.open(self.path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return copy.deepcopy(DEFAULTS)
        except OSError:
            raise ConfigError("config: unsafe or inaccessible file") from None
        try:
            with os.fdopen(fd, "rb") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ConfigError("config: expected a regular, unlinked private file")
                raw = handle.read(_MAX_BYTES + 1)
                if len(raw) > _MAX_BYTES:
                    raise ConfigError("config: file too large")
                try:
                    data = json.loads(raw, object_pairs_hook=_pairs)
                except (ValueError, UnicodeError):
                    raise ConfigError("config: invalid JSON") from None
                # Stored files may omit newly introduced fields, but never add arbitrary keys.
                merged = copy.deepcopy(DEFAULTS)
                self._merge(merged, data, loading=True)
                _validate(merged)
                os.fchmod(handle.fileno(), 0o600)
                return merged
        except OSError:
            raise ConfigError("config: unable to read private file") from None

    @staticmethod
    def _merge(current, patch, loading=False):
        if not isinstance(patch, dict) or not set(patch).issubset(DEFAULTS):
            raise ConfigError("config: unknown platform or invalid patch")
        for platform, fields in patch.items():
            allowed = set(DEFAULTS[platform]) | ({"clear_sessdata"} if platform == "bilibili" and not loading else set())
            if not isinstance(fields, dict) or not set(fields).issubset(allowed):
                raise ConfigError(f"{platform}: unknown field or invalid patch")
            clear = fields.get("clear_sessdata", False)
            if type(clear) is not bool:
                raise ConfigError("bilibili.clear_sessdata: expected boolean")
            if clear and fields.get("sessdata"):
                raise ConfigError("bilibili: cannot set and clear sessdata together")
            for key, value in fields.items():
                if key == "clear_sessdata":
                    continue
                if platform == "bilibili" and key == "sessdata" and value == "" and not loading:
                    continue
                current[platform][key] = copy.deepcopy(value)
            if clear:
                current[platform]["sessdata"] = ""

    def get(self, public=False):
        with self._lock:
            return _public(self._config) if public else copy.deepcopy(self._config)

    def update(self, patch):
        with self._lock:
            candidate = copy.deepcopy(self._config)
            self._merge(candidate, patch)
            _validate(candidate)
            payload = (json.dumps(candidate, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            if len(payload) > _MAX_BYTES:
                raise ConfigError("config: serialized configuration too large")
            directory = self._directory(create=True)
            temporary = ".live-direct-" + secrets.token_hex(12) + ".tmp"
            try:
                try:
                    existing = os.stat(self.path.name, dir_fd=directory, follow_symlinks=False)
                except FileNotFoundError:
                    existing = None
                if existing and (not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1):
                    raise ConfigError("config: refusing unsafe destination")
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
                with os.fdopen(fd, "wb") as handle:
                    os.fchmod(handle.fileno(), 0o600)
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path.name, src_dir_fd=directory, dst_dir_fd=directory)
                self._config = candidate
                os.fsync(directory)
            except OSError:
                raise ConfigError("config: unable to persist private configuration") from None
            finally:
                try:
                    os.unlink(temporary, dir_fd=directory)
                except FileNotFoundError:
                    pass
                finally:
                    os.close(directory)
            return _public(candidate)
