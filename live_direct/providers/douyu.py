"""Douyu fixed-host web APIs, no JavaScript evaluation or browser session.

Category listing and room data follow akiralereal/iptv extractors/douyu-live/api.js
(GPL-3.0), https://github.com/akiralereal/iptv/blob/e475b2f6d24029f844ada2b362d703c8b88c2e9b/extractors/douyu-live/api.js
Copyright upstream contributors; derivative distributed under GPL-3.0.
Upstream signs with the page's dynamic ub98484234 script; this module instead
uses the web player's websec key exchange (plain MD5 rounds), as documented
in public stream-recorder projects, so no remote code is ever executed.
No real-url GPL-2.0 implementation copied.
"""
import hashlib
import re
import time

from . import common
from .. import net
from ..models import ProviderError, RoomOfflineError, Stream

ORIGIN = 'https://www.douyu.com'
PLAY_API = 'https://playweb.douyucdn.cn'
REFERER = ORIGIN + '/'
# Anonymous web-player device id, not an account credential; the official
# player falls back to the same value when it has no dy_did cookie.
DID = '10000000000000000000000000001501'
PLAYER_VERSION = '219032101'
CATEGORIES = {'1_1': '网游竞技', '1_15': '单机热游', '1_9': '手游休闲', '1_2': '娱乐'}
# rate 0 is the original stream; anonymous requests may be capped lower by Douyu.
QUALITIES = (0, 4, 3, 2)
DEFAULTS = {'enabled': False, 'rooms': [], 'categories': [], 'count': 10,
            'min_viewers': 0, 'quality': 0}
HEADERS = {'Referer': REFERER, 'Accept': 'application/json'}


def normalize_room(value):
    text = str(value).strip()
    if '://' in text:
        p = net.validate_url(text, {'www.douyu.com', 'douyu.com'})
        if p.query:
            raise ProviderError('Invalid Douyu room identifier')
        text = p.path.strip('/')
    if not re.fullmatch(r'[0-9]{1,12}', text) or int(text) <= 0:
        raise ProviderError('Invalid Douyu room identifier')
    return str(int(text))


def _md5(text):
    return hashlib.md5(text.encode()).hexdigest()


def sign(key_data, rid, now):
    """Return the getH5PlayV1 form for a websec getEncryption response."""
    try:
        rand, key, rounds, enc = (key_data['rand_str'], key_data['key'],
                                  key_data['enc_time'], key_data['enc_data'])
    except (KeyError, TypeError):
        raise ProviderError('Douyu play key unavailable') from None
    if not all(isinstance(v, str) and 0 < len(v) <= 4096 for v in (rand, key, enc)) or (
            type(rounds) is not int or not 0 <= rounds <= 64):
        raise ProviderError('Douyu play key unavailable')
    secret = rand
    for _ in range(rounds):
        secret = _md5(secret + key)
    salt = '' if key_data.get('is_special') else rid + str(now)
    return {'enc_data': enc, 'tt': str(now), 'did': DID, 'auth': _md5(secret + key + salt)}


def parse_category(payload, category=''):
    if not isinstance(payload, dict) or payload.get('code') != 0:
        raise ProviderError('Douyu category data unavailable')
    rows = (payload.get('data') or {}).get('rl')
    if not isinstance(rows, list):
        raise ProviderError('Douyu category data unavailable')
    result = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            rid = normalize_room(row.get('rid', ''))
        except ProviderError:
            continue
        nick, title = common.clean(row.get('nn')), common.clean(row.get('rn'))
        result.append({'id': rid, 'key': rid, 'name': nick or title or 'Douyu ' + rid, 'title': title,
                       'logo': str(row.get('rs16') or ''), 'viewers': common.parse_heat(row.get('ol')),
                       'category': category})
    return result


