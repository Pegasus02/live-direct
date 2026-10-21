"""Bounded, stateless API/page HTTP only. No redirects, proxies or cookie jar."""
import http.client
import json
import socket
import ssl
import time
from urllib.parse import urlsplit

from .models import ProviderError

API_HOSTS = frozenset({'live.douyin.com', 'api.live.bilibili.com', 'passport.bilibili.com'})
MEDIA_SUFFIXES = {
    'douyin': ('douyinliving.com', 'douyincdn.com'),
    'bilibili': ('bilivideo.com', 'bilivideo.cn', 'biliapi.net'),
}
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


def _fetch(url, headers=None, return_headers=False):
    p = validate_url(url)
    clean_headers = {'User-Agent': 'Mozilla/5.0 LiveDirect/1.0', 'Accept-Encoding': 'identity'}
    for key, value in (headers or {}).items():
        if key.lower() not in ('user-agent', 'accept', 'accept-language', 'referer', 'cookie'):
            raise ProviderError('Unsupported request header')
        if not isinstance(value, str) or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ProviderError('Invalid request header')
        if key.lower() == 'cookie' and p.hostname != 'api.live.bilibili.com':
            raise ProviderError('Session destination rejected')
        clean_headers[key] = value
    connection = http.client.HTTPSConnection(p.hostname, timeout=TIMEOUT, context=ssl.create_default_context())
    try:
        deadline = time.monotonic() + TIMEOUT
        connection.request('GET', p.path + ('?' + p.query if p.query else ''), headers=clean_headers)
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


def fetch_text(url, headers=None):
    return _fetch(url, headers)


def fetch_json(url, headers=None):
    text = _fetch(url, headers)
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
    except (ValueError, RecursionError):
        raise ProviderError('Invalid upstream JSON') from None
