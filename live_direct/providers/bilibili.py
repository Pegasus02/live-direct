"""Independent fixed-host Bilibili API provider.

API/selection reference: akiralereal/iptv (GPL-3.0),
https://github.com/akiralereal/iptv/blob/e475b2f6d24029f844ada2b362d703c8b88c2e9b/extractors/bilibili-live/api.js
Copyright upstream contributors; derivative distributed under GPL-3.0.
No real-url GPL-2.0 implementation copied.
"""
import re
import time
from urllib.parse import urlencode

from .. import net
from ..models import Channel, Stream, ProviderError, RoomOfflineError

API = 'https://api.live.bilibili.com'
REFERER = 'https://live.bilibili.com/'
DEFAULTS = {'enabled': False, 'rooms': [], 'areas': [], 'top_per_area': 5,
            'min_online': 0, 'quality': 10000, 'prefer_avc': True, 'sessdata': ''}


def normalize_room(value):
    text = str(value).strip()
    if '://' in text:
        p = net.validate_url(text, {'live.bilibili.com'})
        if p.query:
            raise ProviderError('Invalid Bilibili room identifier')
        text = p.path.strip('/')
        if text.startswith('h5/'):
            text = text[3:]
    if not re.fullmatch(r'[0-9]{1,20}', text) or int(text) <= 0:
        raise ProviderError('Invalid Bilibili room identifier')
    return str(int(text))


def select_stream(data, prefer_avc=True):
    candidates = []
    try:
        streams = data['playurl_info']['playurl']['stream']
    except (KeyError, TypeError):
        raise ProviderError('Bilibili play data unavailable') from None
    for stream in streams or []:
        protocol = stream.get('protocol_name')
        for fmt in stream.get('format') or []:
            name = fmt.get('format_name')
            kind = 'flv' if protocol == 'http_stream' and name == 'flv' else (
                'hls' if protocol == 'http_hls' and name in ('ts', 'fmp4') else None)
            if kind is None:
                continue
            for codec in fmt.get('codec') or []:
                cname = codec.get('codec_name')
                if cname not in ('avc', 'hevc'):
                    continue
                for host in codec.get('url_info') or []:
                    try:
                        # Literal concatenation preserves signed query bytes.
                        url = net.media_url(host.get('host', '') + codec.get('base_url', '') + host.get('extra', ''),
                                            'bilibili', kind)
                    except (ProviderError, TypeError):
                        continue
                    rank = (0 if cname == 'avc' else 1, 0 if kind == 'flv' else 1) if prefer_avc else (
                        0 if kind == 'flv' else 1, 0 if cname == 'hevc' else 1)
                    candidates.append((rank, Stream(url, kind, str(codec.get('current_qn') or ''),
                                                     {'Referer': REFERER})))
    if not candidates:
        raise ProviderError('Bilibili room has no trusted playable stream')
    return min(candidates, key=lambda c: c[0])[1]


