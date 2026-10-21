"""Authenticated standalone subscriptions and management API; no video proxy."""
import concurrent.futures
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
from http import cookies
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, urlsplit

from .config import ConfigStore
from .net import MEDIA_SUFFIXES as PLATFORM_MEDIA
from .providers import CATEGORIES, LABELS, default_providers

ROOM = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
MEDIA_SUFFIXES = tuple('.' + suffix for suffixes in PLATFORM_MEDIA.values() for suffix in suffixes)


def safe_media(url, platform=None):
    suffixes = MEDIA_SUFFIXES if platform is None else tuple('.' + s for s in PLATFORM_MEDIA.get(platform, ()))
    if not suffixes or not isinstance(url, str) or len(url) > 16384 or any(ord(x) <= 32 or ord(x) == 127 for x in url) or '\\' in url:
        return False
    try:
        p = urlsplit(url)
        return p.scheme == 'https' and p.port in (None, 443) and p.username is None and p.password is None and not p.fragment and p.hostname and p.hostname.endswith(suffixes) and bool(p.path)
    except ValueError:
        return False


def clean_text(value):
    return ''.join(c for c in str(value) if ord(c) >= 32 and ord(c) != 127).replace('"', "'")[:300]


class Engine:
    def __init__(self, store, providers=None):
        self.store = store
        self.providers = providers or default_providers()
        self.lock = threading.RLock()
        self.refresh_lock = threading.Lock()
        self.resolve_slots = threading.BoundedSemaphore(6)
        self.channels = {}
        self.health = {}
        self.cache = {}
        self.pending = {}
        self.updated = 0
        self.generation = 0
        self.config_revision = 0

    def invalidate(self):
        # Revoke old channels/URLs immediately when management changes settings.
        with self.lock:
            self.config_revision += 1
            self.generation += 1
            self.channels = {}
            self.cache.clear()
            self.updated = 0

    def refresh(self):
        if not self.refresh_lock.acquire(blocking=False):
            return False
        try:
            with self.lock:
                revision = self.config_revision
            cfg = self.store.get()
            updated = {}
            health = {}
            for platform, provider in self.providers.items():
                pc = cfg[platform]
                if not pc.get('enabled'):
                    health[platform] = {'enabled': False, 'status': 'disabled', 'count': 0}
                    continue
                try:
                    rows = provider.discover(pc)
                    selected = {}
                    for ch in rows[:500]:
                        if ch.platform == platform and ROOM.fullmatch(str(ch.room_id)):
                            selected[(platform, str(ch.room_id))] = ch
                    updated.update(selected)
                    health[platform] = {'enabled': True, 'status': 'ok', 'count': len(selected), 'cached': False, 'last_success': int(time.time()), 'warnings': list(getattr(provider, 'warnings', []))[:20]}
                except Exception:
                    with self.lock:
                        old = {key: val for key, val in self.channels.items() if key[0] == platform}
                    updated.update(old)
                    health[platform] = {'enabled': True, 'status': 'error', 'count': len(old), 'cached': bool(old), 'message': '频道刷新失败；保留上次成功列表，不代表当前可播'}
            with self.lock:
                if revision != self.config_revision:
                    return False
                self.channels, self.health = updated, health
                self.updated = time.monotonic()
                self.generation += 1
                self.cache.clear()
            return True
        finally:
            self.refresh_lock.release()

    def start_refresh(self):
        with self.lock:
            thread = getattr(self, '_refresh_thread', None)
            if thread and thread.is_alive():
                self._refresh_requested = True
                return False
            self._refresh_requested = False
            def work():
                while True:
                    self.refresh()
                    with self.lock:
                        if not self._refresh_requested:
                            self._refresh_thread = None
                            return
                        self._refresh_requested = False
            self._refresh_thread = threading.Thread(target=work, daemon=True)
            self._refresh_thread.start()
            return True

    def maybe_refresh(self):
        if self.updated == 0 or time.monotonic() - self.updated > 120:
            self.start_refresh()

    def status(self):
        with self.lock:
            thread = getattr(self, '_refresh_thread', None)
            return {'platforms': dict(self.health), 'channel_count': len(self.channels), 'refreshing': self.refresh_lock.locked() or bool(thread and thread.is_alive())}

    def list_channels(self):
        with self.lock:
            return [{'platform': p, 'room_id': r, 'name': clean_text(c.name), 'title': clean_text(c.title)} for (p, r), c in self.channels.items()]

    def playlist(self, public_base, sub_token):
        self.maybe_refresh()
        lines = ['#EXTM3U']
        with self.lock:
            if not self.channels and (self.updated == 0 or any(v.get('status') == 'error' for v in self.health.values())):
                if any(c.get('enabled') for c in self.store.get().values()):
                    raise RuntimeError('channels not ready')
            for (p, r), ch in self.channels.items():
                group = LABELS.get(p, p)
                title = clean_text(ch.name) + (' · ' + clean_text(ch.title) if ch.title else '')
                lines.extend([f'#EXTINF:-1 group-title="{group}",{title}', f'{public_base}/s/{sub_token}/live/{p}/{r}'])
        return ('\n'.join(lines) + '\n').encode()

    def resolve(self, platform, room):
        with self.lock:
            cfg = self.store.get()
            if platform not in self.providers or not cfg[platform].get('enabled'):
                raise LookupError()
            if (platform, room) not in self.channels:
                raise LookupError()
            key = (self.generation, platform, room)
            cached = self.cache.get(key)
            if cached and cached[0] > time.monotonic():
                if cached[1] is None:
                    raise RuntimeError('temporarily unavailable')
                return cached[1]
            evt = self.pending.get(key)
            owner = evt is None
            if owner:
                if not self.resolve_slots.acquire(blocking=False):
                    raise RuntimeError('busy')
                evt = threading.Event()
                self.pending[key] = evt
        if not owner:
            if not evt.wait(35):
                raise RuntimeError('busy')
            with self.lock:
                cached = self.cache.get(key)
                if key[0] == self.generation and (platform, room) in self.channels and cached and cached[0] > time.monotonic() and cached[1]:
                    return cached[1]
            raise RuntimeError('temporarily unavailable')
        stream = None
        succeeded = False
        try:
            stream = self.providers[platform].resolve(room, cfg[platform])
            if not safe_media(stream.url, platform):
                raise ValueError('invalid media')
            # A 302 does not forward source request headers to the player.
            if any(k.lower() == 'cookie' for k in stream.headers):
                raise ValueError('credential-bound media cannot redirect')
            with self.lock:
                if key[0] != self.generation or (platform, room) not in self.channels:
                    raise RuntimeError('configuration changed')
                succeeded = True
                return stream
        finally:
            with self.lock:
                if key[0] == self.generation:
                    # Providers may shorten the positive TTL (see Huya.cache_ttl); in-flight
                    # requests for the same room are still de-duplicated via self.pending.
                    ttl = min(30, getattr(self.providers.get(platform), 'cache_ttl', 30)) if succeeded else 5
                    self.cache[key] = (time.monotonic() + ttl, stream if succeeded else None)
                self.pending.pop(key, None)
                evt.set()
                self.resolve_slots.release()


