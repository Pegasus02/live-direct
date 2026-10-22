"""Bounded, stateless HTTP. Only the narrow Douyin share helper follows redirects."""
import http.client
import json
import re
import socket
import ssl
import time
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

from .models import ProviderError

API_HOSTS = frozenset({'live.douyin.com', 'api.live.bilibili.com', 'passport.bilibili.com',
                       'www.douyu.com', 'playweb.douyucdn.cn', 'www.huya.com'})
MEDIA_SUFFIXES = {
    'douyin': ('douyinliving.com', 'douyincdn.com'),
    'bilibili': ('bilivideo.com', 'bilivideo.cn', 'biliapi.net'),
    'douyu': ('douyucdn.cn', 'douyucdn2.cn'),
    'huya': ('huya.com',),
}
# Only the fixed Douyu play API takes a form body; every other endpoint is GET.
POST_HOSTS = frozenset({'playweb.douyucdn.cn'})
TIMEOUT = 10
MAX_BYTES = 5_000_000


def validate_url(url, hosts=API_HOSTS):
    try:
        p = urlsplit(url)
        if (p.scheme != 'https' or p.hostname not in hosts or p.username is not None
                or p.password is not None or p.port not in (None, 443)
                or p.fragment or any(ord(c) < 33 or ord(c) == 127 for c in url)):
            raise ValueError
        return p
    except (ValueError, TypeError):
        raise ProviderError('Untrusted upstream URL') from None


def media_url(url, platform, format):
    """Normalize official HTTP CDN addresses, never arbitrary or numeric hosts."""
    try:
        p = urlsplit(url)
        suffixes = MEDIA_SUFFIXES[platform]
        host = p.hostname or ''
        if (p.scheme not in ('http', 'https') or p.port not in (None, 80, 443)
                or p.username is not None or p.password is not None or p.fragment
                or not any(host == s or host.endswith('.' + s) for s in suffixes)
                or not p.path.endswith('.flv' if format == 'flv' else '.m3u8')
                or any(ord(c) < 33 or ord(c) == 127 for c in url)):
            raise ValueError
        return 'https://' + host + p.path + ('?' + p.query if p.query else '')
    except (ValueError, TypeError, KeyError):
        raise ProviderError('Untrusted media URL') from None


PROBE_TIMEOUT = 3