class Bilibili:
    def __init__(self, client=None):
        self.client = client or net
        self.warnings = []

    def _api(self, path, params, config):
        headers = {'Referer': REFERER, 'Accept': 'application/json'}
        session = config.get('sessdata') or ''
        if session:
            if not isinstance(session, str) or len(session) > 4096 or re.search(r'[\s;\x00-\x1f\x7f]', session):
                raise ProviderError('Invalid Bilibili session configuration')
            headers['Cookie'] = 'SESSDATA=' + session
        # Paths are private constants, never supplied by callers or API responses.
        payload = self.client.fetch_json(API + path + '?' + urlencode(params), headers=headers)
        if not isinstance(payload, dict) or payload.get('code') != 0:
            if isinstance(payload, dict) and payload.get('code') == -352:
                raise ProviderError('Bilibili API risk control; anonymous access unavailable')
            raise ProviderError('Bilibili API request failed')
        return payload.get('data')

    def _room(self, rid, config):
        data = self._api('/room/v1/Room/get_info', {'room_id': rid}, config)
        if not isinstance(data, dict) or 'live_status' not in data:
            raise ProviderError('Bilibili room info unavailable')
        if data['live_status'] != 1:
            raise RoomOfflineError('Bilibili room is offline')
        canonical = normalize_room(data.get('room_id') or rid)
        return Channel('bilibili', canonical, str(data.get('uname') or 'Bilibili ' + canonical),
                       str(data.get('title') or ''), str(data.get('user_cover') or data.get('keyframe') or ''))

    def discover(self, config):
        self.warnings = []
        if not config.get('enabled', False):
            return []
        channels, seen, errors = [], set(), 0
        deadline = time.monotonic() + 45
        manual = list(dict.fromkeys(normalize_room(v) for v in config.get('rooms', [])[:100]))
        def add(rid, name='', logo=''):
            nonlocal errors
            if time.monotonic() >= deadline:
                errors += 1
                if 'Discovery time budget reached' not in self.warnings:
                    self.warnings.append('Discovery time budget reached')
                return
            try:
                channel = self._room(rid, config)
                if channel.room_id not in seen:
                    channels.append(Channel(channel.platform, channel.room_id, name or channel.name,
                                            channel.title, logo or channel.logo))
                    seen.add(channel.room_id)
            except RoomOfflineError:
                pass
            except ProviderError:
                errors += 1
                self.warnings.append('A Bilibili room could not be fetched')
        for rid in manual:
            add(rid)
        areas = list(dict.fromkeys(str(v) for v in config.get('areas', [])[:16]))
        count = max(0, min(50, int(config.get('top_per_area', 5))))
        if areas and count:
            area_map = {}
            if any(not re.fullmatch(r'[0-9]{1,4}', a) for a in areas):
                raw_areas = self._api('/room/v1/Area/getList', {}, config)
                if not isinstance(raw_areas, list):
                    raise ProviderError('Bilibili area list unavailable')
                area_map = {str(a.get('name')): str(a.get('id')) for a in raw_areas if isinstance(a, dict)}
            for area in areas:
                if time.monotonic() >= deadline:
                    errors += 1
                    self.warnings.append('Discovery time budget reached')
                    break
                aid = area if re.fullmatch(r'[0-9]{1,4}', area) else area_map.get(area)
                if aid is None:
                    raise ProviderError('Unknown Bilibili parent area')
                try:
                    rows = self._api('/room/v1/Area/getRoomList', {
                        'platform': 'web', 'parent_area_id': aid, 'area_id': 0,
                        'sort_type': 'online', 'page': 1, 'page_size': min(count * 2, 50)}, config)
                    if not isinstance(rows, list):
                        raise ProviderError('Bilibili area data unavailable')
                    accepted = 0
                    for row in rows:
                        if not isinstance(row, dict):
                            continue
                        try:
                            online = int(row.get('online', 0))
                            rid = normalize_room(row.get('roomid', ''))
                        except (ValueError, TypeError):
                            continue
                        if online < int(config.get('min_online', 0)) or rid in seen:
                            continue
                        before = len(channels)
                        add(rid, str(row.get('uname') or ''), str(row.get('face') or ''))
                        accepted += int(len(channels) > before)
                        if accepted >= count:
                            break
                except ProviderError:
                    errors += 1
                    self.warnings.append('A Bilibili area could not be fetched')
        if not channels and errors:
            raise ProviderError('Bilibili discovery failed')
        return channels

    def resolve(self, room_id, config):
        rid = normalize_room(room_id)
        info = self._room(rid, config)
        wanted = int(config.get('quality', 10000))
        def play(qn):
            return self._api('/xlive/web-room/v2/index/getRoomPlayInfo', {
                'room_id': info.room_id, 'protocol': '0,1', 'format': '0,1,2',
                'codec': '0,1', 'qn': qn, 'platform': 'web', 'ptype': 8}, config)
        data = play(wanted or 10000)
        stream = select_stream(data, config.get('prefer_avc', True))
        if wanted == 0 and int(stream.quality or 0) >= 10000:
            # Highest means the highest advertised tier, but never retry a
            # silently downgraded anonymous request or trust arbitrary qn text.
            accepted = []
            for protocol in data.get('playurl_info', {}).get('playurl', {}).get('stream', []):
                for fmt in protocol.get('format') or []:
                    for codec in fmt.get('codec') or []:
                        accepted.extend(q for q in codec.get('accept_qn') or []
                                        if isinstance(q, int) and 0 < q <= 30000)
            highest = max(accepted, default=0)
            if highest > int(stream.quality):
                stream = select_stream(play(highest), config.get('prefer_avc', True))
        return stream

    @staticmethod
    def session_status(config):
        # Neither successful playback nor presence of a cookie validates login.
        return {'configured': bool(config.get('sessdata')), 'validated': False}
