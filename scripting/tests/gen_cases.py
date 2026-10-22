"""Generate differential cases: run inputs through the Python backend and record
the results, so scripting/tests/run.mjs can check the TypeScript port against them.

    python3 scripting/tests/gen_cases.py > /tmp/cases.json
"""
import base64
import hashlib
import json
import sys
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tests'))

from live_direct import app, config, net  # noqa: E402
from live_direct.models import ProviderError, RoomOfflineError  # noqa: E402
from live_direct.providers import bilibili, common, douyin, douyu, huya  # noqa: E402
from test_providers import Fake, dy_fixture, flight, play_fixture  # noqa: E402

cases = []


def record(fn, args, call):
    try:
        out = call()
        if hasattr(out, '__dataclass_fields__'):
            out = {k: getattr(out, k) for k in out.__dataclass_fields__}
        expect = out
    except RoomOfflineError:
        expect = {'error': 'RoomOfflineError'}
    except ProviderError:
        expect = {'error': 'ProviderError'}
    except config.ConfigError:
        expect = {'error': 'ConfigError'}
    cases.append({'fn': fn, 'args': args, 'expect': expect})


# ---- helpers ----
for text in ['', 'abc', '中文 emoji 😀', 'a' * 1000, 'prefix_$0_$1']:
    record('md5', [text], lambda t=text: hashlib.md5(t.encode()).hexdigest())
for raw in [5, '12.3万', '1.2亿', '1,234', None, True, 'abc', 3.7, '  88 人']:
    record('parseHeat', [raw], lambda r=raw: common.parse_heat(r))
for raw in ['&amp;x&lt;', ' a ', '&#39;q&#x4e2d;', '&unknown; &nbsp;', None]:
    record('clean', [raw], lambda r=raw: common.clean(r))
for src, start in [('x = {"a": "]}", "b": [1]};', 4), ('{"a": 1', 0), ('alert(1)', 0), ("[1, 'x]']", 0), ('{a: 1}', 0)]:
    def aj(s=src, i=start):
        try:
            return common.assigned_json(s, i)
        except ProviderError:
            raise
    record('assignedJson', [src, start], aj)
media = ['http://pull.douyincdn.com/live/a.flv?x=1', 'https://a.douyinliving.com/b.m3u8', 'https://evil.test/a.flv',
         'https://x.douyincdn.com.evil.test/a.flv', 'https://u@pull.douyincdn.com/a.flv', 'https://pull.douyincdn.com:444/a.flv',
         'https://pull.douyincdn.com/a.flv#x', 'https://a.bilivideo.com/live/x.m3u8?sig=1', 'http://hw-tct.douyucdn.cn/live/1.flv',
         'https://al.flv.huya.com/src/a.flv?ws=1', 'https://huya.com/a.m3u8', 'https://pull.douyincdn.com/a b.flv']
for url in media:
    for platform in ('douyin', 'bilibili', 'douyu', 'huya'):
        for fmt in ('flv', 'hls'):
            record('mediaUrl', [url, platform, fmt], lambda u=url, p=platform, f=fmt: net.media_url(u, p, f))
        record('safeMedia', [url, platform], lambda u=url, p=platform: app.safe_media(u, p))
for logo in ['http://p3.douyinpic.com/a.jpg', '//i0.hdslb.com/x.png', 'https://evil.example/x.jpg', 'https://i0.hdslb.com/a".jpg',
             'javascript:alert(1)', 'https://x.hdslb.com.evil.test/a', '', 'https://apic.douyucdn.cn/a.png', 'https://huyaimg.msstatic.com/a.jpg']:
    record('safeLogo', [logo], lambda u=logo: app.safe_logo(u))
for value in ['abc', '  x  ', 'a' * 65]:
    record('cleanText', [value], lambda v=value: app.clean_text(v))

# ---- room normalisation ----
rooms = ['123', ' 0123 ', '0', 'abc_1', 'https://live.douyin.com/abc_1', 'https://live.douyin.com/12?url=evil',
         'https://live.bilibili.com/h5/12', 'https://live.bilibili.com/12/', 'https://www.douyu.com/09999', 'https://douyu.com/1',
         'https://www.huya.com/vanity', 'https://www.huya.com.evil.test/1', 'g', 'G', 'a/b', '１２', 'https://user@live.bilibili.com/12',
         'https://live.bilibili.com:444/12', 'http://www.huya.com/abc', 'https://b23.tv/x', '12345678901234567890', '1234567890123']