class Application:
    def __init__(self, store, admin_token, sub_token, public_base, engine=None, auth_enabled=True):
        self.auth_enabled = auth_enabled
        self.open_csrf = secrets.token_urlsafe(32)
        if (auth_enabled and len(admin_token) < 24) or len(sub_token) < 24 or not re.fullmatch(r'[A-Za-z0-9_-]{24,128}', sub_token):
            raise ValueError('tokens must be independent and at least 24 characters')
        if hmac.compare_digest(admin_token, sub_token):
            raise ValueError('tokens must differ')
        if any(ord(c) <= 32 or ord(c) == 127 for c in public_base) or '\\' in public_base:
            raise ValueError('invalid PUBLIC_BASE')
        p = urlsplit(public_base)
        p.port  # Reject invalid/out-of-range ports at startup.
        if p.scheme not in ('http', 'https') or not p.hostname or p.path not in ('', '/') or p.query or p.fragment or p.username:
            raise ValueError('PUBLIC_BASE must be an HTTP(S) origin')
        self.store, self.engine = store, engine or Engine(store)
        self.admin_digest = hashlib.sha256(admin_token.encode()).digest()
        self.sub_token, self.base = sub_token, public_base.rstrip('/')
        self.sessions = {}
        self.session_lock = threading.Lock()
        self.login_attempts = {}
        self.web = Path(__file__).parent / 'web'

    def login(self, token, client):
        now = time.monotonic()
        with self.session_lock:
            # Bound rate-limit state regardless of source IP churn.
            self.login_attempts = {k: v for k, v in self.login_attempts.items() if v[0] > now - 60}
            if len(self.login_attempts) > 1000:
                return None
            at, count = self.login_attempts.get(client, (now, 0))
            self.login_attempts[client] = (at, count + 1)
            if count >= 10:
                return None
            if not hmac.compare_digest(hashlib.sha256(token.encode()).digest(), self.admin_digest):
                return None
            self.sessions = {k: v for k, v in self.sessions.items() if v[0] > now}
            if len(self.sessions) >= 128:
                self.sessions.pop(next(iter(self.sessions)))
            sid, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
            self.sessions[sid] = (now + 43200, csrf)
            return sid

    def session(self, header):
        try:
            jar = cookies.SimpleCookie(header or '')
            sid = jar['ld_session'].value
        except (KeyError, cookies.CookieError):
            return None
        with self.session_lock:
            result = self.sessions.get(sid)
            return result if result and result[0] > time.monotonic() else None