def parse_room(payload):
    room = payload.get('room') if isinstance(payload, dict) else None
    if not isinstance(room, dict) or 'show_status' not in room:
        raise ProviderError('Douyu room info unavailable')
    # show_status 1 is live; videoLoop marks a replay loop rather than a broadcast.
    if room.get('show_status') not in (1, '1') or room.get('videoLoop') in (1, '1'):
        raise RoomOfflineError('Douyu room is offline')
    rid = normalize_room(room.get('room_id', ''))
    nick, title = common.clean(room.get('nickname')), common.clean(room.get('room_name'))
    return {'id': rid, 'key': rid, 'name': nick or 'Douyu ' + rid, 'title': title,
            'logo': str(room.get('room_pic') or ''), 'viewers': 0}


def stream_from(data):
    """Join the FLV base and signed stream name exactly as the web player does."""
    if not isinstance(data, dict):
        raise ProviderError('Douyu play data unavailable')
    base, live = data.get('rtmp_url'), data.get('rtmp_live')
    if not isinstance(base, str) or not isinstance(live, str) or not base or not live:
        raise ProviderError('Douyu play data unavailable')
    url = net.media_url(base.rstrip('/') + '/' + live.lstrip('/'), 'douyu', 'flv')
    # The stream name suffix (e.g. _2000) is the delivered bitrate; none means original.
    tier = re.search(r'_([0-9]{3,5})\.flv(?:\?|$)', live)
    return Stream(url, 'flv', tier.group(1) if tier else 'origin', {'Referer': REFERER})


class Douyu:
    def __init__(self, client=None):
        self.client = client or net
        self.warnings = []

    def _room(self, rid):
        return parse_room(self.client.fetch_json(ORIGIN + '/betard/' + rid, headers=HEADERS))

    def _play(self, rid, rate, cdn=None):
        payload = self.client.fetch_json(ORIGIN + '/wgapi/livenc/liveweb/websec/getEncryption?did=' + DID,
                                         headers=HEADERS)
        if not isinstance(payload, dict) or payload.get('error') != 0:
            raise ProviderError('Douyu play key unavailable')
        form = sign(payload.get('data'), rid, int(time.time()))
        form.update({'rate': str(rate), 'ver': PLAYER_VERSION, 'iar': '0', 'ive': '0', 'rid': rid,
                     'hevc': '0', 'fa': '0', 'sov': '0'})
        if cdn:
            form['cdn'] = cdn
        headers = dict(HEADERS, Origin=ORIGIN)
        # Path is a private constant plus a normalized numeric room id.
        payload = self.client.fetch_json(PLAY_API + '/lapi/live/getH5PlayV1/' + rid, headers=headers, form=form)
        if not isinstance(payload, dict) or payload.get('error') != 0:
            raise ProviderError('Douyu play API request failed')
        return payload.get('data')

    def discover(self, config):
        self.warnings = []
        if not config.get('enabled', False):
            return []
        manual = list(dict.fromkeys(normalize_room(v) for v in config.get('rooms', [])[:100]))
        count = max(0, min(100, int(config.get('count', 10))))
        categories = common.category_ids(config.get('categories', []), CATEGORIES, 'Douyu')

        def category(cid):
            return parse_category(self.client.fetch_json(
                ORIGIN + '/gapi/rkc/directory/mixListV1/' + cid + '/1', headers=HEADERS), cid)
        return common.discover('douyu', 'Douyu', self.warnings, manual, self._room, categories, category,
                               count, int(config.get('min_viewers', 0)))

    def resolve(self, room_id, config):
        rid = self._room(normalize_room(room_id))['id']
        data = self._play(rid, int(config.get('quality', 0)))
        try:
            return stream_from(data)
        except ProviderError:
            pass
        # The default line was not a trusted HTTPS CDN; ask for the other advertised lines.
        lines = data.get('cdnsWithName') if isinstance(data, dict) else None
        current = data.get('rtmp_cdn') if isinstance(data, dict) else None
        for line in (lines if isinstance(lines, list) else [])[:4]:
            cdn = line.get('cdn') if isinstance(line, dict) else None
            if not isinstance(cdn, str) or cdn == current or not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', cdn):
                continue
            try:
                return stream_from(self._play(rid, int(config.get('quality', 0)), cdn))
            except ProviderError:
                continue
        raise ProviderError('Douyu room has no trusted playable stream')
