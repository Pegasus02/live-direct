"use strict";
// Live Direct 服务端接口：只用私密订阅（M3U + 302 播放地址）和可选的管理员 API。
// 订阅链接和管理员令牌都存钥匙串，不写入 Storage 或日志。
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestRefresh = exports.updateConfig = exports.fetchConfig = exports.fetchStatus = exports.HLS_PLATFORMS = exports.LABELS = exports.PLATFORMS = void 0;
exports.readSubscription = readSubscription;
exports.saveSubscription = saveSubscription;
exports.readAdminToken = readAdminToken;
exports.saveAdminToken = saveAdminToken;
exports.parseSubscription = parseSubscription;
exports.isPlatform = isPlatform;
exports.parsePlaylist = parsePlaylist;
exports.fetchChannels = fetchChannels;
exports.resolveStream = resolveStream;
exports.PLATFORMS = ["douyin", "bilibili", "douyu", "huya"];
exports.LABELS = { douyin: "抖音", bilibili: "B站", douyu: "斗鱼", huya: "虎牙" };
// 斗鱼只取 HTTP-FLV，iOS 系统播放器无法播放 FLV。
exports.HLS_PLATFORMS = ["douyin", "bilibili", "huya"];
const SUBSCRIPTION_KEY = "live-direct.subscription";
const ADMIN_TOKEN_KEY = "live-direct.admin-token";
function readSubscription() {
    return Keychain.get(SUBSCRIPTION_KEY)?.trim() ?? "";
}
function saveSubscription(url) {
    const value = url.trim();
    if (value)
        Keychain.set(SUBSCRIPTION_KEY, value, { synchronizable: false });
    else
        Keychain.remove(SUBSCRIPTION_KEY);
}
function readAdminToken() {
    return Keychain.get(ADMIN_TOKEN_KEY)?.trim() ?? "";
}
function saveAdminToken(token) {
    const value = token.trim();
    if (value)
        Keychain.set(ADMIN_TOKEN_KEY, value, { synchronizable: false });
    else
        Keychain.remove(ADMIN_TOKEN_KEY);
    adminSession = null;
}
/** 订阅地址形如 https://host/s/TOKEN/interface.m3u，服务根地址取自它。 */
function parseSubscription(url) {
    const match = url.trim().match(/^(https?:\/\/[^/?#\s]+)\/s\/([A-Za-z0-9_-]+)\/interface\.m3u$/);
    return match ? { base: match[1], token: match[2] } : null;
}
function isPlatform(value) {
    return exports.PLATFORMS.includes(value);
}
function attr(line, name) {
    return line.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";
}
function parsePlaylist(text) {
    const lines = text.split(/\r?\n/);
    const channels = [];
    for (let i = 0; i < lines.length; i++) {
        const info = lines[i];
        if (!info.startsWith("#EXTINF:"))
            continue;
        const url = (lines[i + 1] ?? "").trim();
        const route = url.match(/\/live\/([a-z]+)\/([A-Za-z0-9_-]+)$/);
        if (!route || !isPlatform(route[1]))
            continue;
        // group-title 是服务端输出的最后一个属性，逗号之后是“主播名 · 标题”。
        const display = info.match(/group-title="[^"]*",(.*)$/)?.[1]?.trim() ?? "";
        const split = display.indexOf(" · ");
        channels.push({
            key: `${route[1]}-${route[2]}`,
            platform: route[1],
            room: route[2],
            name: split >= 0 ? display.slice(0, split) : display,
            title: split >= 0 ? display.slice(split + 3) : "",
            logo: attr(info, "tvg-logo"),
            url,
        });
    }
    return channels;
}
function requestOptions(url) {
    return { timeout: 30, allowInsecureRequest: url.startsWith("http:") };
}
async function fetchChannels(subscription) {
    const parsed = parseSubscription(subscription);
    if (!parsed)
        throw new Error("订阅链接格式不对，应为 …/s/令牌/interface.m3u");
    // 冷启动时服务端正在发现频道，会返回 503 + Retry-After。
    for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(subscription.trim(), requestOptions(parsed.base));
        if (response.ok)
            return parsePlaylist(await response.text());
        if (response.status !== 503)
            throw new Error(response.status === 404 ? "订阅令牌无效（404）" : `订阅请求失败（HTTP ${response.status}）`);
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    throw new Error("频道正在刷新，请稍后下拉重试");
}
/**
 * 由脚本自己跟随服务端的 302，得到平台 CDN 的 HTTPS 地址再交给系统播放器：
 * 能拿到 404/503 的明确原因，也避免内网 http 服务地址被 ATS 拦截。
 */
async function resolveStream(channel, hls) {
    const url = hls ? channel.url.replace(/\/live\/([a-z]+\/[A-Za-z0-9_-]+)$/, "/hls/$1") : channel.url;
    const response = await fetch(url, { ...requestOptions(url), handleRedirect: async () => null });
    const location = response.headers.get("Location");
    if (response.status >= 300 && response.status < 400 && location)
        return location;
    if (response.status === 404) {
        throw new Error(hls ? "该频道没有 HLS 流（或服务端尚未升级到支持 /hls/ 的版本），请改用外部播放器。" : "频道已不在订阅中，可能已下播。");
    }
    if (response.status === 503)
        throw new Error("服务端暂时无法解析该频道（可能刚下播或平台限流），请稍后重试。");
    throw new Error(`解析失败（HTTP ${response.status}）`);
}
let adminSession = null;
async function login(base) {
    const token = readAdminToken();
    const options = requestOptions(base);
    let cookie = "";
    if (token) {
        const response = await fetch(base + "/login", {
            ...options,
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "admin_token=" + encodeURIComponent(token),
            handleRedirect: async () => null,
        });
        const session = response.cookies.find(item => item.name === "ld_session");
        if (response.status !== 303 || !session) {
            throw new Error(response.status === 403 ? "管理员令牌错误或尝试过于频繁" : `登录失败（HTTP ${response.status}）`);
        }
        cookie = "ld_session=" + session.value;
    }
    // 服务端关闭登录（ADMIN_AUTH_ENABLED=false）时不需要 Cookie。
    const response = await fetch(base + "/api/session", { ...options, headers: cookie ? { Cookie: cookie } : {} });
    if (response.status === 401)
        throw new Error("请先在设置中填写管理员令牌");
    if (!response.ok)
        throw new Error(`读取会话失败（HTTP ${response.status}）`);
    const { csrf } = await response.json();
    return { base, cookie, csrf };
}
async function admin(path, body) {
    const parsed = parseSubscription(readSubscription());
    if (!parsed)
        throw new Error("请先在设置中填写订阅链接");
    for (let attempt = 0; attempt < 2; attempt++) {
        if (!adminSession || adminSession.base !== parsed.base)
            adminSession = await login(parsed.base);
        const headers = adminSession.cookie ? { Cookie: adminSession.cookie } : {};
        const init = { ...requestOptions(parsed.base), headers };
        if (body !== undefined) {
            Object.assign(headers, { "Content-Type": "application/json", "X-CSRF-Token": adminSession.csrf });
            Object.assign(init, { method: "POST", body: JSON.stringify(body) });
        }
        const response = await fetch(parsed.base + path, init);
        // 会话 12 小时过期或服务重启后重新登录一次。
        if ((response.status === 401 || response.status === 403) && attempt === 0) {
            adminSession = null;
            continue;
        }
        if (response.status === 400)
            throw new Error("服务端拒绝：房间号或链接无效");
        if (!response.ok)
            throw new Error(`管理接口失败（HTTP ${response.status}）`);
        return await response.json();
    }
    throw new Error("管理员会话无效");
}
const fetchStatus = () => admin("/api/status");
exports.fetchStatus = fetchStatus;
const fetchConfig = () => admin("/api/config");
exports.fetchConfig = fetchConfig;
const updateConfig = (patch) => admin("/api/config", patch);
exports.updateConfig = updateConfig;
const requestRefresh = () => admin("/api/refresh", {});
exports.requestRefresh = requestRefresh;
