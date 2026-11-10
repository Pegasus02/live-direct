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
from ._pool import fan_out

API = 'https://api.live.bilibili.com'
PASSPORT_API = 'https://passport.bilibili.com'
REFERER = 'https://live.bilibili.com/'
# CDN candidates probed per resolve before falling back to the best-ranked one.
PROBE_LIMIT = 4
# Common parent areas offered as shortcuts; other names/IDs still resolve via the area list API.
AREAS = {'2': '网游', '3': '手游', '6': '单机游戏', '1': '娱乐', '5': '电台', '9': '虚拟主播',
         '10': '生活', '11': '知识', '13': '赛事'}
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


def rank_streams(data, prefer_avc=True, formats=('flv', 'hls')):
    """Every trusted candidate, best first; equal ranks keep the API's host order."""
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
            if kind not in formats:
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
    return [stream for _, stream in sorted(candidates, key=lambda c: c[0])]


def select_stream(data, prefer_avc=True, formats=('flv', 'hls')):
    return rank_streams(data, prefer_avc, formats)[0]


class Bilibili:
    # resolve() accepts formats=('hls',) for players without FLV support.
    hls = True

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

        def warn(message):
            if message not in self.warnings:
                self.warnings.append(message)

        def add(channel):
            if channel.room_id not in seen:
                channels.append(channel)
                seen.add(channel.room_id)

        def failed(error, message):
            nonlocal errors
            if isinstance(error, RoomOfflineError):
                return
            if isinstance(error, TimeoutError):
                errors += 1
                warn('Discovery time budget reached')
            elif isinstance(error, ProviderError):
                errors += 1
                warn(message)
            else:
                raise error

        manual = list(dict.fromkeys(normalize_room(v) for v in config.get('rooms', [])[:100]))
        for _, channel, error in fan_out(lambda rid: self._room(rid, config), manual, deadline):
            if error is None:
                add(channel)
            else:
                failed(error, 'A Bilibili room could not be fetched')
        areas = list(dict.fromkeys(str(v) for v in config.get('areas', [])[:16]))
        count = max(0, min(50, int(config.get('top_per_area', 5))))
        if areas and count:
            area_map = {}
            if any(not re.fullmatch(r'[0-9]{1,4}', a) for a in areas):
                raw_areas = self._api('/room/v1/Area/getList', {}, config)
                if not isinstance(raw_areas, list):
                    raise ProviderError('Bilibili area list unavailable')
                area_map = {str(a.get('name')): str(a.get('id')) for a in raw_areas if isinstance(a, dict)}
            area_ids = []
            for area in areas:
                aid = area if re.fullmatch(r'[0-9]{1,4}', area) else area_map.get(area)
                if aid is None:
                    raise ProviderError('Unknown Bilibili parent area')
                area_ids.append(aid)
            min_online = int(config.get('min_online', 0))

            def area_rows(aid):
                rows = self._api('/room/v1/Area/getRoomList', {
                    'platform': 'web', 'parent_area_id': aid, 'area_id': 0,
                    'sort_type': 'online', 'page': 1, 'page_size': min(count * 2, 50)}, config)
                if not isinstance(rows, list):
                    raise ProviderError('Bilibili area data unavailable')
                return rows

            for _, rows, error in fan_out(area_rows, area_ids, deadline):
                if error is not None:
                    failed(error, 'A Bilibili area could not be fetched')
                    continue
                accepted = 0
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    try:
                        online = int(row.get('online', 0))
                        rid = normalize_room(row.get('roomid', ''))
                    except (ValueError, TypeError):
                        continue
                    if online < min_online or rid in seen:
                        continue
                    # The area list only contains live rooms and already carries
                    # canonical IDs and metadata; no per-room get_info round trip.
                    add(Channel('bilibili', rid, str(row.get('uname') or 'Bilibili ' + rid),
                                str(row.get('title') or ''), str(row.get('face') or row.get('user_cover') or '')))
                    accepted += 1
                    if accepted >= count:
                        break
        if not channels and errors:
            raise ProviderError('Bilibili discovery failed')
        return channels

    def resolve(self, room_id, config, formats=('flv', 'hls')):
        rid = normalize_room(room_id)
        wanted = int(config.get('quality', 10000))
        def play(qn):
            # getRoomPlayInfo reports live_status itself, so one request per switch.
            data = self._api('/xlive/web-room/v2/index/getRoomPlayInfo', {
                'room_id': rid, 'protocol': '0,1', 'format': '0,1,2',
                'codec': '0,1', 'qn': qn, 'platform': 'web', 'ptype': 8}, config)
            if not isinstance(data, dict):
                raise ProviderError('Bilibili play data unavailable')
            if 'live_status' in data and data['live_status'] != 1:
                raise RoomOfflineError('Bilibili room is offline')
            return data
        prefer_avc = config.get('prefer_avc', True)
        data = play(wanted or 10000)
        stream = select_stream(data, prefer_avc, formats)
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
                data = play(highest)
        return self._reachable(rank_streams(data, prefer_avc, formats))

    def _reachable(self, streams):
        # Players follow the 302 without Referer: some cn-* FLV nodes then answer
        # 403, and some gotcha nodes fail TLS on certain networks. Take the first
        # candidate that answers a header-less HEAD, else keep the best-ranked.
        for stream in streams[:PROBE_LIMIT]:
            if self.client.probe_media(stream.url, 'bilibili', stream.format):
                return stream
        return streams[0]

    def qrcode_generate(self):
        payload = self.client.fetch_json(PASSPORT_API + '/x/passport-login/web/qrcode/generate', headers={'Accept': 'application/json'})
        if not isinstance(payload, dict) or payload.get('code') != 0:
            raise ProviderError('Bilibili QR generate failed')
        data = payload.get('data') or {}
        url = data.get('url')
        key = data.get('qrcode_key')
        if not url or not key or not isinstance(url, str) or not isinstance(key, str):
            raise ProviderError('Invalid Bilibili QR payload')
        return {'url': url, 'qrcode_key': key}

    def qrcode_poll(self, qrcode_key):
        if not isinstance(qrcode_key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,128}', qrcode_key):
            raise ProviderError('Invalid qrcode_key')
        headers, payload = self.client.fetch_json_with_headers(
            PASSPORT_API + '/x/passport-login/web/qrcode/poll?' + urlencode({'qrcode_key': qrcode_key}),
            headers={'Accept': 'application/json'}
        )
        if not isinstance(payload, dict) or payload.get('code') != 0:
            raise ProviderError('Bilibili QR poll failed')
        data = payload.get('data') or {}
        code = data.get('code')
        if code == 86101:
            return {'status': 'waiting', 'message': '未扫码'}
        if code == 86090:
            return {'status': 'scanned', 'message': '已扫码，请在手机上确认'}
        if code == 86038:
            return {'status': 'expired', 'message': '二维码已失效'}
        if code == 0:
            sessdata = None
            for hname, hval in headers:
                if hname.lower() == 'set-cookie':
                    m = re.search(r'(?:^|;\s*)SESSDATA=([^;]+)', hval)
                    if m:
                        sessdata = m.group(1)
                        break
            if not sessdata and isinstance(data.get('url'), str):
                # Keep the raw percent-encoded value exactly as a cookie would carry
                # it; decoding turns %2C into commas that the config store rejects.
                m = re.search(r'[?&]SESSDATA=([^&#]+)', data['url'])
                if m:
                    sessdata = m.group(1)
            if not sessdata or not isinstance(sessdata, str) or len(sessdata) > 4096 or re.search(r'[\s;\x00-\x1f\x7f]', sessdata):
                raise ProviderError('Failed to extract valid SESSDATA from login response')
            return {'status': 'success', 'sessdata': sessdata, 'message': '登录成功'}
        return {'status': 'error', 'message': str(data.get('message') or '未知状态')}

    @staticmethod
    def session_status(config):
        # Neither successful playback nor presence of a cookie validates login.
        return {'configured': bool(config.get('sessdata')), 'validated': False}