mods = {'douyin': douyin, 'bilibili': bilibili, 'douyu': douyu, 'huya': huya}
for platform, mod in mods.items():
    for room in rooms:
        record(platform + '.normalizeRoom', [room], lambda m=mod, r=room: m.normalize_room(r))
        record('config.normalizeRoom', [room, platform], lambda r=room, p=platform: config._room(r, p))
shares = ['https://v.douyin.com/AbC_1/', '复制打开抖音 https://v.douyin.com/AbC_1/ 看直播', 'https://v.douyin.com/AbC_1',
          'https://v.douyin.com/a/ https://v.douyin.com/b/', 'xhttps://v.douyin.com/a/', 'www.x.com https://v.douyin.com/a/',
          'https://evil.test/a/', '（https://v.douyin.com/Zz9/）']
for text in shares:
    record('config.shareLinks', [[text]], lambda t=text: config._share_links([t]))


def validate(cfg):
    import copy
    return config._validate(copy.deepcopy(cfg))


base = json.loads(json.dumps(config.DEFAULTS))
variants = [base]
for patch_ in [{'douyin': {'quality': 'HD9'}}, {'bilibili': {'quality': 150, 'areas': ['网游', '2']}}, {'huya': {'count': 101}},
               {'douyu': {'rooms': ['https://www.douyu.com/0042', '42']}}, {'bilibili': {'sessdata': 'a;b'}},
               {'douyin': {'categories': ['游戏', 'bad id']}}, {'huya': {'quality': 14000, 'min_viewers': 5}}]:
    cfg = json.loads(json.dumps(base))
    for p, fields in patch_.items():
        cfg[p].update(fields)
    variants.append(cfg)
for cfg in variants:
    record('config.validate', [cfg], lambda c=cfg: validate(c))

# ---- Douyu ----
keys = [{'rand_str': 'r', 'key': 'k', 'enc_time': 2, 'enc_data': 'e', 'is_special': 0},
        {'rand_str': 'abc', 'key': 'xyz', 'enc_time': 5, 'enc_data': 'data', 'is_special': 1},
        {'rand_str': 'r', 'key': 'k', 'enc_time': 65, 'enc_data': 'e'}, {'rand_str': '', 'key': 'k', 'enc_time': 1, 'enc_data': 'e'}]
for key in keys:
    record('douyu.sign', [key, '9999', 1700000000], lambda k=key: douyu.sign(k, '9999', 1700000000))
record('douyu.streamFrom', [{'rtmp_url': 'http://hw-tct.douyucdn.cn/live/', 'rtmp_live': '/9999r_2000.flv?wsAuth=x'}],
       lambda: douyu.stream_from({'rtmp_url': 'http://hw-tct.douyucdn.cn/live/', 'rtmp_live': '/9999r_2000.flv?wsAuth=x'}))
record('douyu.streamFrom', [{'rtmp_url': 'http://evil.test/live', 'rtmp_live': '1.flv'}],
       lambda: douyu.stream_from({'rtmp_url': 'http://evil.test/live', 'rtmp_live': '1.flv'}))

# ---- Huya ----
fm = base64.b64encode('prefix_$0_$1_$2_$3_中'.encode()).decode()
line = {'sCdnType': 'AL', 'sStreamName': '1-2-abc', 'sFlvUrl': 'http://al.flv.huya.com/src', 'sFlvUrlSuffix': 'flv',
        'sFlvAntiCode': 'wsSecret=old&amp;wsTime=65f0a1b2&fm=' + fm + '&ctype=huya_live&fs=bgct&sv=a+b%2Fc',
        'sHlsUrl': 'http://al.hls.huya.com/src', 'sHlsUrlSuffix': 'm3u8', 'sHlsAntiCode': 'wsTime=65f0a1b2&fm=' + fm}
second = dict(line, sCdnType='TX', sFlvUrl='https://tx.flv.huya.com/src')
evil = dict(line, sFlvUrl='https://evil.test/src')


