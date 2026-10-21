"""Huya public room/category pages, no JavaScript evaluation or browser session.

Page parsing, bitrate selection and the anonymous web anti-code signature are
adapted from akiralereal/iptv extractors/huya-live/api.js (GPL-3.0),
https://github.com/akiralereal/iptv/blob/e475b2f6d24029f844ada2b362d703c8b88c2e9b/extractors/huya-live/api.js
Copyright upstream contributors; derivative distributed under GPL-3.0.
Upstream relays HLS through its server; this module signs the FLV line instead
so the player can be redirected straight to the official CDN.
No real-url GPL-2.0 implementation copied.
"""
import base64
import binascii
import hashlib
import re
import threading
import time
from urllib.parse import parse_qsl, urlencode

from . import common
from .. import net
from ..models import ProviderError, RoomOfflineError, Stream

ORIGIN = 'https://www.huya.com'
REFERER = ORIGIN + '/'
CATEGORIES = {'100023': '网游', '100004': '手游', '100002': '单机', '100022': '娱乐'}
# 0 is the original stream; 2K/4K are extra transcodes on top of it for some rooms.
QUALITIES = (0, 20000, 14000, 4000, 2000, 500)
DEFAULTS = {'enabled': False, 'rooms': [], 'categories': [], 'count': 10,
            'min_viewers': 0, 'quality': 0}
HEADERS = {'Referer': REFERER, 'Accept': 'text/html', 'Accept-Language': 'zh-CN'}
HIGH_RES = 10000
# Repeat requests for a room within this window start from the next CDN line.
RETRY_WINDOW = 120


def normalize_room(value):
    text = str(value).strip()
    if '://' in text:
        p = net.validate_url(text, {'www.huya.com', 'huya.com'})
        if p.query:
            raise ProviderError('Invalid Huya room identifier')
        text = p.path.strip('/')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', text) or text.lower() in ('g', 'm', 'l'):
        raise ProviderError('Invalid Huya room identifier')
    return text


def _md5(text):
    return hashlib.md5(text.encode()).hexdigest()


def parse_category_page(page, category=''):
    marker = re.search(r'var\s+ALL_LIST_DATA\s*=\s*', page)
    if not marker:
        raise ProviderError('Huya category page format unavailable')
    rows = common.assigned_json(page, marker.end())
    if not isinstance(rows, list):
        raise ProviderError('Huya category page format unavailable')
    result = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            rid = normalize_room(row.get('lProfileRoom') or row.get('sPrivateHost') or '')
        except ProviderError:
            continue
        nick, title = common.clean(row.get('sNick')), common.clean(row.get('sIntroduction') or row.get('sRoomName'))
        result.append({'id': rid, 'key': rid, 'name': nick or title or 'Huya ' + rid, 'title': title,
                       'logo': str(row.get('sScreenshot') or row.get('sAvatar180') or ''),
                       'viewers': common.parse_heat(row.get('lTotalCount') or row.get('lUserCount') or 0),
                       'category': category})
    return result


def parse_room_page(page, requested_id):
    """Read only hyPlayerConfig.stream; the surrounding object is script, not JSON."""
    config_at = page.find('var hyPlayerConfig')
    marker = re.compile(r'\bstream\s*:\s*').search(page, config_at) if config_at >= 0 else None
    if not marker:
        # Missing player data can be an anti-bot response; never claim this is offline.
        raise ProviderError('Huya room page format unavailable')
    if page[marker.end():marker.end() + 1] in ('"', "'", 'n'):
        raise RoomOfflineError('Huya room is offline')
    stream = common.assigned_json(page, marker.end())
    rows = stream.get('data') if isinstance(stream, dict) else None
    row = next((r for r in rows or [] if isinstance(r, dict) and r.get('gameStreamInfoList')), None)
    if row is None or not isinstance(row.get('gameStreamInfoList'), list):
        raise RoomOfflineError('Huya room is offline')
    info = row.get('gameLiveInfo') or {}
    rid = normalize_room(str(info.get('profileRoom') or requested_id))
    nick, title = common.clean(info.get('nick')), common.clean(info.get('introduction') or info.get('roomName'))
    return {'id': rid, 'key': rid, 'name': nick or title or 'Huya ' + rid, 'title': title,
            'logo': str(info.get('screenshot') or info.get('avatar180') or ''),
            'viewers': common.parse_heat(info.get('totalCount') or 0),
            'uid': str(info.get('uid') or '0'), 'lines': row['gameStreamInfoList'],
            'bitrates': stream.get('vMultiStreamInfo') or []}


def select_bitrate(rows, requested=0):
    # HDR tiers (non-zero iCompatibleFlag) are not served on these web lines.
    rates = sorted({r['iBitRate'] for r in rows if isinstance(r, dict) and not r.get('iCompatibleFlag')
                    and type(r.get('iBitRate')) is int and r['iBitRate'] > 0}, reverse=True)
    if requested == 0:
        return rates[0] if rates and rates[0] >= HIGH_RES else 0
    if requested >= HIGH_RES:
        # Asked for 2K/4K but the room lacks it: original, never below original.
        return next((r for r in rates if HIGH_RES <= r <= requested), 0)
    if not rates:
        return requested
    return next((r for r in rates if r <= requested), rates[-1])


