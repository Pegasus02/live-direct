#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MCP endpoint for Live Direct (Streamable HTTP, JSON-RPC 2.0).

The endpoint is mounted at ``/mcp`` on the same port as the web UI and needs the
same admin token as ``/admin`` (``Authorization: Bearer <ADMIN_TOKEN>``). It is
read/write: read tools report state, write tools apply the same configuration
patches the admin page posts to ``/api/config``.

List results carry ``ttlMs`` and ``cacheScope`` because MCP 2025-11-25 makes
them mandatory for cacheable list responses, and strict clients reject a
``tools/list`` result that omits them.
"""
import json

SERVER_INFO = {'name': 'live-direct', 'version': '1.0'}
PROTOCOL_VERSIONS = ('2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05')
DEFAULT_PROTOCOL = '2025-06-18'
INSTRUCTIONS = (
    'Live Direct 是自托管的直播间聚合服务：把抖音/B站/斗鱼/虎牙的房间整理成 M3U 订阅。'
    '调试顺序通常是 status → get_config → list_channels → resolve_stream。'
    '配置项变更用 update_config（与后台 /api/config 同一份校验），改完会自动触发刷新。'
    '凭据（如 bilibili.sessdata）在读取时会被脱敏为 sessdata_set，写入不受影响。'
)

_COMMON_LIST_SCHEMA = {
    'type': 'object',
    'additionalProperties': False,
    'properties': {
        'platform': {'type': 'string', 'enum': ['douyin', 'bilibili', 'douyu', 'huya']},
        'query': {'type': 'string', 'description': '按昵称或标题模糊匹配'},
        'limit': {'type': 'integer', 'minimum': 1, 'maximum': 2000, 'default': 200},
    },
}

TOOLS = [
    # ---- read-only ---------------------------------------------------------
    {
        'name': 'status',
        'description': '服务健康、各平台抓取状态、频道总数、是否正在刷新。',
        'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {}},
        'annotations': {'readOnlyHint': True},
    },
    {
        'name': 'get_config',
        'description': '读取当前平台配置（凭据已脱敏为 *_set 标记）。',
        'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {}},
        'annotations': {'readOnlyHint': True},
    },
    {
        'name': 'list_channels',
        'description': '列出已抓取的频道，可按平台或昵称过滤。',
        'inputSchema': _COMMON_LIST_SCHEMA,
        'annotations': {'readOnlyHint': True},
    },
    {
        'name': 'get_playlist',
        'description': '生成当前 M3U 订阅内容（可选只返回前 N 行，便于检查播放地址）。',
        'inputSchema': {
            'type': 'object',
            'additionalProperties': False,
            'properties': {'maxLines': {'type': 'integer', 'minimum': 1, 'maximum': 2000, 'default': 80}},
        },
        'annotations': {'readOnlyHint': True},
    },
    {
        'name': 'subscription_info',
        'description': '返回后台展示的订阅地址与当前订阅模式（固定内网 / 令牌）。',
        'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {}},
        'annotations': {'readOnlyHint': True},
    },
    {
        'name': 'resolve_stream',
        'description': '解析指定房间的播放地址，用于排查"能抓到但播不了"。',
        'inputSchema': {
            'type': 'object',
            'additionalProperties': False,
            'required': ['platform', 'room'],
            'properties': {
                'platform': {'type': 'string', 'enum': ['douyin', 'bilibili', 'douyu', 'huya']},
                'room': {'type': 'string', 'description': '房间号（网页房间号，不是内部 ID）'},
                'hls': {'type': 'boolean', 'default': False, 'description': '只接受 HLS 流'},
            },
        },
        'annotations': {'readOnlyHint': True},
    },
    {
        'name': 'get_logs',
        'description': '读取最近的服务日志（配置保存、播放解析失败等），用于定位问题。',
        'inputSchema': {
            'type': 'object',
            'additionalProperties': False,
            'properties': {'limit': {'type': 'integer', 'minimum': 1, 'maximum': 200, 'default': 50}},
        },
        'annotations': {'readOnlyHint': True},
    },
    # ---- write -------------------------------------------------------------
    {
        'name': 'update_config',
        'description': '按平台提交配置补丁（enabled/rooms/categories/count/min_viewers/quality 等），校验规则与后台一致，成功后自动刷新。',
        'inputSchema': {
            'type': 'object',
            'additionalProperties': False,
            'required': ['patch'],
            'properties': {
                'patch': {
                    'type': 'object',
                    'description': '形如 {"douyu": {"enabled": true, "rooms": ["9999"]}}',
                },
            },
        },
        'annotations': {'readOnlyHint': False, 'destructiveHint': False},
    },
    {
        'name': 'refresh',
        'description': '触发一次频道刷新（正在刷新时会排队追加一次）。',
        'inputSchema': {'type': 'object', 'additionalProperties': False, 'properties': {}},
        'annotations': {'readOnlyHint': False, 'destructiveHint': False},
    },
]

TOOL_INDEX = {tool['name']: tool for tool in TOOLS}


class MCPError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _text(payload):
    return [{'type': 'text', 'text': json.dumps(payload, ensure_ascii=False, indent=2)}]


def _tool_result(payload, error=False):
    return {'content': _text(payload), 'isError': error}


def _stream_payload(stream):
    return {
        'url': getattr(stream, 'url', None),
        'format': getattr(stream, 'format', None),
    }


def _filtered_channels(engine, args):
    platform = args.get('platform')
    query = (args.get('query') or '').strip().lower()
    limit = int(args.get('limit') or 200)
    rows = []
    for item in engine.list_channels():
        if platform and item['platform'] != platform:
            continue
        if query and query not in item['name'].lower() and query not in (item['title'] or '').lower():
            continue
        rows.append(item)
    return rows[:limit], len(rows)


def call_tool(app, name, args):
    """Run one tool. Raises MCPError for bad input; other exceptions become tool errors."""
    if name == 'status':
        state = app.engine.status()
        return {
            **state,
            'enabled': {platform: bool(cfg.get('enabled')) for platform, cfg in app.store.get(public=True).items()},
            'fixed_subscription': bool(getattr(app, 'fixed_subscription', False)),
        }
    if name == 'get_config':
        return {'config': app.store.get(public=True)}
    if name == 'list_channels':
        rows, total = _filtered_channels(app.engine, args)
        return {'total': total, 'returned': len(rows), 'channels': rows}
    if name == 'get_playlist':
        max_lines = int(args.get('maxLines') or 80)
        body = app.engine.playlist(app.base, app.sub_token, fixed=getattr(app, 'fixed_subscription', False))
        lines = body.decode().splitlines()
        return {'lines': len(lines), 'truncated': len(lines) > max_lines, 'playlist': '\n'.join(lines[:max_lines])}
    if name == 'subscription_info':
        prefix = app.subscription_prefix(app.base)
        return {
            'base': app.base,
            'fixed_subscription': bool(getattr(app, 'fixed_subscription', False)),
            'playlist_url': prefix + '/interface.m3u',
            'local_mode': bool(getattr(app, 'local', False)),
        }
    if name == 'resolve_stream':
        platform, room = args.get('platform'), str(args.get('room') or '')
        if platform not in TOOL_INDEX['resolve_stream']['inputSchema']['properties']['platform']['enum']:
            raise MCPError(-32602, 'platform 无效')
        if not room:
            raise MCPError(-32602, 'room 不能为空')
        app.engine.maybe_refresh()
        return _stream_payload(app.engine.resolve(platform, room, hls=bool(args.get('hls'))))
    if name == 'get_logs':
        limit = int(args.get('limit') or 50)
        return {'logs': app.engine.recent_logs(limit)}
    if name == 'update_config':
        patch = args.get('patch')
        if not isinstance(patch, dict) or not patch:
            raise MCPError(-32602, 'patch 必须是非空对象')
        result = app.store.update(patch)
        with app.engine.lock:
            pass
        app.engine.invalidate()
        accepted = app.engine.start_refresh()
        app.engine.log('[MCP] 配置已更新: ' + ', '.join(sorted(result)))
        return {'ok': True, 'config': app.store.get(public=True), 'refresh_started': bool(accepted)}
    if name == 'refresh':
        accepted = app.engine.start_refresh()
        return {'accepted': bool(accepted)}
    raise MCPError(-32602, f'未知工具: {name}')


def _initialize(params):
    requested = (params or {}).get('protocolVersion')
    version = requested if requested in PROTOCOL_VERSIONS else DEFAULT_PROTOCOL
    return {
        'protocolVersion': version,
        'capabilities': {'tools': {'listChanged': False}},
        'serverInfo': SERVER_INFO,
        'instructions': INSTRUCTIONS,
    }


def dispatch(app, payload):
    """Handle one JSON-RPC message. Returns (http_status, body_or_None)."""
    if isinstance(payload, list):  # batch: answer each item, keep it simple
        if not payload:
            return 400, _error(None, -32600, '空批量请求')
        replies = []
        for item in payload:
            status, reply = dispatch(app, item)
            if reply is not None:
                replies.append(reply)
        return (200 if replies else 202), replies or None
    if not isinstance(payload, dict) or payload.get('jsonrpc') != '2.0':
        return 400, _error(None, -32600, '不是 JSON-RPC 2.0 消息')
    method = payload.get('method')
    msg_id = payload.get('id')
    is_notification = 'id' not in payload
    if not isinstance(method, str):
        return 400, _error(msg_id, -32600, '缺少 method')
    try:
        if method == 'initialize':
            result = _initialize(payload.get('params'))
        elif method == 'notifications/initialized':
            return 202, None
        elif method == 'ping':
            result = {}
        elif method == 'tools/list':
            result = {'tools': TOOLS, 'ttlMs': 0, 'cacheScope': 'private'}
        elif method == 'tools/call':
            params = payload.get('params') or {}
            name = params.get('name')
            args = params.get('arguments') or {}
            if name not in TOOL_INDEX:
                raise MCPError(-32602, f'未知工具: {name}')
            if not isinstance(args, dict):
                raise MCPError(-32602, 'arguments 必须是对象')
            app.engine.log(f'[MCP] {name}')
            try:
                result = _tool_result(call_tool(app, name, args))
            except MCPError:
                raise
            except LookupError as error:
                result = _tool_result({'error': str(error) or '未找到'}, error=True)
            except Exception as error:  # surfaced to the agent, not raised
                result = _tool_result({'error': f'{type(error).__name__}: {error}'}, error=True)
        else:
            raise MCPError(-32601, f'不支持的方法: {method}')
    except MCPError as error:
        if is_notification:
            return 202, None
        return 200, _error(msg_id, error.code, error.message)
    if is_notification:
        return 202, None
    return 200, {'jsonrpc': '2.0', 'id': msg_id, 'result': result}


def _error(msg_id, code, message):
    return {'jsonrpc': '2.0', 'id': msg_id, 'error': {'code': code, 'message': message}}