class Handler(BaseHTTPRequestHandler):
    server_version = 'LiveDirect'
    sys_version = ''
    protocol_version = 'HTTP/1.0'

    def setup(self):
        self.request.settimeout(10)
        super().setup()

    def log_message(self, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        self.reply(code)

    @property
    def app(self):
        return self.server.app

    def reply(self, code, body=b'', typ='text/plain; charset=utf-8', headers=None):
        self.send_response_only(code)
        common = {'Content-Type': typ, 'Content-Length': str(len(body)), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Connection': 'close', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"}
        common.update(headers or {})
        for k, v in common.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)
        self.close_connection = True

    def json_reply(self, code, obj):
        self.reply(code, json.dumps(obj, ensure_ascii=False).encode(), 'application/json; charset=utf-8')

    def body(self):
        if self.headers.get('Transfer-Encoding'):
            raise ValueError()
        n = int(self.headers.get('Content-Length', '0'))
        if not 0 <= n <= 65536:
            raise ValueError()
        return self.rfile.read(n)

    def serve(self):
        path = self.path
        if len(path) > 2048 or '?' in path or '%' in path:
            return self.reply(404)
        if path == '/health' and self.command in ('GET', 'HEAD'):
            return self.reply(200, b'ok')
        if not self.app.auth_enabled and path == '/login':
            return self.reply(303, headers={'Location': '/admin'})
        if self.command == 'POST' and path == '/login':
            origin = self.headers.get('Origin')
            if origin and origin != self.app.base:
                return self.reply(403)
            form = parse_qs(self.body().decode())
            sid = self.app.login(form.get('admin_token', [''])[0], self.client_address[0])
            if not sid:
                return self.reply(403, '登录失败或尝试过于频繁'.encode())
            secure = '; Secure' if self.app.base.startswith('https:') else ''
            return self.reply(303, headers={'Location': '/admin', 'Set-Cookie': 'ld_session=' + sid + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200' + secure})
        session = self.app.session(self.headers.get('Cookie')) if self.app.auth_enabled else (float('inf'), self.app.open_csrf)
        admin_pages = ('/', '/admin') + tuple('/admin/' + platform for platform in self.app.engine.providers)
        assets = {'/login': 'login.html', '/static/admin.js': 'admin.js', '/static/style.css': 'style.css', '/static/qrcode.min.js': 'qrcode.min.js',
                  '/static/icon.svg': 'icon.svg', '/static/icon-180.png': 'icon-180.png',
                  '/static/logo-douyu.png': 'logo-douyu.png', '/static/logo-huya.png': 'logo-huya.png', '/favicon.ico': 'icon.svg'}
        if self.command in ('GET', 'HEAD') and (path in admin_pages or path in assets):
            if path in admin_pages and not session:
                return self.reply(303, headers={'Location': '/login'})
            name = 'index.html' if path in admin_pages else assets[path]
            typ = {'html': 'text/html; charset=utf-8', 'css': 'text/css', 'js': 'application/javascript',
                   'svg': 'image/svg+xml', 'png': 'image/png'}[name.rsplit('.', 1)[1]]
            return self.reply(200, (self.app.web / name).read_bytes(), typ)
        if path.startswith('/api/'):
            if not session:
                return self.reply(401)
            if self.command in ('GET', 'HEAD'):
                if path == '/api/session':
                    return self.json_reply(200, {'csrf': session[1], 'auth_enabled': self.app.auth_enabled})
                if path == '/api/config':
                    return self.json_reply(200, self.app.store.get(public=True))
                if path == '/api/meta':
                    return self.json_reply(200, {'platforms': [
                        {'id': p, 'label': LABELS.get(p, p),
                         'categories': [{'id': k, 'name': v} for k, v in CATEGORIES.get(p, {}).items()]}
                        for p in self.app.engine.providers]})
                if path == '/api/status':
                    return self.json_reply(200, self.app.engine.status())
                if path == '/api/channels':
                    return self.json_reply(200, {'channels': self.app.engine.list_channels()})
                if path == '/api/subscription':
                    return self.json_reply(200, {'url': self.app.base + '/s/' + self.app.sub_token + '/interface.m3u'})
            if self.command == 'POST':
                if self.headers.get('Origin') not in (None, self.app.base) or not hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), session[1]):
                    return self.reply(403)
                if path == '/api/logout':
                    if not self.app.auth_enabled:
                        return self.reply(204)
                    jar = cookies.SimpleCookie(self.headers.get('Cookie', ''))
                    with self.app.session_lock:
                        self.app.sessions.pop(jar['ld_session'].value, None)
                    secure = '; Secure' if self.app.base.startswith('https:') else ''
                    return self.reply(204, headers={'Set-Cookie': 'ld_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + secure})
                if path == '/api/config':
                    patch = json.loads(self.body())
                    with self.app.engine.lock:
                        result = self.app.store.update(patch)
                        self.app.engine.invalidate()
                    self.app.engine.start_refresh()
                    return self.json_reply(200, result)
                if path == '/api/refresh':
                    return self.json_reply(200, {'accepted': self.app.engine.start_refresh()})
                if path == '/api/bilibili/qrcode/generate':
                    provider = self.app.engine.providers.get('bilibili')
                    if not provider or not hasattr(provider, 'qrcode_generate'):
                        return self.reply(404)
                    return self.json_reply(200, provider.qrcode_generate())
                if path == '/api/bilibili/qrcode/poll':
                    provider = self.app.engine.providers.get('bilibili')
                    if not provider or not hasattr(provider, 'qrcode_poll'):
                        return self.reply(404)
                    body = json.loads(self.body())
                    key = body.get('qrcode_key', '')
                    res = provider.qrcode_poll(key)
                    if res.get('status') == 'success':
                        sess = res.pop('sessdata')
                        with self.app.engine.lock:
                            self.app.store.update({'bilibili': {'sessdata': sess}})
                            self.app.engine.invalidate()
                        self.app.engine.start_refresh()
                    return self.json_reply(200, res)
            return self.reply(404)
        parts = path.split('/')
        if len(parts) >= 4 and parts[1] == 's' and hmac.compare_digest(parts[2].encode(), self.app.sub_token.encode()):
            if self.command not in ('GET', 'HEAD'):
                return self.reply(405)
            if len(parts) == 4 and parts[3] == 'interface.m3u':
                try:
                    playlist = self.app.engine.playlist(self.app.base, self.app.sub_token)
                except RuntimeError:
                    return self.reply(503, b'Channels updating; retry shortly', headers={'Retry-After': '5'})
                return self.reply(200, playlist, 'audio/x-mpegurl; charset=utf-8')
            if len(parts) == 6 and parts[3] == 'live' and ROOM.fullmatch(parts[5]):
                self.app.engine.maybe_refresh()
                try:
                    stream = self.app.engine.resolve(parts[4], parts[5])
                except LookupError:
                    return self.reply(404)
                except Exception:
                    return self.reply(503)
                return self.reply(302, headers={'Location': stream.url})
        return self.reply(404)

    def _safe(self):
        try:
            self.serve()
        except (ValueError, TypeError, json.JSONDecodeError):
            self.reply(400)
        except Exception:
            self.close_connection = True

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_OPTIONS = _safe


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, addr, app):
        self.app = app
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(addr, Handler)

    def process_request(self, request, address):
        if not self.slots.acquire(False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            self.shutdown_request(request)

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def handle_error(self, *args):
        pass


def main():
    data = Path(os.environ.get('DATA_DIR', '/data'))
    data.mkdir(mode=0o700, parents=True, exist_ok=True)
    auth = os.environ.get('ADMIN_AUTH_ENABLED', 'true').lower()
    if auth not in ('true', 'false'):
        raise ValueError('ADMIN_AUTH_ENABLED must be true or false')
    app = Application(ConfigStore(data / 'config.json'), os.environ.get('ADMIN_TOKEN', ''), os.environ['SUBSCRIPTION_TOKEN'], os.environ['PUBLIC_BASE'], auth_enabled=auth == 'true')
    with Server(('0.0.0.0', int(os.environ.get('PORT', '8080'))), app) as srv:
        srv.serve_forever()


if __name__ == '__main__':
    main()
