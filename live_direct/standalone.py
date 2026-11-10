"""Zero-configuration entry point for hosts that just run one script (APTV).

Listening on loopback (the default) is "local mode": no tokens and no login,
the subscription is simply http://127.0.0.1:<port>/interface.m3u, and the
server only answers loopback peers that name a loopback Host. Binding any
other address switches back to the token + admin-login model of ``app.main``.

Everything worth knowing is printed as timestamped lines, because the host's
log viewer is the only console there is.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import secrets
import signal
import sys
import tempfile
import threading
import time

import re

from .app import Application, Server, describe_config
from .config import DEFAULTS, ConfigError, ConfigStore
from .providers import CATEGORIES, LABELS

DEFAULT_PORT = 1907
SECRETS_FILE = 'standalone-secrets.json'
DATA_NAME = 'live-direct-data'
# APTV playlist directives: do not open every channel for preview thumbnails
# or latency probes -- each open is a real platform lookup here.
APTV_DIRECTIVES = ('#EXT-X-APTV-PREVIEW: FALSE', '#EXT-X-APTV-LATENCY: FALSE')

# The single-file build sets this to its own path; hosts such as APTV exec the
# script from their runner, so __main__ may not be the script itself.
SCRIPT_PATH = ''

_log_lock = threading.Lock()
_log_last = {}


def log(message, min_interval=1.5):
    """Timestamped stdout line; identical lines are rate-limited."""
    message = str(message).strip()
    if not message:
        return
    now = time.monotonic()
    with _log_lock:
        if now - _log_last.get(message, -1e9) < min_interval:
            return
        if len(_log_last) > 500:
            _log_last.clear()
        _log_last[message] = now
    print(time.strftime('[%H:%M:%S] ') + message, flush=True)


def script_dir():
    main = sys.modules.get('__main__')
    script = SCRIPT_PATH or getattr(main, '__file__', None) or (sys.argv[0] if sys.argv and sys.argv[0] else '')
    return Path(script).resolve().parent if script else Path.cwd()


def writable(directory):
    try:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        probe = directory / f'.write-test-{os.getpid()}'
        probe.write_text('ok')
        probe.unlink()
        return True
    except OSError:
        return False


def choose_data_dir(requested=''):
    """First usable directory; a sandbox may refuse the one next to the script."""
    candidates = [Path(requested)] if requested else []
    candidates += [script_dir() / DATA_NAME, Path.home() / DATA_NAME, Path(tempfile.gettempdir()) / DATA_NAME]
    for index, directory in enumerate(candidates):
        if writable(directory):
            if index:
                log(f'[系统] 警告: {candidates[0]} 不可写，改用 {directory}')
            return directory.resolve()
    raise SystemExit('[live-direct] 找不到可写的配置目录')


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
    ap.add_argument('port', nargs='*', help=f'监听端口 (默认 {DEFAULT_PORT})')
    ap.add_argument('--bind', default=os.environ.get('BIND_IP', '127.0.0.1'), help='监听地址 (默认 127.0.0.1：仅本机，免令牌)')
    ap.add_argument('--public-base', default=os.environ.get('PUBLIC_BASE', ''), help='非本机监听时，播放器访问本服务的地址')
    ap.add_argument('--data-dir', default=os.environ.get('DATA_DIR', ''), help=f'配置目录 (默认脚本旁的 {DATA_NAME})')
    # Hosts may pass their own arguments (e.g. the script path); ignore what
    # we do not know instead of exiting.
    try:
        args, _ = ap.parse_known_args(argv)
    except SystemExit:
        args, _ = ap.parse_known_args([])
    ports = [int(x) for x in args.port if x.isdigit() and int(x) < 65536]
    args.port = ports[0] if ports else int(os.environ.get('PORT', DEFAULT_PORT))
    return args


def open_store(data):
    try:
        return ConfigStore(data / 'config.json', root=data)
    except ConfigError as error:
        # Keep the unreadable file for inspection and start from defaults
        # rather than refusing to start at all.
        broken = data / 'config.json'
        kept = data / f'config.broken-{int(time.time())}.json'
        try:
            os.replace(broken, kept)
        except OSError:
            raise SystemExit(f'[live-direct] 配置无法读取: {error}') from None
        log(f'[系统] 警告: 配置无法读取 ({error})，已另存为 {kept.name} 并使用默认配置')
        return ConfigStore(broken, root=data)


# Environment settings, for hosts whose service page has an env editor (APTV).
# Setting any of them makes the environment the whole configuration: each
# start rebuilds every platform from it and admin edits last until restart.
ENV_FIELDS = {  # suffix -> (config field per platform, kind)
    'ROOMS': ('rooms', 'list'),
    'CATEGORIES': ('categories', 'categories'),
    'AREAS': ('categories', 'categories'),
    'COUNT': ('count', 'int'),
    'MIN_VIEWERS': ('min_viewers', 'int'),
    'QUALITY': ('quality', 'quality'),
    'ENABLED': ('enabled', 'bool'),
    'SHARE_LINKS': ('share_links', 'share'),
    'SESSDATA': ('sessdata', 'text'),
}
RENAMED = {'bilibili': {'categories': 'areas', 'count': 'top_per_area', 'min_viewers': 'min_online'}}
SPLIT = re.compile(r'[\s,，、;；]+')


def env_config(environ):
    """Config patch from DOUYIN_ROOMS-style variables, or None if none are set."""
    found = {}
    for platform in DEFAULTS:
        for suffix, (field, kind) in ENV_FIELDS.items():
            name = f'{platform.upper()}_{suffix}'
            value = environ.get(name)
            if value is None or not str(value).strip():
                continue
            field = RENAMED.get(platform, {}).get(field, field)
            if field not in DEFAULTS[platform]:
                raise ConfigError(f'{name}: {LABELS[platform]}不支持这个设置')
            value = str(value).strip()
            try:
                if kind == 'list':
                    parsed = [x for x in SPLIT.split(value) if x]
                elif kind == 'categories':
                    names = {v: k for k, v in CATEGORIES.get(platform, {}).items()}
                    parsed = [names.get(x, x) for x in SPLIT.split(value) if x]
                elif kind == 'share':
                    parsed = [m.rstrip('/') + '/' for m in re.findall(r'https://v\.douyin\.com/[A-Za-z0-9_-]+/?', value)]
                elif kind == 'int':
                    parsed = int(value)
                elif kind == 'bool':
                    if value.lower() not in ('1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'):
                        raise ValueError
                    parsed = value.lower() in ('1', 'true', 'yes', 'on')
                elif kind == 'quality':
                    parsed = value.upper() if platform == 'douyin' else int(value)
                else:
                    parsed = value
            except ValueError:
                raise ConfigError(f'{name}: 格式不对') from None
            found.setdefault(platform, {})[field] = parsed
    if not found:
        return None
    patch = {}
    for platform, defaults in DEFAULTS.items():
        values = {k: v for k, v in defaults.items() if k != 'sessdata'}
        values.update(found.get(platform, {}))
        if 'enabled' not in found.get(platform, {}):
            values['enabled'] = any(values.get(k) for k in ('rooms', 'share_links', 'categories', 'areas'))
        patch[platform] = values
    return patch


def apply_env(store, environ):
    patch = env_config(environ)
    if patch is None:
        return False
    store.update(patch)
    for platform, cfg in store.get().items():
        log(f'[配置] 环境变量 {LABELS.get(platform, platform)}: {describe_config(cfg)}', min_interval=0)
    return True


def build(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    data = choose_data_dir(args.data_dir)
    local = is_loopback(args.bind)
    store = open_store(data)
    try:
        from_env = apply_env(store, os.environ)
    except ConfigError as error:
        log(f'[配置] 环境变量有误: {error}', min_interval=0)
        raise SystemExit(f'[live-direct] 环境变量有误: {error}') from None
    if local:
        app = Application(store, '', '', f'http://127.0.0.1:{args.port}', local=True)
    else:
        admin, sub = load_secrets(data)
        base = (args.public_base or f'http://{args.bind}:{args.port}').rstrip('/')
        app = Application(store, admin, sub, base)
    app.engine.log = log
    app.engine.playlist_directives = APTV_DIRECTIVES
    srv = Server((args.bind, args.port), app)
    if local:
        # Port 0 asks the OS for a free port.
        app.port = srv.server_address[1]
        app.base = f'http://127.0.0.1:{app.port}'
    app.from_env = from_env
    return srv, app, data


def main(argv=None):
    try:
        srv, app, data = build(argv)
    except OSError as error:
        log(f'[系统] 启动失败: {error} (端口被占用时，先停掉旧的服务)')
        raise
    host, port = srv.server_address[:2]
    enabled = [LABELS.get(name, name) for name, cfg in app.store.get().items() if cfg.get('enabled')]
    banner = ['==============================================',
              f'Live Direct 已启动 (监听 {host}:{port})',
              f'订阅地址: {app.subscription_prefix(app.base)}/interface.m3u',
              f'管理后台: {app.base}/admin ' + ('(仅本机，免登录)' if app.local else f'(管理员令牌见 {data / SECRETS_FILE})'),
              f'配置目录: {data}',
              '配置来源: ' + ('环境变量（后台的修改在重启后会被环境变量覆盖）' if app.from_env else '管理后台'),
              '已启用平台: ' + ('、'.join(enabled) if enabled else '无。请先打开管理后台启用平台并添加主播'),
              '==============================================']
    for line in banner:
        log(line, min_interval=0)
    try:
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    except (ValueError, OSError):
        pass  # Not the main thread when a host runs us inside its own runner.
    with srv:
        app.engine.start_refresh()
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            log('[系统] 服务已停止')


if __name__ == '__main__':
    main()
