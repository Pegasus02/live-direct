/* Fixed same-origin API; no HTML interpolation, token storage, or stream URLs. */
'use strict';
(() => {
  // Each platform's form is generated from this schema. To add a platform, add an
  // entry here; the server must also register its provider, admin path and config schema.
  const PLATFORMS = [
    {
      id: 'douyin', name: '抖音', glyph: '抖', tagline: '手动房间 + 分类热门',
      room: { pattern: /^[A-Za-z0-9_-]{1,64}$/, numeric: false, hosts: ['live.douyin.com'], hint: '房间号，或 live.douyin.com 直播间链接' },
      categories: { key: 'categories', label: '推荐分类', max: 8, custom: false },
      count: { key: 'count', label: '推荐总数', max: 100, hint: '所有分类合计，按热度轮流挑选' },
      min: { key: 'min_viewers', label: '最低热度', hint: '低于此热度的房间不推荐' },
      quality: { numeric: false, options: [['FULL_HD1', '原画'], ['HD1', '高清'], ['SD2', '标清'], ['SD1', '流畅']] }
    },
    {
      id: 'bilibili', name: '哔哩哔哩', glyph: '哔', tagline: '手动房间 + 分区热门',
      room: { pattern: /^[0-9]{1,20}$/, numeric: true, hosts: ['live.bilibili.com'], hint: '数字房间号，或 live.bilibili.com 直播间链接' },
      categories: { key: 'areas', label: '推荐分区', max: 16, custom: true },
      count: { key: 'top_per_area', label: '每个分区', max: 50, hint: '每个分区最多取的房间数' },
      min: { key: 'min_online', label: '最低人气', hint: '低于此人气的房间不推荐' },
      quality: { numeric: true, options: [[10000, '原画'], [30000, '杜比'], [20000, '4K'], [400, '蓝光'], [250, '超清'], [150, '高清'], [80, '流畅'], [0, '最高可用']] },
      avc: true, login: true
    },
    {
      id: 'douyu', name: '斗鱼', glyph: '斗', tagline: '手动房间 + 分类热门',
      room: { pattern: /^[0-9]{1,12}$/, numeric: true, hosts: ['www.douyu.com', 'douyu.com'], hint: '数字房间号，或 www.douyu.com 直播间链接' },
      categories: { key: 'categories', label: '推荐分类', max: 8, custom: false },
      count: { key: 'count', label: '推荐总数', max: 100, hint: '所有分类合计，按热度轮流挑选' },
      min: { key: 'min_viewers', label: '最低热度', hint: '低于此热度的房间不推荐' },
      quality: { numeric: true, options: [[0, '原画'], [4, '蓝光 4M'], [3, '超清'], [2, '高清']] }
    },
    {
      id: 'huya', name: '虎牙', glyph: '虎', tagline: '手动房间 + 分类热门',
      room: { pattern: /^(?![gGmMlL]$)[A-Za-z0-9_-]{1,64}$/, numeric: false, hosts: ['www.huya.com', 'huya.com'], hint: '房间号，或 www.huya.com 直播间链接' },
      categories: { key: 'categories', label: '推荐分类', max: 8, custom: false },
      count: { key: 'count', label: '推荐总数', max: 100, hint: '所有分类合计，按热度轮流挑选' },
      min: { key: 'min_viewers', label: '最低热度', hint: '低于此热度的房间不推荐' },
      quality: { numeric: true, options: [[0, '原画'], [20000, '4K'], [14000, '2K'], [4000, '蓝光 4M'], [2000, '超清'], [500, '流畅']] }
    }
  ];
  const CUSTOM_CATEGORY = /^[A-Za-z0-9_\-一-鿿]{1,64}$/u;
  const byId = id => document.getElementById(id);
  const active = PLATFORMS.find(platform => `/admin/${platform.id}` === window.location.pathname);
  const state = { csrf: '', subscription: '', config: null, categories: {}, status: null, channels: [], filter: 'all', query: '', busy: true, polling: false };
  let draft = null;
  let saved = '';

  // ---------- DOM helpers (textContent only; never parse server strings as HTML) ----------
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key in node && typeof value !== 'string') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }
  function icon(name, extra = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `icon ${extra}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }
  const badge = (platform, size = '') => h('span', { class: `platform-badge p-${platform.id} ${size}`.trim(), 'aria-hidden': 'true', text: platform.glyph });
  function toggle(id, checked, label, onchange) {
    return h('label', { class: 'switch' },
      h('input', { type: 'checkbox', role: 'switch', id, checked, 'aria-label': label, onchange }),
      h('span', { class: 'switch-track', 'aria-hidden': 'true' }));
  }

  // ---------- Toasts ----------
  function toast(message, kind = 'info') {
    const close = h('button', { class: 'toast-close', type: 'button', 'aria-label': '关闭提示' }, icon('x'));
    const node = h('div', { class: `toast toast-${kind}` }, icon(kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'refresh'), h('span', { text: message }), close);
    const remove = () => node.remove();
    close.addEventListener('click', remove);
    byId('toasts').append(node);
    while (byId('toasts').children.length > 4) byId('toasts').firstElementChild.remove();
    setTimeout(remove, kind === 'error' ? 8000 : 4000);
  }

  // ---------- API (only controlled messages are surfaced: response errors may contain secrets) ----------
  async function api(path, body) {
    const options = { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      if (!state.csrf) throw new Error('安全会话尚未就绪，请重新登录。');
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.headers['X-CSRF-Token'] = state.csrf;
      options.body = JSON.stringify(body);
    }
    let response;
    try { response = await fetch(path, options); }
    catch (_) { throw new Error('连接失败，请检查服务后重试。'); }
    if (response.status === 401) { window.location.assign('/login'); throw new Error('登录已失效。'); }
    if (response.status === 403) throw new Error('安全校验失败，请重新登录。');
    if (!response.ok) throw new Error(response.status === 400 ? '配置未通过校验，请检查字段格式与范围。' : '请求未完成，请稍后重试。');
    if (response.status === 204) return {};
    try { return await response.json(); }
    catch (_) { throw new Error('服务返回格式异常。'); }
  }

  // ---------- Status helpers ----------
  function relative(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch <= 0) return '';
    const seconds = Math.max(0, Math.round(Date.now() / 1000 - epoch));
    if (seconds < 60) return '刚刚';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    return `${Math.floor(seconds / 86400)} 天前`;
  }
  // Warnings are translated from known fixed provider texts; unknown text is never rendered.
  function warnings(list) {
    const counts = new Map();
    for (const item of Array.isArray(list) ? list : []) {
      if (typeof item !== 'string') continue;
      const text = /^Discovery time budget/.test(item) ? '耗时超出预算，部分内容推迟到下次刷新'
        : /^A manual .+ room could not be fetched$/.test(item) ? '有手动房间获取失败'
        : /room could not be fetched$/.test(item) ? '有房间获取失败'
        : /(category|area) could not be fetched$/.test(item) ? '有分类获取失败'
        : /no trusted stream$/.test(item) ? '有房间没有可用的直播流'
        : '其他警告';
      counts.set(text, (counts.get(text) || 0) + 1);
    }
    return [...counts].map(([text, n]) => n > 1 ? `${text} ×${n}` : text);
  }
  function platformState(platform) {
    const config = state.config?.[platform.id] || {};
    const info = state.status?.platforms?.[platform.id] || {};
    if (!config.enabled) return { key: 'off', label: '已关闭' };
    if (state.status?.refreshing) return { key: 'busy', label: '刷新中' };
    if (info.status === 'error') return { key: 'error', label: info.cached ? '失败 · 显示旧列表' : '抓取失败' };
    if (info.status === 'ok') return warnings(info.warnings).length ? { key: 'warn', label: '部分异常' } : { key: 'ok', label: '正常' };
    return { key: 'idle', label: '等待刷新' };
  }
  const pill = st => h('span', { class: `pill pill-${st.key}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), st.label);

  // ---------- Navigation & page chrome ----------
  function renderNav() {
    const nav = byId('nav');
    nav.replaceChildren();
    const counts = countByPlatform();
    nav.append(h('a', { href: '/admin', class: 'nav-item', 'aria-current': active ? null : 'page' },
      h('span', { class: 'nav-icon' }, icon('home')), h('span', { class: 'nav-label', text: '总览' }),
      h('span', { class: 'nav-meta', text: state.channels.length ? String(state.channels.length) : '' })));
    nav.append(h('p', { class: 'nav-heading', text: '平台' }));
    for (const platform of PLATFORMS) {
      const st = platformState(platform);
      nav.append(h('a', { href: `/admin/${platform.id}`, class: 'nav-item', 'aria-current': active === platform ? 'page' : null },
        badge(platform, 'sm'), h('span', { class: 'nav-label', text: platform.name }),
        h('span', { class: 'nav-meta' }, counts[platform.id] ? String(counts[platform.id]) : '', h('span', { class: `dot dot-${st.key}`, title: st.label }))));
    }
  }
  function renderHead() {
    document.title = `${active ? active.name : '总览'} · Live Direct`;
    byId('page-title').textContent = active ? `${active.name}直播` : '总览';
    byId('page-description').textContent = active
      ? '管理该平台的房间、推荐与画质；保存不会影响其他平台。'
      : '查看各平台运行状态和全部频道，复制私有订阅到播放器。';
    const pageBadge = byId('page-badge');
    if (active) { pageBadge.hidden = false; pageBadge.className = `platform-badge p-${active.id} lg`; pageBadge.textContent = active.glyph; }
    byId('overview-view').hidden = Boolean(active);
    byId('config-form').hidden = !active;
    byId('channels-heading').textContent = active ? `${active.name}频道` : '全部频道';
    byId('channel-filters').hidden = Boolean(active);
  }
  function renderRefreshInfo() {
    const times = Object.values(state.status?.platforms || {}).map(info => info.last_success).filter(Number.isSafeInteger);
    const latest = times.length ? Math.max(...times) : 0;
    const label = relative(latest);
    byId('last-refresh').textContent = state.status?.refreshing ? '正在刷新…' : label ? `${label}更新` : '';
    byId('refresh').classList.toggle('spinning', Boolean(state.status?.refreshing));
    if (!active) {
      byId('stat-channels').textContent = Number.isSafeInteger(state.status?.channel_count) ? String(state.status.channel_count) : '—';
      byId('stat-enabled').textContent = state.config ? `${PLATFORMS.filter(p => state.config[p.id]?.enabled).length} / ${PLATFORMS.length}` : '—';
      byId('stat-updated').textContent = state.status?.refreshing ? '刷新中' : (label || '尚未刷新');
    }
  }

  // ---------- Overview ----------
  function renderOverview() {
    if (active || !state.config) return;
    const root = byId('platform-cards');
    root.replaceChildren();
    const counts = countByPlatform();
    for (const platform of PLATFORMS) {
      const config = state.config[platform.id] || {};
      const info = state.status?.platforms?.[platform.id] || {};
      const st = platformState(platform);
      const notes = config.enabled ? warnings(info.warnings).slice(0, 3) : [];
      const detail = !config.enabled ? '启用后才会向该平台发起请求'
        : info.last_success ? `上次成功：${relative(info.last_success)}` : '尚未成功刷新';
      root.append(h('article', { class: `platform-card ${config.enabled ? '' : 'is-off'}`.trim() },
        h('div', { class: 'platform-card-head' }, badge(platform), h('div', {}, h('h3', { text: platform.name }), pill(st)),
          toggle(`quick-${platform.id}`, Boolean(config.enabled), `启用${platform.name}`, event => quickToggle(platform, event.target))),
        h('p', { class: 'platform-count' }, h('strong', { text: String(counts[platform.id] || 0) }), h('span', { class: 'muted', text: ' 个频道' })),
        h('p', { class: 'muted small', text: detail }),
        notes.length ? h('ul', { class: 'warning-list' }, notes.map(note => h('li', {}, icon('alert'), note))) : null,
        h('a', { class: 'card-link', href: `/admin/${platform.id}` }, '配置', icon('arrow'))));
    }
  }
  async function quickToggle(platform, input) {
    input.disabled = true;
    try {
      state.config = await api('/api/config', { [platform.id]: { enabled: input.checked } });
      toast(`${platform.name}已${input.checked ? '启用，正在刷新频道' : '关闭'}。`, 'success');
      await refreshData();
    } catch (error) {
      input.checked = !input.checked;
      toast(error.message, 'error');
    } finally { input.disabled = false; }
  }

  // ---------- Platform configuration form ----------
  function normalizeCategories(platform, values) {
    const known = state.categories[platform.id] || [];
    return [...new Set((values || []).map(value => known.find(c => c.name === value)?.id || String(value)))];
  }
  function draftFrom(platform, config) {
    const values = config[platform.id] || {};
    return {
      enabled: values.enabled === true,
      rooms: Array.isArray(values.rooms) ? [...values.rooms] : [],
      [platform.categories.key]: normalizeCategories(platform, values[platform.categories.key]),
      [platform.count.key]: values[platform.count.key],
      [platform.min.key]: values[platform.min.key],
      quality: values.quality,
      ...(platform.avc ? { prefer_avc: values.prefer_avc === true } : {})
    };
  }
  const secretDraft = { sessdata: '', clear: false };
  function isDirty() { return Boolean(draft) && (JSON.stringify(draft) !== saved || Boolean(secretDraft.sessdata) || secretDraft.clear); }
  function updateDirty() {
    const dirty = isDirty();
    byId('save-bar').hidden = !dirty;
    byId('save').disabled = state.busy || !dirty;
  }
  function parseRoom(platform, raw) {
    let value = raw.trim();
    if (!value) return null;
    if (!platform.room.pattern.test(value)) {
      try {
        const url = new URL(value);
        const path = url.pathname.replace(/^\/+|\/+$/g, '');
        if (!['http:', 'https:'].includes(url.protocol) || !platform.room.hosts.includes(url.host) || url.search || url.hash || !platform.room.pattern.test(path)) return undefined;
        value = path;
      } catch (_) { return undefined; }
    }
    if (platform.room.numeric) {
      value = value.replace(/^0+(?=\d)/, '');
      if (/^0+$/.test(value)) return undefined;
    }
    return value;
  }
  function section(title, hint, ...body) {
    return h('section', { class: 'card form-card' }, h('div', { class: 'form-card-head' }, h('h2', { text: title }), hint ? h('p', { class: 'muted small', text: hint }) : null), ...body);
  }
  function roomsEditor(platform) {
    const list = h('ul', { class: 'chips', 'aria-label': '已添加的房间' });
    const counter = h('span', { class: 'muted small' });
    const error = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const input = h('input', { id: `${platform.id}-room-input`, type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '输入房间号或链接，回车添加；可一次粘贴多行' });
    function render() {
      list.replaceChildren(...draft.rooms.map(room => h('li', { class: 'chip' }, h('span', { class: 'mono', text: room }),
        h('button', { type: 'button', class: 'chip-remove', 'aria-label': `移除房间 ${room}`, onclick: () => { draft.rooms = draft.rooms.filter(r => r !== room); render(); updateDirty(); } }, icon('x')))));
      if (!draft.rooms.length) list.append(h('li', { class: 'chips-empty muted', text: '还没有手动房间，只会抓取推荐频道。' }));
      counter.textContent = `${draft.rooms.length} / 100`;
    }
    function add() {
      const tokens = input.value.split(/[\s,，]+/u).filter(Boolean);
      const rejected = [];
      for (const token of tokens) {
        const room = parseRoom(platform, token);
        if (room === undefined) rejected.push(token);
        else if (room && !draft.rooms.includes(room)) {
          if (draft.rooms.length >= 100) { rejected.push(token); continue; }
          draft.rooms.push(room);
        }
      }
      input.value = rejected.join('\n');
      error.hidden = !rejected.length;
      error.textContent = rejected.length ? `无法识别 ${rejected.length} 项：请使用${platform.room.hint}。` : '';
      render(); updateDirty();
    }
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); add(); } });
    input.addEventListener('paste', () => setTimeout(() => { if (/[\n,，]/u.test(input.value)) add(); }));
    render();
    return section('手动房间', `${platform.room.hint}。链接会自动转换为房间号；未开播的房间不会出现在订阅里。`,
      list, h('div', { class: 'add-row' }, h('label', { class: 'sr-only', for: input.id, text: '添加房间' }), input,
        h('button', { type: 'button', class: 'btn', onclick: add }, icon('plus'), '添加')), error, h('div', { class: 'card-foot' }, counter));
  }
  function numberField(platform, spec) {
    const id = `${platform.id}-${spec.key.replaceAll('_', '-')}`;
    const max = spec.max || 1000000000;
    const error = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const input = h('input', { id, type: 'number', inputmode: 'numeric', min: '0', max: String(max), step: '1', value: String(draft[spec.key] ?? 0) });
    input.addEventListener('input', () => {
      const value = Number(input.value);
      const valid = input.value !== '' && Number.isInteger(value) && value >= 0 && value <= max;
      draft[spec.key] = valid ? value : input.value;
      input.setAttribute('aria-invalid', String(!valid));
      error.hidden = valid;
      error.textContent = valid ? '' : `请输入 0 – ${max} 的整数`;
      updateDirty();
    });
    return h('div', { class: 'field' }, h('label', { for: id, text: spec.label }), input, h('p', { class: 'muted small', text: spec.hint }), error);
  }
  function categoriesEditor(platform) {
    const spec = platform.categories;
    const key = spec.key;
    const known = state.categories[platform.id] || [];
    const group = h('div', { class: 'choice-chips', role: 'group', 'aria-label': spec.label });
    const counter = h('span', { class: 'muted small' });
    const error = h('p', { class: 'field-error', role: 'alert', hidden: true });
    function render() {
      group.replaceChildren();
      for (const category of known) {
        const on = draft[key].includes(category.id);
        group.append(h('button', { type: 'button', class: 'choice', 'aria-pressed': String(on), onclick: () => {
          if (on) draft[key] = draft[key].filter(v => v !== category.id);
          else if (draft[key].length < spec.max) draft[key] = [...draft[key], category.id];
          else { toast(`最多选择 ${spec.max} 个${spec.label.slice(2)}。`, 'error'); return; }
          render(); updateDirty();
        } }, on ? icon('check') : null, category.name));
      }
      for (const value of draft[key].filter(v => !known.some(c => c.id === v))) {
        group.append(h('span', { class: `choice choice-custom ${spec.custom ? '' : 'choice-invalid'}`.trim(), title: spec.custom ? '自定义' : '该平台不支持此分类，保存会失败' },
          value, h('button', { type: 'button', class: 'chip-remove', 'aria-label': `移除 ${value}`, onclick: () => { draft[key] = draft[key].filter(v => v !== value); render(); updateDirty(); } }, icon('x'))));
      }
      counter.textContent = draft[key].length ? `已选 ${draft[key].length} / ${spec.max}` : '未选择：不抓取推荐频道';
    }
    let custom = null;
    if (spec.custom) {
      const input = h('input', { id: `${platform.id}-custom-category`, type: 'text', autocomplete: 'off', placeholder: '其他分区名称或 ID' });
      const add = () => {
        const value = input.value.trim();
        if (!value) return;
        const id = known.find(c => c.name === value)?.id || value;
        if (!CUSTOM_CATEGORY.test(id)) { error.hidden = false; error.textContent = '只能包含中文、字母、数字、下划线或连字符。'; return; }
        if (draft[key].length >= spec.max) { error.hidden = false; error.textContent = `最多 ${spec.max} 个。`; return; }
        if (!draft[key].includes(id)) draft[key] = [...draft[key], id];
        input.value = ''; error.hidden = true; render(); updateDirty();
      };
      input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); add(); } });
      custom = h('div', { class: 'add-row' }, h('label', { class: 'sr-only', for: input.id, text: '添加其他分区' }), input, h('button', { type: 'button', class: 'btn', onclick: add }, icon('plus'), '添加'));
    }
    render();
    return section(spec.label, '点选需要的分类，按热度自动挑选正在直播的房间。', group, custom, error,
      h('div', { class: 'field-grid' }, numberField(platform, platform.count), numberField(platform, platform.min)),
      h('div', { class: 'card-foot' }, counter));
  }
  function qualityEditor(platform) {
    const name = `${platform.id}-quality`;
    const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': '画质偏好' });
    for (const [value, label] of platform.quality.options) {
      const id = `${name}-${value}`;
      group.append(h('input', { type: 'radio', class: 'sr-only', name, id, value: String(value), checked: draft.quality === value,
        onchange: () => { draft.quality = value; updateDirty(); } }), h('label', { for: id, text: label }));
    }
    const extra = platform.avc ? h('div', { class: 'switch-row' },
      h('div', {}, h('b', { text: '优先 H.264' }), h('p', { class: 'muted small', text: '兼容性更好；关闭后优先 HEVC，部分播放器可能无法解码。' })),
      toggle(`${platform.id}-prefer-avc`, draft.prefer_avc, '优先 H.264', event => { draft.prefer_avc = event.target.checked; updateDirty(); })) : null;
    return section('画质偏好', '实际画质取决于直播间可用档位，未登录时平台可能降档。HTTP-FLV 优先，没有时回退 HLS。', group, extra);
  }
  function loginEditor(platform) {
    const configured = Boolean(state.config?.[platform.id]?.sessdata_set);
    const status = pill(configured ? { key: 'ok', label: '已保存 · 有效性未验证' } : { key: 'off', label: '未配置 · 匿名模式' });
    const qrCode = h('div', { class: 'qr-code' });
    const qrStatus = h('p', { class: 'muted', text: '正在获取登录二维码…' });
    const qrCancel = h('button', { type: 'button', class: 'btn btn-ghost', text: '取消' });
    const qrBox = h('div', { class: 'qr-box', hidden: true }, qrCode, h('div', {}, h('b', { text: '使用哔哩哔哩手机客户端扫码' }), qrStatus, qrCancel));
    const qrButton = h('button', { type: 'button', class: 'btn' }, icon('qr'), '扫码登录');
    const secret = h('input', { id: 'bilibili-sessdata', type: 'password', autocomplete: 'new-password', spellcheck: 'false', placeholder: '留空则保留现有凭证',
      oninput: event => { secretDraft.sessdata = event.target.value; updateDirty(); } });
    const clear = h('input', { type: 'checkbox', id: 'clear-sessdata', disabled: !configured, onchange: event => {
      secretDraft.clear = event.target.checked; secret.disabled = event.target.checked; secret.value = ''; secretDraft.sessdata = ''; updateDirty();
    } });
    let timer = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    qrCancel.addEventListener('click', () => { stop(); qrBox.hidden = true; qrButton.disabled = false; });
    qrButton.addEventListener('click', async () => {
      stop(); qrBox.hidden = false; qrButton.disabled = true; qrStatus.textContent = '正在获取登录二维码…'; qrCode.replaceChildren();
      try {
        const data = await api('/api/bilibili/qrcode/generate', {});
        if (!data.url || !data.qrcode_key) throw new Error('生成二维码失败');
        if (typeof qrcode !== 'undefined') {
          const qr = qrcode(0, 'M'); qr.addData(data.url); qr.make();
          const wrap = document.createElement('div');
          wrap.innerHTML = qr.createSvgTag({ scalable: true }); // Locally generated SVG markup, not server text.
          qrCode.replaceChildren(wrap.firstElementChild || wrap);
        } else qrCode.textContent = '二维码组件未载入';
        qrStatus.textContent = '等待扫码…';
        let count = 0;
        timer = setInterval(async () => {
          if (++count > 90) { stop(); qrStatus.textContent = '二维码已失效，请重新生成。'; qrButton.disabled = false; return; }
          try {
            const poll = await api('/api/bilibili/qrcode/poll', { qrcode_key: data.qrcode_key });
            if (poll.status === 'success') {
              stop(); qrBox.hidden = true; qrButton.disabled = false;
              toast('扫码登录成功，凭据已保存并开始刷新频道。', 'success');
              state.config = await api('/api/config');
              loadDraft(); await refreshData();
            } else if (poll.status === 'scanned') qrStatus.textContent = '已扫码，请在手机上确认登录。';
            else if (poll.status === 'expired') { stop(); qrStatus.textContent = '二维码已失效，请重新生成。'; qrButton.disabled = false; }
          } catch (_) { /* Transient poll failures are retried on the next tick. */ }
        }, 2000);
      } catch (error) { qrStatus.textContent = error.message || '获取失败'; qrButton.disabled = false; }
    });
    return section('登录态（可选）', '匿名可用时无需登录；登录后可获取账号本来有权限的更高画质。凭证只发往固定官方接口，不回显、不写入浏览器存储。',
      h('div', { class: 'switch-row' }, h('div', {}, h('b', { text: '当前状态' }), h('p', {}, status)), qrButton), qrBox,
      h('details', { class: 'advanced' }, h('summary', { text: '手动填写 SESSDATA' }),
        h('div', { class: 'field' }, h('label', { for: secret.id, text: '替换 SESSDATA' }), secret),
        h('label', { class: 'check' }, clear, '清除已保存的 SESSDATA')));
  }
  function renderForm() {
    if (!active || !draft) return;
    const body = byId('config-body');
    body.replaceChildren(
      h('section', { class: 'card enable-card' },
        h('div', { class: 'switch-row' }, h('div', {}, h('h2', { text: `启用${active.name}` }), h('p', { class: 'muted small', text: `${active.tagline}。关闭后不会向${active.name}发起任何请求。` })),
          toggle(`${active.id}-enabled`, draft.enabled, `启用${active.name}`, event => { draft.enabled = event.target.checked; updateDirty(); }))),
      ...[roomsEditor(active), categoriesEditor(active), qualityEditor(active), active.login ? loginEditor(active) : null].filter(Boolean));
    updateDirty();
  }
  function loadDraft() {
    if (!active || !state.config) return;
    draft = draftFrom(active, state.config);
    saved = JSON.stringify(draft);
    secretDraft.sessdata = ''; secretDraft.clear = false;
    renderForm();
  }
  function buildPatch() {
    for (const spec of [active.count, active.min]) {
      if (!Number.isInteger(draft[spec.key])) {
        byId(`${active.id}-${spec.key.replaceAll('_', '-')}`).focus();
        throw new Error(`「${spec.label}」需要填写有效的整数。`);
      }
    }
    const values = JSON.parse(JSON.stringify(draft));
    if (active.login) {
      if (secretDraft.clear) values.clear_sessdata = true;
      else if (secretDraft.sessdata) values.sessdata = secretDraft.sessdata;
    }
    // Partial updates preserve other platforms and fields not represented by this form.
    return { [active.id]: values };
  }

  // ---------- Channels ----------
  function countByPlatform() {
    const counts = {};
    for (const item of state.channels) counts[item.platform] = (counts[item.platform] || 0) + 1;
    return counts;
  }
  function safeText(value, fallback = '') {
    return typeof value === 'string' && !/https?:\/\/|sessdata|[?&](?:token|sign|auth)=/i.test(value) ? value.slice(0, 240) : fallback;
  }
  function renderFilters() {
    if (active) return;
    const counts = countByPlatform();
    const root = byId('channel-filters');
    root.replaceChildren(...[{ id: 'all', name: '全部' }, ...PLATFORMS].map(item => h('button', {
      type: 'button', class: 'filter', 'aria-pressed': String(state.filter === item.id),
      onclick: () => { state.filter = item.id; renderFilters(); renderChannels(); }
    }, item.name, h('span', { class: 'filter-count', text: String(item.id === 'all' ? state.channels.length : counts[item.id] || 0) }))));
  }
  function renderChannels() {
    const scope = active ? active.id : state.filter;
    const query = state.query.trim().toLowerCase();
    const scoped = state.channels.filter(item => scope === 'all' || item.platform === scope);
    const visible = scoped.filter(item => !query || [item.name, item.title, item.room_id].some(v => typeof v === 'string' && v.toLowerCase().includes(query)));
    byId('channels-summary').textContent = query ? `匹配 ${visible.length} / ${scoped.length} 个频道` : `${scoped.length} 个频道 · 仅展示元数据，不显示播放直链`;
    const root = byId('channel-list');
    root.replaceChildren();
    if (!visible.length) {
      const enabled = PLATFORMS.filter(p => state.config?.[p.id]?.enabled);
      const message = query ? '没有匹配的频道。'
        : active && !state.config?.[active.id]?.enabled ? `${active.name}尚未启用。打开上方「启用${active.name}」并保存即可开始抓取。`
        : !active && !enabled.length ? '还没有启用任何平台。在左侧选择一个平台，添加房间或推荐分类后启用。'
        : state.status?.refreshing ? '正在刷新频道…' : '暂无正在直播的频道。可以添加更多房间、选择推荐分类，或稍后刷新。';
      root.append(h('div', { class: 'empty' }, icon(query ? 'search' : 'tv', 'empty-icon'), h('p', { class: 'muted', text: message })));
      return;
    }
    for (const item of visible.slice(0, 1000)) {
      const platform = PLATFORMS.find(p => p.id === item.platform);
      root.append(h('div', { class: 'channel-row' },
        platform ? badge(platform) : h('span', { class: 'platform-badge', text: '?' }),
        h('div', { class: 'channel-main' }, h('strong', { text: safeText(item.name, '未命名频道') }), h('span', { class: 'muted small', text: safeText(item.title, '') })),
        h('span', { class: 'channel-id mono muted small', text: /^[A-Za-z0-9_-]{1,64}$/.test(item.room_id) ? item.room_id : '' })));
    }
  }

  // ---------- Data flow ----------
  function renderAll() { renderNav(); renderRefreshInfo(); renderOverview(); renderFilters(); renderChannels(); }
  async function refreshData() {
    const [status, channels] = await Promise.all([api('/api/status'), api('/api/channels')]);
    state.status = status;
    const items = Array.isArray(channels) ? channels : channels.channels;
    state.channels = Array.isArray(items) ? items.filter(item => item && typeof item.platform === 'string') : [];
    renderAll();
    if (status.refreshing) watchRefresh();
    return status;
  }
  async function watchRefresh() {
    if (state.polling) return;
    state.polling = true;
    try {
      for (let n = 0; n < 90; n++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const status = await refreshData();
        if (!status.refreshing) {
          const scope = active ? [status.platforms?.[active.id] || {}] : Object.values(status.platforms || {});
          if (scope.some(info => info.status === 'error')) toast('部分平台刷新失败，可能显示上次成功的结果。', 'error');
          else toast('频道列表已更新。', 'success');
          return;
        }
      }
      toast('刷新仍未结束，请稍后查看。', 'error');
    } catch (_) { toast('状态查询失败，请稍后重试。', 'error'); }
    finally { state.polling = false; }
  }
  function lock(value) {
    state.busy = value;
    byId('refresh').disabled = value;
    updateDirty();
  }
  async function copySubscription() {
    if (!state.subscription) { toast('订阅地址尚未就绪。', 'error'); return; }
    try { await navigator.clipboard.writeText(state.subscription); toast('订阅地址已复制，请勿公开分享。', 'success'); }
    catch (_) { window.prompt('请手动复制私密订阅地址，勿公开分享：', state.subscription); }
  }

  byId('config-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.busy || !active || !isDirty()) return;
    let body;
    try { body = buildPatch(); } catch (error) { toast(error.message, 'error'); return; }
    lock(true);
    try {
      state.config = await api('/api/config', body);
      loadDraft();
      toast(`${active.name}配置已保存，正在刷新频道。`, 'success');
      await refreshData();
    } catch (error) { toast(error.message, 'error'); }
    finally { lock(false); }
  });
  byId('discard').addEventListener('click', () => { loadDraft(); toast('已撤销未保存的更改。'); });
  byId('refresh').addEventListener('click', async () => {
    if (state.busy) return;
    lock(true);
    try { await api('/api/refresh', {}); state.status = { ...(state.status || {}), refreshing: true }; renderAll(); await refreshData(); watchRefresh(); }
    catch (error) { toast(error.message, 'error'); }
    finally { lock(false); }
  });
  byId('channel-search').addEventListener('input', event => { state.query = event.target.value; renderChannels(); });
  byId('copy-subscription').addEventListener('click', copySubscription);
  byId('copy-subscription-2').addEventListener('click', copySubscription);
  byId('logout').addEventListener('click', async () => {
    try { await api('/api/logout', {}); window.location.assign('/login'); }
    catch (_) { toast('退出失败，请重试。', 'error'); }
  });
  window.addEventListener('beforeunload', event => { if (isDirty()) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && active) { event.preventDefault(); byId('config-form').requestSubmit(); }
  });
  setInterval(renderRefreshInfo, 30000);

  async function start() {
    renderHead();
    renderNav();
    try {
      const session = await api('/api/session');
      if (typeof session.csrf !== 'string' || !session.csrf) throw new Error('安全会话尚未就绪，请重新登录。');
      state.csrf = session.csrf;
      if (session.auth_enabled === false) { byId('logout').hidden = true; byId('open-warning').hidden = false; }
      const [config, meta] = await Promise.all([api('/api/config'), api('/api/meta').catch(() => ({}))]);
      for (const item of Array.isArray(meta.platforms) ? meta.platforms : []) {
        if (typeof item?.id === 'string' && Array.isArray(item.categories)) {
          state.categories[item.id] = item.categories.filter(c => typeof c?.id === 'string' && typeof c?.name === 'string');
        }
      }
      state.config = config;
      loadDraft();
      lock(false);
      const status = await refreshData();
      // Discovery otherwise only runs when a player loads the playlist; start it once
      // so an enabled platform that has never been fetched shows real channels.
      if (!status.refreshing && PLATFORMS.some(p => config[p.id]?.enabled && !status.platforms?.[p.id])) {
        try { await api('/api/refresh', {}); await refreshData(); watchRefresh(); } catch (_) { /* Manual refresh remains available. */ }
      }
      try {
        const info = await api('/api/subscription');
        const parsed = typeof info.url === 'string' ? new URL(info.url, window.location.origin) : null;
        if (parsed && ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
          state.subscription = parsed.href;
          byId('copy-subscription').disabled = false;
          byId('copy-subscription-2').disabled = false;
        }
      } catch (_) { /* Subscription unavailability does not disable configuration. */ }
    } catch (error) { toast(error.message, 'error'); }
  }
  start();
})();