def huya_page(lines, bitrates=None, live=True):
    stream = {'data': [{'gameLiveInfo': {'profileRoom': 880, 'uid': 1234, 'nick': 'Fixture &amp; A', 'introduction': 'A "}" title', 'totalCount': '1.5万'},
                        'gameStreamInfoList': lines if live else []}],
              'vMultiStreamInfo': bitrates or [{'iBitRate': 0}, {'iBitRate': 4000}, {'iBitRate': 14100, 'iCompatibleFlag': 1}]}
    return '<script>var hyPlayerConfig = {html5: 1, stream: ' + json.dumps(stream) + ', other: {a: 1}};</script>'


pages = {'two': huya_page([line, second]), 'evil': huya_page([evil]), 'offline': huya_page([line], live=False),
         'hd': huya_page([line], [{'iBitRate': 0}, {'iBitRate': 20000}, {'iBitRate': 14000}, {'iBitRate': 4000}]),
         'empty': '<script>var hyPlayerConfig = {stream: ""};</script>', 'blocked': '<html>verify</html>'}
for name, page in pages.items():
    record('huya.parseRoomPage', [page, '880'], lambda p=page: huya.parse_room_page(p, '880'))
    for quality in (0, 4000, 14000, 20000):
        for start in (0, 1):
            for formats in (['flv', 'hls'], ['hls']):
                record('huya.selectStream', [page, quality, start, formats],
                       lambda p=page, q=quality, s=start, f=formats: huya.select_stream(huya.parse_room_page(p, '880'), q, s, 1700000000000, tuple(f)))
rates = [[{'iBitRate': 0}, {'iBitRate': 20000}, {'iBitRate': 14000}, {'iBitRate': 4000}, {'iBitRate': 2000}], [{'iBitRate': 4000}], []]
for rows in rates:
    for q in (0, 500, 2000, 4000, 14000, 20000):
        record('huya.selectBitrate', [rows, q], lambda r=rows, q=q: huya.select_bitrate(r, q))
cat = ('<script>var ALL_LIST_DATA = ' + json.dumps([{'lProfileRoom': 1, 'sNick': 'A', 'lTotalCount': 10},
       {'lProfileRoom': 2, 'sNick': 'B', 'lTotalCount': '9.1万'}, {'lProfileRoom': '../x', 'lTotalCount': 9999}]) + ';</script>')
record('huya.parseCategoryPage', [cat, '100023'], lambda: huya.parse_category_page(cat, '100023'))

# ---- Douyin ----
manual = dy_fixture()
auto = dy_fixture('456')
auto['room']['id_str'] = 'other'
auto['room']['stream_url'] = {'flv_pull_url': {'SD1': 'https://evil.test/x.flv'},
                              'hls_pull_url_map': {'FULL_HD1': 'https://a.douyinliving.com/f.m3u8', 'SD1': 'https://a.douyinliving.com/s.m3u8'}}
roompage = flight([0, 0, 0, {'state': {'roomStore': {'roomInfo': manual}}}])
offline = flight([0, 0, 0, {'state': {'roomStore': {'roomInfo': dy_fixture(status=4)}}}])
catpage = flight([0, 0, 0, {'roomsData': {'data': [manual, auto]}}])
for page in (roompage, offline, '<html>blocked</html>', catpage):
    record('douyin.parseRoomPage', [page, '123'], lambda p=page: douyin.parse_room_page(p, '123'))
    record('douyin.parseCategoryPage', [page, '103'], lambda p=page: douyin.parse_category_page(p, '103'))
for streams in (manual['room']['stream_url'], auto['room']['stream_url']):
    for quality in ('HD1', 'FULL_HD1', 'SD1'):
        for formats in (['flv', 'hls'], ['hls']):
            record('douyin.selectStream', [streams, quality, formats], lambda s=streams, q=quality, f=formats: douyin.select_stream(s, q, tuple(f)))

