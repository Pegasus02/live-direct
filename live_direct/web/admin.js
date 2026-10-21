/* Fixed same-origin API; no HTML interpolation, token storage, or stream URLs. */
'use strict';
(() => {
  // Add a platform here and its data-platform configuration card to extend navigation.
  // The server must also allow its real admin path and configuration schema.
  const PLATFORMS = [
    { id: 'douyin', name: '抖音', path: '/admin/douyin' },
    { id: 'bilibili', name: '哔哩哔哩', path: '/admin/bilibili' }
  ];
  const byId = id => document.getElementById(id);
  const activePlatform = PLATFORMS.find(platform => platform.path === window.location.pathname);
  const activeCard = activePlatform && document.querySelector(`[data-platform="${activePlatform.id}"]`);
  let csrf = '';
  let subscription = '';
  let busy = true;
  let polling = false;
  const notify = (message, error = false) => {
    byId('notice').textContent = message;
    byId('notice').classList.toggle('error', error);
  };
  function configurePage() {
    const nav = byId('platform-nav');
    for (const page of [{ id: 'overview', name: '总览', path: '/admin' }, ...PLATFORMS]) {
      const link = document.createElement('a');
      link.href = page.path;
      link.textContent = page.name;
      if (page.id === (activePlatform ? activePlatform.id : 'overview')) link.setAttribute('aria-current', 'page');
      nav.append(link);
    }
    const name = activePlatform ? activePlatform.name : '总览';
    document.title = `${name} · Live Direct`;
    byId('page-title').textContent = activePlatform ? `${name}直播管理` : '把喜欢的直播，放在一起。';
    byId('page-description').textContent = activePlatform
      ? `仅管理${name}配置与频道；保存不会修改其他平台设置。`
      : '查看运行状态和全部频道，复制私有订阅。选择平台管理各自的直播配置。';
    byId('overview').hidden = Boolean(activePlatform);
    byId('config-form').hidden = !activeCard;
    byId('channels-heading').textContent = activePlatform ? `${name}频道` : '全部频道';
    for (const card of document.querySelectorAll('[data-platform]')) {
      const active = card === activeCard;
      card.hidden = !active;
      // Hidden required fields must not participate in native form validation.
      for (const input of card.querySelectorAll('input, select, textarea, button')) input.disabled = !active;
    }
    const statusRoot = byId('platform-statuses');
    for (const platform of PLATFORMS) {
      const cell = document.createElement('div');
      const label = document.createElement('span'); label.className = 'muted'; label.textContent = platform.name;
      const state = document.createElement('strong'); state.id = `${platform.id}-status`; state.textContent = '等待连接';
      cell.append(label, state); statusRoot.append(cell);
    }
  }
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
    for (const platform of PLATFORMS) {
      const values = config[platform.id] || {};
      for (const [key, value] of Object.entries(values)) {
        if (key === 'sessdata' || key === 'sessdata_set') continue;
        const input = byId(`${platform.id}-${key.replaceAll('_', '-')}`);
        if (!input) continue;
        if (input.type === 'checkbox') input.checked = value === true;
        else input.value = Array.isArray(value) ? value.join(key === 'rooms' ? '\n' : ', ') : String(value);
      }
    }
    byId('bilibili-sessdata').value = '';
    byId('clear-sessdata').checked = false;
    byId('bilibili-sessdata').disabled = activePlatform?.id !== 'bilibili';
    byId('secret-state').textContent = config.bilibili?.sessdata_set ? '已配置 · 有效性未验证' : '未配置 · 匿名模式';
  }
  function patch() {
    if (!activeCard) throw new Error('请先选择需要管理的平台。');
    const values = {};
    for (const input of activeCard.querySelectorAll('[data-config-key]')) {
      const key = input.dataset.configKey;
      if (input.dataset.valueType === 'list') values[key] = input.value.split(/[\s,，]+/u).filter(Boolean);
      else if (input.type === 'checkbox') values[key] = input.checked;
      else if (input.type === 'number' || input.dataset.valueType === 'number') values[key] = Number(input.value);
      else values[key] = input.value;
    }
    if (activePlatform.id === 'bilibili') {
      if (byId('clear-sessdata').checked) values.clear_sessdata = true;
      else if (byId('bilibili-sessdata').value) values.sessdata = byId('bilibili-sessdata').value;
    }
    // Partial updates preserve other platforms and fields not represented by this card.
    return { [activePlatform.id]: values };
  }
  function safeText(value, fallback = '') {
    return typeof value === 'string' && !/https?:\/\/|sessdata|[?&](?:token|sign|auth)=/i.test(value) ? value.slice(0, 240) : fallback;
  }
  function showStatus(status) {
    byId('channel-count').textContent = Number.isSafeInteger(status.channel_count) ? String(status.channel_count) : '—';
    const states = status.platforms || status.providers || {};
    for (const platform of PLATFORMS) {
      const state = states[platform.id] || {};
      const labels = {ok: '正常', success: '正常', ready: '就绪', disabled: '已关闭', error: '抓取异常', warning: '待检查', refreshing: '刷新中', idle: '待刷新'};
      byId(`${platform.id}-status`).textContent = state.enabled === false ? '已关闭' : (labels[state.status] || '待检查');
    }
    const relevantStates = activePlatform ? [states[activePlatform.id] || {}] : Object.values(states);
    if (status.refreshing) { notify('后台正在更新频道，完成后自动更新列表。'); watchRefresh(); }
    else if (relevantStates.some(state => state.status === 'error' || state.status === 'warning' || (state.warnings && state.warnings.length))) notify('平台更新异常，可能显示上次成功结果。请检查平台配置。', true);
    else if (polling) notify('频道列表已更新。');
  }
  function showChannels(data) {
    const items = Array.isArray(data) ? data : data.channels;
    const visible = Array.isArray(items) ? items.filter(item => !activePlatform || item.platform === activePlatform.id) : [];
    const root = byId('channel-list');
    root.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = activePlatform ? `暂无${activePlatform.name}频道，请检查配置并刷新。` : '暂无频道，请选择平台启用并刷新。'; root.append(empty); return;
    }
    for (const item of visible.slice(0, 1000)) {
      const row = document.createElement('div'); row.className = 'channel-row';
      const tag = document.createElement('span'); tag.className = 'channel-tag'; tag.textContent = PLATFORMS.find(platform => platform.id === item.platform)?.name || '频道';
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
  function lock(value) { busy = value; byId('save').disabled = value || !activeCard; byId('refresh').disabled = value; }
  byId('config-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !activeCard) return; lock(true);
    try { const config = await api('/api/config', patch()); fill(config); notify('当前平台配置已安全保存，正在刷新频道。'); await overview(); }
    catch (error) { notify(error instanceof SyntaxError ? '服务返回格式异常。' : error.message, true); }
    finally { byId('bilibili-sessdata').value = ''; lock(false); }
  });
  byId('refresh').addEventListener('click', async () => {
    if (busy) return; lock(true); notify('正在更新频道，请稍候…');
    try { await api('/api/refresh', {}); notify('已请求更新频道。'); await overview(); }
    catch (error) { notify(error instanceof SyntaxError ? '服务返回格式异常。' : error.message, true); }
    finally { lock(false); }
  });
  byId('clear-sessdata').addEventListener('change', event => { byId('bilibili-sessdata').disabled = activePlatform?.id !== 'bilibili' || event.target.checked; byId('bilibili-sessdata').value = ''; });
  let qrPollTimer = null;
  function stopQrPoll() {
    if (qrPollTimer) { clearInterval(qrPollTimer); qrPollTimer = null; }
  }
  const qrBtn = byId('bilibili-qr-btn');
  const qrBox = byId('bilibili-qr-box');
  const qrCodeDiv = byId('bilibili-qr-code');
  const qrStatus = byId('bilibili-qr-status');
  const qrCancel = byId('bilibili-qr-cancel');
  if (qrBtn && qrBox) {
    qrBtn.addEventListener('click', async () => {
      stopQrPoll();
      qrBox.hidden = false;
      qrBtn.disabled = true;
      qrStatus.textContent = '正在获取登录二维码…';
      qrCodeDiv.replaceChildren();
      try {
        const data = await api('/api/bilibili/qrcode/generate', {});
        if (!data.url || !data.qrcode_key) throw new Error('生成二维码失败');
        if (typeof qrcode !== 'undefined') {
          const qr = qrcode(0, 'M');
          qr.addData(data.url);
          qr.make();
          const svgWrap = document.createElement('div');
          svgWrap.innerHTML = qr.createSvgTag({ scalable: true });
          qrCodeDiv.replaceChildren(svgWrap.firstElementChild || svgWrap);
        } else {
          qrCodeDiv.textContent = '二维码组件未载入';
        }
        qrStatus.textContent = '请打开哔哩哔哩手机客户端扫码';
        let count = 0;
        qrPollTimer = setInterval(async () => {
          count++;
          if (count > 90) {
            stopQrPoll();
            qrStatus.textContent = '二维码已失效，请重新生成';
            qrBtn.disabled = false;
            return;
          }
          try {
            const poll = await api('/api/bilibili/qrcode/poll', { qrcode_key: data.qrcode_key });
            if (poll.status === 'success') {
              stopQrPoll();
              qrBox.hidden = true;
              qrBtn.disabled = false;
              notify('Bilibili 扫码登录成功！已自动保存凭据并刷新高画质频道。');
              byId('secret-state').textContent = '已配置 · 扫码登录';
              await overview();
            } else if (poll.status === 'scanned') {
              qrStatus.textContent = '手机已扫码，请在客户端确认登录';
            } else if (poll.status === 'expired') {
              stopQrPoll();
              qrStatus.textContent = '二维码已失效，请重新生成';
              qrBtn.disabled = false;
            }
          } catch (_) {}
        }, 2000);
      } catch (err) {
        qrStatus.textContent = err.message || '获取失败';
        qrBtn.disabled = false;
      }
    });
  }
  if (qrCancel && qrBox) {
    qrCancel.addEventListener('click', () => {
      stopQrPoll();
      qrBox.hidden = true;
      if (qrBtn) qrBtn.disabled = false;
    });
  }
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
      if (!activePlatform) {
        try { const info = await api('/api/subscription'); if (typeof info.url === 'string') { const parsed = new URL(info.url, window.location.origin); if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) { subscription = parsed.href; byId('copy-subscription').disabled = false; } } } catch (_) { /* Subscription unavailability does not disable configuration. */ }
      }
    } catch (error) { notify(error instanceof SyntaxError ? '服务返回格式异常。' : error.message, true); }
  }
  byId('logout').addEventListener('click', async () => {
    try { await api('/api/logout', {}); window.location.assign('/login'); }
    catch (_) { notify('退出失败，请重试。', true); }
  });
  configurePage();
  start();
})();
