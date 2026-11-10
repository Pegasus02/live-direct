"""Zero-configuration entry point for hosts that just run one script (APTV).

Unlike ``app.main`` it needs no environment variables: tokens are generated on
first start and kept next to the config, the server listens on loopback only,
and the management page is open without login while nothing else can reach it.
Binding a non-loopback address turns admin login back on.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import secrets
import sys

from .app import Application, Server
from .config import ConfigStore

DEFAULT_PORT = 1907
SECRETS_FILE = 'standalone-secrets.json'


def default_data_dir():
    main = sys.modules.get('__main__')
    script = getattr(main, '__file__', None) or (sys.argv[0] if sys.argv and sys.argv[0] else '')
    base = Path(script).resolve().parent if script else Path.cwd()
    return base / 'live-direct-data'


def load_secrets(data):
    path = data / SECRETS_FILE
    try:
        saved = json.loads(path.read_text())
        if isinstance(saved, dict) and all(isinstance(saved.get(k), str) and len(saved[k]) >= 24 for k in ('admin', 'subscription')):
            return saved['admin'], saved['subscription']
    except (OSError, ValueError):
        pass
    admin, sub = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    tmp = path.with_suffix('.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump({'admin': admin, 'subscription': sub}, handle)
    os.replace(tmp, path)
    return admin, sub


def is_loopback(host):
    if host == 'localhost':
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def parse_args(argv):
    ap = argparse.ArgumentParser(description='Live Direct 单文件版（抖音/B站/斗鱼/虎牙直播 M3U，302 直连）')
    ap.add_argument('port', nargs='?', type=int, default=int(os.environ.get('PORT', DEFAULT_PORT)), help=f'监听端口 (默认 {DEFAULT_PORT})')
    ap.add_argument('--bind', default=os.environ.get('BIND_IP', '127.0.0.1'), help='监听地址 (默认 127.0.0.1，仅本机)')
    ap.add_argument('--public-base', default=os.environ.get('PUBLIC_BASE', ''), help='播放器访问本服务的地址 (默认 http://127.0.0.1:端口)')
    ap.add_argument('--data-dir', default=os.environ.get('DATA_DIR', ''), help='配置目录 (默认脚本旁的 live-direct-data)')
    ap.add_argument('--admin-login', action='store_true', help='本机监听时也要求管理员令牌登录')
    # Hosts may pass their own arguments; ignore what we do not know.
    args, _ = ap.parse_known_args(argv)
    return args


def build(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    data = Path(args.data_dir) if args.data_dir else default_data_dir()
    data.mkdir(mode=0o700, parents=True, exist_ok=True)
    data = data.resolve()
    admin, sub = load_secrets(data)
    local = is_loopback(args.bind)
    auth = args.admin_login or not local
    host = '127.0.0.1' if local else args.bind
    base = (args.public_base or f'http://{host}:{args.port}').rstrip('/')
    app = Application(ConfigStore(data / 'config.json'), admin, sub, base, auth_enabled=auth)
    srv = Server((args.bind, args.port), app)
    port = srv.server_address[1]
    if not args.public_base and args.port == 0:
        # Port 0 asks the OS for a free port; rebuild the base around it.
        app.base = f'http://{host}:{port}'
    return srv, app, data, auth


def main(argv=None):
    srv, app, data, auth = build(argv)
    host, port = srv.server_address[:2]
    print(f'[live-direct] 已启动: {app.base} (监听 {host}:{port})', flush=True)
    print(f'[live-direct] 管理后台: {app.base}/admin' + (' (需管理员令牌，见 ' + str(data / SECRETS_FILE) + ')' if auth else ''), flush=True)
    print(f'[live-direct] 订阅地址: {app.base}/s/{app.sub_token}/interface.m3u', flush=True)
    print(f'[live-direct] 配置目录: {data}', flush=True)
    with srv:
        app.engine.start_refresh()
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
