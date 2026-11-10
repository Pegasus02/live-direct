// 有界、无状态的上游请求（对应 live_direct/net.py）。只允许固定的官方接口域名，
// 除抖音分享短链外不跟随重定向，登录 Cookie 只发给 B站 API。
import { hasControl, mediaUrl, ProviderError, splitUrl, type SplitUrl, urlencode, validateUrl } from "./util"

export type TransportRequest = {
  method: "GET" | "POST" | "HEAD"
  url: string
  headers: Record<string, string>
  body?: string
  timeout: number
}

export type TransportResponse = {
  status: number
  /** 响应头，键为小写。 */
  headers: Record<string, string>
  cookies: { name: string; value: string }[]
  text: string
}

/** 必须不跟随重定向；由 Scripting fetch 或测试桩实现。 */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>

export const API_HOSTS = ["live.douyin.com", "api.live.bilibili.com", "passport.bilibili.com",
  "www.douyu.com", "playweb.douyucdn.cn", "www.huya.com"]
const POST_HOSTS = ["playweb.douyucdn.cn"]
const TIMEOUT = 10
const PROBE_TIMEOUT = 3
const MAX_BYTES = 5_000_000
const ALLOWED_HEADERS = ["user-agent", "accept", "accept-language", "referer", "cookie", "origin"]

const DOUYIN_SHARE_HOSTS = ["v.douyin.com", "webcast.amemv.com", "www.iesdouyin.com", "www.douyin.com", "live.douyin.com"]
export const DOUYIN_MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 10_3_1 like Mac OS X) "
  + "AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.0 Mobile/14E304 Safari/602.1"
// 只是公开分享来源标记，不是登录 Cookie。
const DOUYIN_SHARE_COOKIE = "_tea_utm_cache_1128={%22utm_source%22:%22copy%22%2C"
  + "%22utm_medium%22:%22android%22%2C%22utm_campaign%22:%22client_share%22}"

export type Client = {
  fetchText(url: string, headers?: Record<string, string>): Promise<string>
  fetchJson(url: string, headers?: Record<string, string>, form?: Record<string, string>): Promise<any>
  fetchJsonWithCookies(url: string, headers?: Record<string, string>): Promise<{ cookies: { name: string; value: string }[]; json: any }>
  resolveDouyinShare(url: string): Promise<string>
  fetchDouyinReflow(roomId: string): Promise<any>
  probeMedia(url: string, platform: string, format: "flv" | "hls"): Promise<boolean>
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    throw new ProviderError("Invalid upstream JSON")
  }
}

function checkBody(response: TransportResponse) {
  if (response.status !== 200) throw new ProviderError("Upstream HTTP request failed")
  if (response.text.length > MAX_BYTES) throw new ProviderError("Upstream response too large")
}

function douyinTarget(url: string): SplitUrl {
  if (typeof url !== "string" || url.includes("\\") || url.includes("#") || /%[01][0-9a-f]|%7f/i.test(url)) {
    throw new ProviderError("Untrusted Douyin share target")
  }
  return validateUrl(url, DOUYIN_SHARE_HOSTS)
}

function douyinRoomId(p: SplitUrl): string | null {
  if (p.host === "webcast.amemv.com" || p.host === "www.iesdouyin.com") {
    const m = /^\/(?:douyin\/webcast\/)?reflow\/([0-9]{19})\/?$/.exec(p.path)
    if (m) return m[1]
  }
  const ids = p.query.split("&").filter(part => part.split("=")[0] === "room_id").map(part => part.slice(part.indexOf("=") + 1))
  return ids.length === 1 && /^[0-9]{19}$/.test(ids[0]) ? ids[0] : null
}

/** 把 Location 解析为绝对地址（只需处理绝对、协议相对和根路径三种形式）。 */
function joinUrl(base: string, location: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(location)) return location
  const p = splitUrl(base)!
  if (location.startsWith("//")) return p.scheme + ":" + location
  if (location.startsWith("/")) return p.scheme + "://" + p.host + (p.port ? ":" + p.port : "") + location
  const dir = p.path.slice(0, p.path.lastIndexOf("/") + 1) || "/"
  return p.scheme + "://" + p.host + (p.port ? ":" + p.port : "") + dir + location
}

