"""Douyin public Flight pages, no JavaScript evaluation or browser session.

Derived from akiralereal/iptv extractors/douyin-live/api.js and index.js
(GPL-3.0), including supplied local working copies. Upstream reference:
https://github.com/akiralereal/iptv/tree/e475b2f6d24029f844ada2b362d703c8b88c2e9b/extractors/douyin-live
Copyright upstream contributors; derivative distributed under GPL-3.0.
"""
import json
import re
import time
import threading
from urllib.parse import urlsplit

from .. import net
from ..models import Channel, Stream, ProviderError, RoomOfflineError
from ._pool import fan_out

ORIGIN = 'https://live.douyin.com'
CATEGORIES = {'101': '聊天', '102': '音乐', '103': '游戏', '104': '二次元',
              '105': '舞蹈', '106': '文化', '107': '生活', '108': '运动'}
QUALITIES = ('FULL_HD1', 'HD1', 'SD2', 'SD1')
DEFAULTS = {'enabled': False, 'rooms': [], 'categories': [], 'count': 20,
            'min_viewers': 0, 'quality': 'HD1'}
HEADERS = {'Referer': ORIGIN + '/', 'Accept': 'text/html', 'Accept-Language': 'zh-CN'}


def normalize_room(value):
    text = str(value).strip()
    if '://' in text:
        p = net.validate_url(text, {'live.douyin.com'})
        if p.query:
            raise ProviderError('Invalid Douyin room identifier')
        text = p.path.strip('/')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', text):
        raise ProviderError('Invalid Douyin room identifier')
    return text


def flight_data(page):
    """Extract only JSON arguments from recognized Flight scripts (never eval)."""
    values = []
    for script in re.findall(r'<script\b[^>]*>([\s\S]*?)</script>', page, re.I):
        script = script.strip()
        if script.endswith(';'):
            script = script[:-1]
        prefix = 'self.__pace_f.push('
        if not script.startswith(prefix) or not script.endswith(')'):
            continue
        try:
            args = json.loads(script[len(prefix):-1])
            chunk = args[1]
            if not isinstance(chunk, str) or not re.match(r'^[0-9a-f]+:', chunk, re.I):
                continue
            values.append(json.loads(chunk.split(':', 1)[1]))
        except (ValueError, IndexError, KeyError, TypeError, RecursionError):
            continue
    return values


def _row(item, category=''):
    room = item.get('room') or {}
    rid = str(item.get('web_rid') or '')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', rid) or not room.get('stream_url'):
        return None
    owner = room.get('owner') or {}
    avatars = (owner.get('avatar_thumb') or {}).get('url_list') or ['']
    try:
        viewers = int((room.get('room_view_stats') or {}).get('display_value', 0))
    except (ValueError, TypeError):
        viewers = 0
    return {'id': rid, 'key': str(room.get('id_str') or rid), 'name': str(owner.get('nickname') or rid),
            'title': str(room.get('title') or ''), 'logo': str(item.get('avatar') or avatars[0]),
            'viewers': viewers, 'streams': room['stream_url'], 'category': category}


def parse_category_page(page, category=''):
    for data in flight_data(page):
        try:
            items = data[3]['roomsData']['data']
        except (IndexError, KeyError, TypeError):
            continue
        if isinstance(items, list):
            return [r for i in items if isinstance(i, dict) and (r := _row(i, category))]
    raise ProviderError('Douyin category page format unavailable')


def parse_room_page(page, requested_id):
    for data in flight_data(page):
        try:
            info = data[3]['state']['roomStore']['roomInfo']
            room = info['room']
        except (IndexError, KeyError, TypeError):
            continue
        if not room:
            raise RoomOfflineError('Douyin room is offline')
        if room.get('status') not in (2, '2'):
            raise RoomOfflineError('Douyin room is offline')
        row = _row({'room': room, 'web_rid': info.get('web_rid') or requested_id})
        if row:
            return row
    # Missing page data can be an anti-bot response; never claim this is offline.
    raise ProviderError('Douyin room page format unavailable')


def select_stream(streams, quality='HD1'):
    tiers = tuple(dict.fromkeys((quality, *QUALITIES)))
    for fmt, field in (('flv', 'flv_pull_url'), ('hls', 'hls_pull_url_map')):
        mapping = streams.get(field) or {}
        if not isinstance(mapping, dict):
            continue
        for tier in tiers:
            if mapping.get(tier):
                try:
                    return Stream(net.media_url(mapping[tier], 'douyin', fmt), fmt, tier,
                                  {'Referer': ORIGIN + '/'})
                except ProviderError:
                    continue
    raise ProviderError('Douyin room has no trusted playable stream')