# ---- Bilibili ----
mixed = play_fixture(True, 'hevc')
mixed['playurl_info']['playurl']['stream'] += play_fixture(False)['playurl_info']['playurl']['stream']
full = json.loads(json.dumps(mixed))
full['playurl_info']['playurl']['stream'] += play_fixture()['playurl_info']['playurl']['stream']
for data in (play_fixture(), mixed, full, {'playurl_info': {}}, {'playurl_info': {'playurl': {'stream': []}}}):
    for prefer in (True, False):
        for formats in (['flv', 'hls'], ['hls']):
            record('bilibili.selectStream', [data, prefer, formats], lambda d=data, p=prefer, f=formats: bilibili.select_stream(d, p, tuple(f)))

# ---- Provider scenarios through a fake client ----


def scenario(name, responses, run):
    client = Fake(responses)
    try:
        out = run(client)
    except RoomOfflineError:
        out = {'error': 'RoomOfflineError'}
    except ProviderError:
        out = {'error': 'ProviderError'}
    cases.append({'fn': 'scenario', 'args': [name, responses], 'expect': {'result': out, 'calls': [u for u, _ in client.calls],
                                                                         'forms': client.forms}})


def channels(cs):
    return [[c.platform, c.room_id, c.name, c.title, c.logo] for c in cs]


def stream(s):
    return [s.url, s.format, s.quality]


with patch('time.time', lambda: 1700000000.0):
    scenario('douyin', {'/123': roompage, '/categorynew/4_103': catpage}, lambda c: [
        channels(douyin.Douyin(c).discover({'enabled': True, 'rooms': ['123'], 'categories': ['游戏'], 'count': 2, 'quality': 'HD1'})),
        stream(douyin.Douyin(c).resolve('123', {}))])
    scenario('bilibili', {'/get_info': {'code': 0, 'data': {'room_id': 123, 'live_status': 1, 'title': 'T', 'uname': 'U'}},
                          '/getList': {'code': 0, 'data': [{'id': 2, 'name': '网游'}]},
                          '/getRoomList': {'code': 0, 'data': [{'roomid': 456, 'online': 500, 'uname': 'X'}, {'roomid': 789, 'online': 5}]},
                          '/getRoomPlayInfo': {'code': 0, 'data': play_fixture()}}, lambda c: [
        channels(bilibili.Bilibili(c).discover({'enabled': True, 'rooms': ['12'], 'areas': ['网游'], 'min_online': 10, 'sessdata': 'abc%2C1'})),
        stream(bilibili.Bilibili(c).resolve('12', {'quality': 0}))])
    betard = {'room': {'room_id': 9999, 'show_status': 1, 'videoLoop': 0, 'nickname': 'Fixture &amp; anchor', 'room_name': 'Fixture title'}}
    listing = {'code': 0, 'data': {'rl': [{'rid': 9999, 'nn': 'dup', 'ol': 9}, {'rid': 42, 'nn': 'Hot', 'rn': 'Room', 'ol': 500},
                                          {'rid': 'bad/1', 'ol': 900}, {'rid': 7, 'ol': '3万'}]}}
    key = {'error': 0, 'data': {'rand_str': 'r', 'key': 'k', 'enc_time': 2, 'enc_data': 'e', 'is_special': 0}}
    play = {'error': 0, 'data': {'rtmp_url': 'http://hw-tct.douyucdn.cn/live', 'rtmp_live': '9999r_2000.flv?wsAuth=fixture&token=x'}}
    scenario('douyu', {'/betard/': betard, '/mixListV1/1_2/1': listing, '/getEncryption': key, '/getH5PlayV1/9999': play}, lambda c: [
        channels(douyu.Douyu(c).discover({'enabled': True, 'rooms': ['https://www.douyu.com/09999'], 'categories': ['娱乐'], 'count': 2, 'min_viewers': 5})),
        stream(douyu.Douyu(c).resolve('9999', {'quality': 0}))])
    scenario('huya', {'/vanity': pages['two'], '/g/100023': cat}, lambda c: [
        channels(huya.Huya(c).discover({'enabled': True, 'rooms': ['vanity'], 'categories': ['网游'], 'count': 1})),
        stream(huya.Huya(c).resolve('vanity', {'quality': 4000}))])

json.dump(cases, sys.stdout, ensure_ascii=False)
print(f'{len(cases)} cases', file=sys.stderr)