export function createClient(transport: Transport): Client {
  async function request(url: string, headers?: Record<string, string>, form?: Record<string, string>): Promise<TransportResponse> {
    const p = validateUrl(url, API_HOSTS)
    if (form && !POST_HOSTS.includes(p.host)) throw new ProviderError("Form destination rejected")
    const clean: Record<string, string> = { "User-Agent": "Mozilla/5.0 LiveDirect/1.0", "Accept-Encoding": "identity" }
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (!ALLOWED_HEADERS.includes(key.toLowerCase())) throw new ProviderError("Unsupported request header")
      if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) throw new ProviderError("Invalid request header")
      if (key.toLowerCase() === "cookie" && p.host !== "api.live.bilibili.com") throw new ProviderError("Session destination rejected")
      clean[key] = value
    }
    let body: string | undefined
    if (form) {
      body = urlencode(form)
      clean["Content-Type"] = "application/x-www-form-urlencoded"
    }
    try {
      return await transport({ method: form ? "POST" : "GET", url, headers: clean, body, timeout: TIMEOUT })
    } catch (e) {
      if (e instanceof ProviderError) throw e
      throw new ProviderError("Upstream request failed")
    }
  }

  return {
    async fetchText(url, headers) {
      const response = await request(url, headers)
      checkBody(response)
      return response.text
    },
    async fetchJson(url, headers, form) {
      const response = await request(url, headers, form)
      checkBody(response)
      return parseJson(response.text)
    },
    async fetchJsonWithCookies(url, headers) {
      const response = await request(url, headers)
      checkBody(response)
      return { cookies: response.cookies, json: parseJson(response.text) }
    },

    /** 短链最多跳 4 次，每个 Location 都校验域名，拿到 19 位内部房间 ID 即停。 */
    async resolveDouyinShare(url) {
      let p = douyinTarget(url)
      if (p.host !== "v.douyin.com" || url.includes("?") || url.includes("#") || !/^\/[A-Za-z0-9_-]+\/?$/.test(p.path)) {
        throw new ProviderError("Invalid Douyin share URL")
      }
      const deadline = Date.now() + TIMEOUT * 1000
      const seen = new Set<string>()
      for (let i = 0; i < 4; i++) {
        p = douyinTarget(url)
        const key = p.host + p.path + "?" + p.query
        if (seen.has(key)) throw new ProviderError("Douyin share redirect loop")
        seen.add(key)
        const remaining = (deadline - Date.now()) / 1000
        if (remaining <= 0) throw new ProviderError("Upstream request timed out")
        let response: TransportResponse
        try {
          response = await transport({ method: "HEAD", url, headers: { "User-Agent": DOUYIN_MOBILE_UA, "Accept-Encoding": "identity" }, timeout: remaining })
        } catch {
          throw new ProviderError("Douyin share request failed")
        }
        if (![301, 302, 303, 307, 308].includes(response.status)) throw new ProviderError("Douyin share room not found")
        const location = response.headers["location"]
        if (typeof location !== "string" || !location || hasControl(location) || location.includes("\\") || location.includes("#")) {
          throw new ProviderError("Untrusted Douyin share target")
        }
        const target = joinUrl(url, location)
        const roomId = douyinRoomId(douyinTarget(target))
        if (roomId) return roomId
        url = target
      }
      throw new ProviderError("Douyin share redirect limit exceeded")
    },

    async fetchDouyinReflow(roomId) {
      if (!/^[0-9]{19}$/.test(roomId)) throw new ProviderError("Invalid Douyin internal room ID")
      const url = "https://webcast.amemv.com/webcast/room/reflow/info/?type_id=0&live_id=1&room_id=" + roomId + "&app_id=1128"
      let response: TransportResponse
      try {
        response = await transport({
          method: "GET", url, timeout: TIMEOUT,
          headers: { "User-Agent": DOUYIN_MOBILE_UA, "Accept-Encoding": "identity", Cookie: DOUYIN_SHARE_COOKIE },
        })
      } catch {
        throw new ProviderError("Douyin reflow request failed")
      }
      checkBody(response)
      return parseJson(response.text)
    },

    /** 像跟随 302 的播放器一样请求可信 CDN 地址：不带 Referer/Cookie、不跟随跳转。
     *  有的 CDN 节点拒绝无请求头的访问或 TLS 失败，平台据此跳过。 */
    async probeMedia(url, platform, format) {
      let target: string
      try {
        target = mediaUrl(url, platform, format)
      } catch {
        return false
      }
      try {
        const response = await transport({
          method: "HEAD", url: target, timeout: PROBE_TIMEOUT,
          headers: { "User-Agent": "Mozilla/5.0 LiveDirect/1.0", "Accept-Encoding": "identity" },
        })
        return response.status === 200 || response.status === 206
      } catch {
        return false
      }
    },
  }
}