def probe_media(url, platform, format):
    """HEAD a trusted CDN address the way a 302-following player would: no
    Referer, no cookies, no redirects. Some CDN nodes reject header-less
    requests or fail TLS, so providers use this to skip them."""
    try:
        p = urlsplit(media_url(url, platform, format))
    except ProviderError:
        return False
    connection = http.client.HTTPSConnection(p.hostname, timeout=PROBE_TIMEOUT, context=ssl.create_default_context())
    try:
        connection.request('HEAD', p.path + ('?' + p.query if p.query else ''),
                           headers={'User-Agent': 'Mozilla/5.0 LiveDirect/1.0', 'Accept-Encoding': 'identity'})
        return connection.getresponse().status in (200, 206)
    except (OSError, socket.timeout, ValueError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def _fetch(url, headers=None, return_headers=False, form=None):
    p = validate_url(url)
    if form is not None and p.hostname not in POST_HOSTS:
        raise ProviderError('Form destination rejected')
    clean_headers = {'User-Agent': 'Mozilla/5.0 LiveDirect/1.0', 'Accept-Encoding': 'identity'}
    for key, value in (headers or {}).items():
        if key.lower() not in ('user-agent', 'accept', 'accept-language', 'referer', 'cookie', 'origin'):
            raise ProviderError('Unsupported request header')
        if not isinstance(value, str) or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ProviderError('Invalid request header')
        if key.lower() == 'cookie' and p.hostname != 'api.live.bilibili.com':
            raise ProviderError('Session destination rejected')
        clean_headers[key] = value
    connection = http.client.HTTPSConnection(p.hostname, timeout=TIMEOUT, context=ssl.create_default_context())
    try:
        deadline = time.monotonic() + TIMEOUT
        body = None
        if form is not None:
            body = urlencode(form).encode()
            clean_headers['Content-Type'] = 'application/x-www-form-urlencoded'
        connection.request('GET' if body is None else 'POST', p.path + ('?' + p.query if p.query else ''),
                           body=body, headers=clean_headers)
        transport = connection.sock
        if transport:
            transport.settimeout(max(0.001, deadline - time.monotonic()))
        response = connection.getresponse()
        resp_headers = response.getheaders() if hasattr(response, 'getheaders') else []
        if response.status != 200:
            raise ProviderError('Upstream HTTP request failed')
        if response.getheader('Content-Encoding', 'identity').lower() != 'identity':
            raise ProviderError('Unsupported upstream encoding')
        length = response.getheader('Content-Length')
        if length and int(length) > MAX_BYTES:
            raise ProviderError('Upstream response too large')
        chunks, size = [], 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProviderError('Upstream request timed out')
            if transport:
                transport.settimeout(remaining)
            chunk = response.read1(min(65536, MAX_BYTES + 1 - size))
            if not chunk:
                text = b''.join(chunks).decode('utf-8')
                return (resp_headers, text) if return_headers else text
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_BYTES:
                raise ProviderError('Upstream response too large')
    except ProviderError:
        raise
    except (OSError, socket.timeout, ValueError, UnicodeError, http.client.HTTPException):
        raise ProviderError('Upstream request failed') from None
    finally:
        connection.close()


DOUYIN_SHARE_HOSTS = frozenset({
    'v.douyin.com', 'webcast.amemv.com', 'www.iesdouyin.com',
    'www.douyin.com', 'live.douyin.com',
})
DOUYIN_MOBILE_UA = ('Mozilla/5.0 (iPhone; CPU iPhone OS 10_3_1 like Mac OS X) '
                    'AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.0 '
                    'Mobile/14E304 Safari/602.1')
# Public share attribution only: never a logged-in browser/session cookie.
_DOUYIN_SHARE_COOKIE = ('_tea_utm_cache_1128={%22utm_source%22:%22copy%22%2C'
                        '%22utm_medium%22:%22android%22%2C'
                        '%22utm_campaign%22:%22client_share%22}')


def _douyin_target(url):
    if (not isinstance(url, str) or '\\' in url or '#' in url
            or re.search(r'%[01][0-9a-f]|%7f', url, re.I)):
        raise ProviderError('Untrusted Douyin share target')
    return validate_url(url, DOUYIN_SHARE_HOSTS)


def _douyin_room_id(p):
    if p.hostname in ('webcast.amemv.com', 'www.iesdouyin.com'):
        match = re.fullmatch(r'/(?:douyin/webcast/)?reflow/([0-9]{19})/?', p.path)
        if match:
            return match[1]
    ids = parse_qs(p.query, keep_blank_values=True).get('room_id', [])
    if len(ids) == 1 and re.fullmatch(r'[0-9]{19}', ids[0]):
        return ids[0]
    return None


def resolve_douyin_share(url):
    """Resolve a strict short share URL to its internal room ID, without cookies.

    At most four direct HEAD requests share one total timeout. Every Location is
    validated, including a terminal room URL which need not itself be requested.
    This exception does not change the general API client's no-redirect policy.
    """
    p = _douyin_target(url)
    if (p.hostname != 'v.douyin.com' or '?' in url or '#' in url
            or not re.fullmatch(r'/[A-Za-z0-9_-]+/?', p.path)):
        raise ProviderError('Invalid Douyin share URL')
    deadline = time.monotonic() + TIMEOUT
    seen = set()
    for _ in range(4):
        p = _douyin_target(url)
        key = (p.hostname, p.path, p.query)
        if key in seen:
            raise ProviderError('Douyin share redirect loop')
        seen.add(key)
        connection = None
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProviderError('Upstream request timed out')
            connection = http.client.HTTPSConnection(
                p.hostname, timeout=remaining, context=ssl.create_default_context())
            connection.request('HEAD', p.path + ('?' + p.query if p.query else ''),
                               headers={'User-Agent': DOUYIN_MOBILE_UA,
                                        'Accept-Encoding': 'identity'})
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProviderError('Upstream request timed out')
            if connection.sock:
                connection.sock.settimeout(remaining)
            response = connection.getresponse()
            if time.monotonic() >= deadline:
                raise ProviderError('Upstream request timed out')
            if response.status not in (301, 302, 303, 307, 308):
                raise ProviderError('Douyin share room not found')
            location = response.getheader('Location')
            # urljoin strips some control characters; reject them beforehand.
            if (not isinstance(location, str) or not location
                    or any(ord(c) < 33 or ord(c) == 127 for c in location)
                    or '\\' in location or '#' in location):
                raise ProviderError('Untrusted Douyin share target')
            target = urljoin(url, location)
            destination = _douyin_target(target)
            room_id = _douyin_room_id(destination)
            if room_id:
                return room_id
            url = target
        except ProviderError:
            raise
        except (OSError, ValueError, UnicodeError, http.client.HTTPException):
            raise ProviderError('Douyin share request failed') from None
        finally:
            if connection:
                connection.close()
    raise ProviderError('Douyin share redirect limit exceeded')


def fetch_douyin_reflow(room_id):
    """Fetch the full reflow JSON from one fixed official endpoint.

    No caller-controlled URL or headers, no user credentials, no redirects.
    """
    if not isinstance(room_id, str) or not re.fullmatch(r'[0-9]{19}', room_id):
        raise ProviderError('Invalid Douyin internal room ID')
    path = ('/webcast/room/reflow/info/?type_id=0&live_id=1&room_id='
            + room_id + '&app_id=1128')
    connection = None
    try:
        deadline = time.monotonic() + TIMEOUT
        connection = http.client.HTTPSConnection(
            'webcast.amemv.com', timeout=TIMEOUT, context=ssl.create_default_context())
        connection.request('GET', path, headers={
            'User-Agent': DOUYIN_MOBILE_UA, 'Accept-Encoding': 'identity',
            'Cookie': _DOUYIN_SHARE_COOKIE,
        })
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProviderError('Upstream request timed out')
        transport = connection.sock
        if transport:
            transport.settimeout(remaining)
        response = connection.getresponse()
        if response.status != 200:
            raise ProviderError('Upstream HTTP request failed')
        if response.getheader('Content-Encoding', 'identity').lower() != 'identity':
            raise ProviderError('Unsupported upstream encoding')
        length = response.getheader('Content-Length')
        if length and int(length) > MAX_BYTES:
            raise ProviderError('Upstream response too large')
        chunks, size = [], 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProviderError('Upstream request timed out')
            if transport:
                transport.settimeout(remaining)
            chunk = response.read1(min(65536, MAX_BYTES + 1 - size))
            if not chunk:
                return json.loads(b''.join(chunks).decode('utf-8'))
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_BYTES:
                raise ProviderError('Upstream response too large')
    except ProviderError:
        raise
    except (OSError, ValueError, UnicodeError, RecursionError, http.client.HTTPException):
        raise ProviderError('Douyin reflow request failed') from None
    finally:
        if connection:
            connection.close()


def fetch_text(url, headers=None):
    return _fetch(url, headers)


def fetch_json(url, headers=None, form=None):
    text = _fetch(url, headers, form=form)
    try:
        return json.loads(text)
    except (ValueError, RecursionError):
        raise ProviderError('Invalid upstream JSON') from None


def fetch_json_with_headers(url, headers=None):
    resp_headers, text = _fetch(url, headers, return_headers=True)
    try:
        return resp_headers, json.loads(text)
    except (ValueError, RecursionError):
        raise ProviderError('Invalid upstream JSON') from None
