"""Douyin public Flight pages, no JavaScript evaluation or browser session.

Derived from akiralereal/iptv extractors/douyin-live/api.js and index.js
(GPL-3.0), including supplied local working copies. Upstream reference:
https://github.com/akiralereal/iptv/tree/e475b2f6d24029f844ada2b362d703c8b88c2e9b/extractors/douyin-live
Copyright upstream contributors; derivative distributed under GPL-3.0.
"""
import json
import re

from . import common
from .. import net
from ..models import Channel, Stream, ProviderError, RoomOfflineError

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

    def _room(self, rid):
        return parse_room_page(self.client.fetch_text(ORIGIN + '/' + rid, headers=HEADERS), rid)

    def discover(self, config):
        self.warnings = []
        if not config.get('enabled', False):
            return []
        manual = list(dict.fromkeys(normalize_room(v) for v in config.get('rooms', [])[:100]))
        count = max(0, min(100, int(config.get('count', 20))))
        categories = common.category_ids(config.get('categories', []), CATEGORIES, 'Douyin')

        def category(cid):
            return parse_category_page(self.client.fetch_text(ORIGIN + '/categorynew/4_' + cid, headers=HEADERS), cid)

        def accept(row):
            try:
                select_stream(row['streams'], config.get('quality', 'HD1'))
                return True
            except ProviderError:
                self.warnings.append('A Douyin room has no trusted stream')
                return False
        return common.discover('douyin', 'Douyin', self.warnings, manual, self._room, categories, category,
                               count, int(config.get('min_viewers', 0)), accept)

    def resolve(self, room_id, config):
        row = self._room(normalize_room(room_id))
        return select_stream(row['streams'], config.get('quality', 'HD1'))