class Douyin:
    def __init__(self, client=None):
        self.client = client or net
        self.warnings = []
        self._identity_lock = threading.Lock()
        self._identities = {}

    def _remember(self, rid, internal, source=''):
        if not re.fullmatch(r'[0-9]{19}', str(internal)):
            return
        with self._identity_lock:
            if len(self._identities) >= 500:
                self._identities.clear()
            self._identities[rid] = (str(internal), source, time.monotonic() + 60)

    def _reflow(self, internal, expected=None, source='', renew=True):
        body = self.client.fetch_douyin_reflow(internal)
        if not isinstance(body, dict) or body.get('status_code') != 0:
            raise ProviderError('Douyin reflow request rejected')
        data = body.get('data')
        room = data.get('room') if isinstance(data, dict) else None
        if not isinstance(room, dict):
            raise ProviderError('Douyin reflow room unavailable')
        owner = room.get('owner') or {}
        rid = str(owner.get('web_rid') or '') if isinstance(owner, dict) else ''
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', rid) or (expected and rid != expected):
            raise ProviderError('Douyin reflow room identity mismatch')
        if str(room.get('id_str') or '') != str(internal):
            raise ProviderError('Douyin reflow internal identity mismatch')
        if room.get('status') in (4, '4'):
            raise RoomOfflineError('Douyin room is offline')
        if room.get('status') not in (2, '2'):
            raise ProviderError('Douyin live status unavailable')
        try:
            row = _row({'room': room, 'web_rid': rid})
        except (AttributeError, TypeError, IndexError):
            raise ProviderError('Douyin reflow metadata unavailable') from None
        if not row or not isinstance(row['streams'], dict):
            raise ProviderError('Douyin reflow stream unavailable')
        # A share identifies a broadcast, not a permanent anchor. An old ended
        # broadcast must never overwrite a concurrently discovered live session.
        if renew:
            self._remember(rid, internal, source)
        return row

    def _shared_room(self, link, expected=None):
        internal = self.client.resolve_douyin_share(link)
        return self._reflow(internal, expected, link)

    def _lookup(self, rid, config):
        with self._identity_lock:
            identity = self._identities.get(rid)
        if identity:
            internal, source, expires = identity
            if source and source not in config.get('share_links', []):
                identity = None
            elif time.monotonic() < expires:
                return self._reflow(internal, rid, source, renew=False)
            elif source:
                return self._shared_room(source, rid)
            else:
                with self._identity_lock:
                    if self._identities.get(rid) == identity:
                        self._identities.pop(rid, None)
        return self._room(rid)

    def _room(self, rid):
        page = self.client.fetch_text(ORIGIN + '/' + rid, headers=HEADERS)
        if '验证码中间页' in page:
            raise ProviderError('Douyin room request requires verification')
        return parse_room_page(page, rid)

    def discover(self, config):
        self.warnings = []
        if not config.get('enabled', False):
            return []
        manual = list(dict.fromkeys(normalize_room(v) for v in config.get('rooms', [])[:100]))
        count = max(0, min(100, int(config.get('count', 20))))
        categories = []
        for category in config.get('categories', [])[:8]:
            category = str(category)
            cid = category if category in CATEGORIES else next((k for k, v in CATEGORIES.items() if v == category), None)
            if cid is None:
                raise ProviderError('Invalid Douyin category')
            if cid not in categories:
                categories.append(cid)
        rows, errors = [], 0
        deadline = time.monotonic() + 45

        def failed(error, message):
            nonlocal errors
            if isinstance(error, RoomOfflineError):
                return
            if isinstance(error, TimeoutError):
                message = 'Discovery time budget reached; remaining requests deferred'
            elif not isinstance(error, ProviderError):
                raise error
            errors += 1
            if message not in self.warnings:
                self.warnings.append(message)

        # Resolve configured share links first so matching manual web IDs can use
        # the API path without requesting the captcha-protected HTML page.
        links = list(dict.fromkeys(config.get('share_links', [])[:100]))
        shared_ids = set()
        for _, row, error in fan_out(self._shared_room, links, deadline):
            if error is None:
                rows.append(row)
                shared_ids.add(row['id'])
            else:
                failed(error, 'A Douyin share link could not be fetched')
        # Reflow remembers identities only after checking the response. Manual
        # lookup can reuse the mapping, including a confirmed offline result.
        remaining_manual = [rid for rid in manual if rid not in shared_ids]
        for _, row, error in fan_out(lambda rid: self._lookup(rid, config), remaining_manual, deadline):
            if error is None:
                rows.append(row)
            else:
                failed(error, 'A manual Douyin room could not be fetched')
        min_viewers = int(config.get('min_viewers', 0))

        def category_rows(cid):
            return parse_category_page(self.client.fetch_text(ORIGIN + '/categorynew/4_' + cid, headers=HEADERS), cid)

        buckets = []
        for _, batch, error in fan_out(category_rows, categories if count else [], deadline):
            if error is None:
                for item in batch:
                    with self._identity_lock:
                        previous = self._identities.get(item['id'])
                    self._remember(item['id'], item['key'], previous[1] if previous else '')
                buckets.append(sorted((r for r in batch if r['viewers'] >= min_viewers),
                                      key=lambda r: r['viewers'], reverse=True))
            else:
                failed(error, 'A Douyin category could not be fetched')
        channels, seen = [], set()
        def add(row):
            if row['key'] in seen:
                return False
            try:
                select_stream(row['streams'], config.get('quality', 'HD1'))
            except ProviderError:
                if 'A Douyin room has no trusted stream' not in self.warnings:
                    self.warnings.append('A Douyin room has no trusted stream')
                return False
            channels.append(Channel('douyin', row['id'], row['name'], row['title'], row['logo']))
            seen.add(row['key'])
            return True
        for row in rows:
            add(row)
        added = 0
        # Balanced round-robin among chosen categories, highest-popularity head first.
        while any(buckets) and added < count:
            for bucket in sorted((b for b in buckets if b), key=lambda b: b[0]['viewers'], reverse=True):
                if added >= count:
                    break
                added += int(add(bucket.pop(0)))
        if not channels and errors:
            raise ProviderError('Douyin discovery failed')
        return channels

    def resolve(self, room_id, config):
        row = self._lookup(normalize_room(room_id), config)
        return select_stream(row['streams'], config.get('quality', 'HD1'))