def sign_url(line, uid, bitrate, fmt, now_ms):
    """Re-sign the page anti-code: base64 `fm` is a template with $0..$3 slots."""
    prefix = 'sFlv' if fmt == 'flv' else 'sHls'
    name, base = line.get('sStreamName'), line.get(prefix + 'Url')
    suffix, anti = line.get(prefix + 'UrlSuffix') or fmt.replace('hls', 'm3u8'), line.get(prefix + 'AntiCode')
    if not all(isinstance(v, str) and v for v in (name, base, suffix, anti)) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,200}', name):
        raise ProviderError('Huya line unavailable')
    old = parse_qsl(anti.replace('&amp;', '&'), keep_blank_values=True)
    values = dict(old)
    ws_time, ctype = values.get('wsTime', ''), values.get('ctype') or 'huya_webh5'
    try:
        template = base64.b64decode(values.get('fm', '').replace(' ', '+'), validate=True).decode()
    except (binascii.Error, UnicodeError):
        raise ProviderError('Huya line signature unavailable') from None
    if not re.fullmatch(r'[0-9a-fA-F]{1,16}', ws_time) or '$1' not in template:
        raise ProviderError('Huya line signature unavailable')
    seqid, platform = str(now_ms), '100'
    secret = _md5(template.replace('$0', uid).replace('$1', name)
                  .replace('$2', _md5(seqid + '|' + ctype + '|' + platform)).replace('$3', ws_time))
    replaced = {'wsSecret', 'wsTime', 'fm', 'seqid', 'ctype', 'ver', 'ratio', 'u', 't'}
    params = [('wsSecret', secret), ('wsTime', ws_time), ('seqid', seqid), ('ctype', ctype), ('ver', '1')]
    params += [(k, v) for k, v in old if k not in replaced]
    if bitrate > 0:
        params.append(('ratio', str(bitrate)))
    params += [('u', uid), ('t', platform)]
    url = base.rstrip('/') + '/' + name + '.' + suffix.lstrip('.') + '?' + urlencode(params)
    return net.media_url(url, 'huya', fmt)


def select_stream(room, quality=0, start=0, now_ms=None):
    """FLV on any line first, then HLS; `start` rotates which CDN line leads."""
    lines = [line for line in room['lines'] if isinstance(line, dict)]
    if not lines:
        raise ProviderError('Huya room has no trusted playable stream')
    start %= len(lines)
    ordered = lines[start:] + lines[:start]
    bitrate = select_bitrate(room['bitrates'], quality)
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    for fmt in ('flv', 'hls'):
        for line in ordered:
            try:
                return Stream(sign_url(line, room['uid'], bitrate, fmt, now_ms), fmt,
                              str(bitrate or 'origin'), {'Referer': REFERER})
            except ProviderError:
                continue
    raise ProviderError('Huya room has no trusted playable stream')


class Huya:
    # Engine keeps a successful redirect this long. Requests a player fires while
    # starting one playback reuse it; a reconnect after that resolves again and
    # so can land on another line. This spreads retries over the advertised
    # lines; a repeat request is not treated as proof that a line has failed.
    cache_ttl = 5

    def __init__(self, client=None):
        self.client = client or net
        self.warnings = []
        self.lock = threading.Lock()
        self.recent = {}

    def _room(self, rid):
        return parse_room_page(self.client.fetch_text(ORIGIN + '/' + rid, headers=HEADERS), rid)

    def _line_start(self, rid):
        # Some Huya lines start refusing one client after a few minutes while the
        # others keep serving it, so a repeat request starts from the next line.
        now = time.monotonic()
        with self.lock:
            at, index = self.recent.get(rid, (0, -1))
            index = index + 1 if now - at < RETRY_WINDOW else 0
            self.recent = {k: v for k, v in self.recent.items() if now - v[0] < RETRY_WINDOW}
            if len(self.recent) < 512:
                self.recent[rid] = (now, index)
            return index

    def discover(self, config):
        self.warnings = []
        if not config.get('enabled', False):
            return []
        manual = list(dict.fromkeys(normalize_room(v) for v in config.get('rooms', [])[:100]))
        count = max(0, min(100, int(config.get('count', 10))))
        categories = common.category_ids(config.get('categories', []), CATEGORIES, 'Huya')

        def category(cid):
            return parse_category_page(self.client.fetch_text(ORIGIN + '/g/' + cid, headers=HEADERS), cid)
        return common.discover('huya', 'Huya', self.warnings, manual, self._room, categories, category,
                               count, int(config.get('min_viewers', 0)))

    def resolve(self, room_id, config):
        room = self._room(normalize_room(room_id))
        return select_stream(room, int(config.get('quality', 0)), self._line_start(room['id']))
