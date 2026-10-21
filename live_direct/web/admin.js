/* Fixed same-origin API; no HTML interpolation, token storage, or stream URLs. */
'use strict';
(() => {
  const byId = id => document.getElementById(id);
  let csrf = '';
  let subscription = '';
  let busy = false;
  const notify = (message, error = false) => {
    byId('notice').textContent = message;
    byId('notice').classList.toggle('error', error);
  };
  // Only controlled messages are surfaced: response errors may contain secrets.
  async function api(path, patch) {
    const options = { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (patch !== undefined) {
      if (!csrf) throw new Error('安全会话尚未就绪，请重新登录。');
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.headers['X-CSRF-Token'] = csrf;
      options.body = JSON.stringify(patch);
    }
    let response;
    try { response = await fetch(path, options); }
    catch (_) { throw new Error('连接失败，请检查服务后重试。'); }
    if (response.status === 401) { window.location.assign('/login'); throw new Error('登录已失效。'); }
    if (response.status === 403) throw new Error('安全校验失败，请重新登录。');
    if (!response.ok) throw new Error(response.status === 400 ? '配置未通过校验，请检查字段格式与范围。' : '请求未完成，请稍后重试。');
    if (response.status === 204) return {};
    return response.json();
  }
  function fill(config) {
    for (const platform of ['douyin', 'bilibili']) {
      const values = config[platform];
      for (const [key, value] of Object.entries(values)) {
        if (key === 'sessdata' || key === 'sessdata_set') continue;
        const input = byId(`${platform}-${key.replaceAll('_', '-')}`);
        if (!input) continue;
        if (input.type === 'checkbox') input.checked = value === true;
        else input.value = Array.isArray(value) ? value.join(key === 'rooms' ? '\n' : ', ') : String(value);
      }
    }
    byId('bilibili-sessdata').value = '';
    byId('clear-sessdata').checked = false;
    byId('bilibili-sessdata').disabled = false;
    byId('secret-state').textContent = config.bilibili.sessdata_set ? '已配置 · 有效性未验证' : '未配置 · 匿名模式';
  }
  const list = id => byId(id).value.split(/[\s,，]+/u).filter(Boolean);
  function patch() {
    const result = {};
    for (const platform of ['douyin', 'bilibili']) {
      result[platform] = {
        enabled: byId(`${platform}-enabled`).checked,
        rooms: list(`${platform}-rooms`),
        quality: platform === 'douyin' ? byId('douyin-quality').value : Number(byId('bilibili-quality').value)
      };
    }
    Object.assign(result.douyin, {categories: list('douyin-categories'), count: Number(byId('douyin-count').value), min_viewers: Number(byId('douyin-min-viewers').value)});
    Object.assign(result.bilibili, {areas: list('bilibili-areas'), top_per_area: Number(byId('bilibili-top-per-area').value), min_online: Number(byId('bilibili-min-online').value), prefer_avc: byId('bilibili-prefer-avc').checked});
    if (byId('clear-sessdata').checked) result.bilibili.clear_sessdata = true;
    else if (byId('bilibili-sessdata').value) result.bilibili.sessdata = byId('bilibili-sessdata').value;
    return result;
  }
  function safeText(value, fallback = '') {
    // Suppress URL-like values even in metadata, not just known stream fields.
    return typeof value === 'string' && !/https?:\/\/|sessdata|[?&](?:token|sign|auth)=/i.test(value) ? value.slice(0, 240) : fallback;
  }
  function showStatus(status) {
    byId('channel-count').textContent = Number.isSafeInteger(status.channel_count) ? String(status.channel_count) : '—';
    const states = status.platforms || status.providers || {};
    for (const platform of ['douyin', 'bilibili']) {
      const state = states[platform] || {};
      const labels = {ok: '正常', success: '正常', ready: '就绪', disabled: '已关闭', error: '抓取异常', warning: '待检查', refreshing: '刷新中', idle: '待刷新'};
      byId(`${platform}-status`).textContent = state.enabled === false ? '已关闭' : (labels[state.status] || '待检查');
    }
    if (status.refreshing) { notify('后台正在更新频道，完成后自动更新列表。'); watchRefresh(); }
    else if (Object.values(states).some(state => state.status === 'error' || state.status === 'warning' || (state.warnings && state.warnings.length))) notify('部分平台更新异常，可能显示上次成功结果。请检查平台配置。', true);
  }
  function showChannels(data) {
    const items = Array.isArray(data) ? data : data.channels;
    const root = byId('channel-list');
    root.replaceChildren();
    if (!Array.isArray(items) || !items.length) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '暂无频道，请启用平台并刷新。'; root.append(empty); return;
    }
    for (const item of items.slice(0, 1000)) {
      const row = document.createElement('div'); row.className = 'channel-row';
      const tag = document.createElement('span'); tag.className = 'channel-tag'; tag.textContent = item.platform === 'douyin' ? '抖音' : item.platform === 'bilibili' ? '哔哩哔哩' : '频道';
      const detail = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = safeText(item.name, '未命名频道');
      const title = document.createElement('p'); title.className = 'muted'; title.textContent = safeText(item.title, '');
      detail.append(name, title); row.append(tag, detail); root.append(row);
    }
  }
  async function overview() {
    const [status, channels] = await Promise.all([api('/api/status'), api('/api/channels')]);
    showStatus(status); showChannels(channels);
    return status;
  }
  let polling = false;
  async function watchRefresh() {
    if (polling) return;
    polling = true;
    try {
      for (let n = 0; n < 90; n++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const status = await overview();
        if (!status.refreshing) return;
      }
      notify('刷新仍未结束，请稍后手动查看。', true);
    } catch (_) { notify('状态查询失败，请稍后重试。', true); }
    finally { polling = false; }
  }
  function lock(value) { busy = value; byId('save').disabled = value; byId('refresh').disabled = value; }
  byId('config-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; lock(true);
    try { const config = await api('/api/config', patch()); fill(config); notify('配置已安全保存，正在刷新频道。'); await overview(); watchRefresh(); }
    catch (error) { notify(error instanceof SyntaxError ? '服务返回格式异常。' : error.message, true); }
    finally { byId('bilibili-sessdata').value = ''; lock(false); }
  });
  byId('refresh').addEventListener('click', async () => {
    if (busy) return; lock(true); notify('正在更新频道，请稍候…');
    try { await api('/api/refresh', {}); notify('已请求更新频道。'); await overview(); }
    catch (error) { notify(error instanceof SyntaxError ? '服务返回格式异常。' : error.message, true); }
    finally { lock(false); }
  });
  byId('clear-sessdata').addEventListener('change', event => { byId('bilibili-sessdata').disabled = event.target.checked; byId('bilibili-sessdata').value = ''; });
  byId('copy-subscription').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(subscription); notify('订阅地址已复制。地址包含私有订阅令牌，请勿公开分享。'); }
    catch (_) {
      if (subscription) window.prompt('请手动复制私密订阅地址，勿公开分享：', subscription);
      else notify('订阅地址尚未就绪。', true);
    }
  });
  async function start() {
    try {
      const session = await api('/api/session');
      if (typeof session.csrf !== 'string' || !session.csrf) throw new Error('安全会话尚未就绪，请重新登录。');
      csrf = session.csrf;
      if (session.auth_enabled === false) {
        byId('logout').hidden = true;
        const warning = document.createElement('p');
        warning.className = 'notice error';
        warning.textContent = '当前后台免登录：所有能访问本服务的人都能管理配置和获取订阅。仅限可信内网/VPN，禁止直接开放公网。';
        byId('notice').before(warning);
      }
      fill(await api('/api/config'));
      lock(false); notify('配置已载入。默认关闭的平台不会发起直播请求。');
      await overview();
      try { const info = await api('/api/subscription'); if (typeof info.url === 'string') { const parsed = new URL(info.url, window.location.origin); if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) { subscription = parsed.href; byId('copy-subscription').disabled = false; } } } catch (_) { /* Subscription unavailability does not disable configuration. */ }
    } catch (error) { notify(error instanceof SyntaxError ? '服务返回格式异常。' : error.message, true); }
  }
  byId('logout').addEventListener('click', async () => {
    try { await api('/api/logout', {}); window.location.assign('/login'); }
    catch (_) { notify('退出失败，请重试。', true); }
  });
  start();
})();
