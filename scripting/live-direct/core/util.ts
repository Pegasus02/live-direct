// 与 Scripting 无关的基础工具：URL 拆分、MD5、base64、JSON 字面量提取等。
// JavaScriptCore 不保证提供 URL / atob，这里全部自带实现，方便在 Node 中测试。

export class ProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderError"
  }
}

/** 已确认未开播：发现时静默跳过，不算失败。 */
export class RoomOfflineError extends ProviderError {
  constructor(message: string) {
    super(message)
    this.name = "RoomOfflineError"
  }
}

export class TimeoutError extends Error {
  constructor() {
    super("timeout")
    this.name = "TimeoutError"
  }
}

export type SplitUrl = { scheme: string; host: string; port: string; path: string; query: string; fragment: string; userinfo: boolean }

/** 只接受 scheme://host[:port]/path?query#fragment 这种绝对地址。 */
export function splitUrl(url: string): SplitUrl | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(url)
  if (!m) return null
  let authority = m[2]
  const userinfo = authority.includes("@")
  if (userinfo) authority = authority.slice(authority.lastIndexOf("@") + 1)
  const hp = /^([^:]*)(?::(\d*))?$/.exec(authority)
  if (!hp) return null
  return {
    scheme: m[1].toLowerCase(), host: hp[1].toLowerCase(), port: hp[2] ?? "",
    path: m[3], query: m[4] ?? "", fragment: m[5] ?? "", userinfo,
  }
}

export function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 33 || c === 127) return true
  }
  return false
}

/** 固定 HTTPS 接口地址校验（对应 net.validate_url）。 */
export function validateUrl(url: string, hosts: readonly string[]): SplitUrl {
  const p = splitUrl(url)
  if (!p || p.scheme !== "https" || !hosts.includes(p.host) || p.userinfo
    || (p.port !== "" && p.port !== "443") || url.includes("#") || hasControl(url)) {
    throw new ProviderError("Untrusted upstream URL")
  }
  return p
}

export const MEDIA_SUFFIXES: Record<string, string[]> = {
  douyin: ["douyinliving.com", "douyincdn.com"],
  bilibili: ["bilivideo.com", "bilivideo.cn", "biliapi.net"],
  douyu: ["douyucdn.cn", "douyucdn2.cn"],
  huya: ["huya.com"],
}

/** 只放行官方 CDN 域名，并统一改成 HTTPS（对应 net.media_url）。 */
export function mediaUrl(url: string, platform: string, format: "flv" | "hls"): string {
  const p = typeof url === "string" ? splitUrl(url) : null
  const suffixes = MEDIA_SUFFIXES[platform]
  if (!p || !suffixes || (p.scheme !== "http" && p.scheme !== "https") || !["", "80", "443"].includes(p.port)
    || p.userinfo || url.includes("#")
    || !suffixes.some(s => p.host === s || p.host.endsWith("." + s))
    || !p.path.endsWith(format === "flv" ? ".flv" : ".m3u8") || hasControl(url)) {
    throw new ProviderError("Untrusted media URL")
  }
  return "https://" + p.host + p.path + (p.query ? "?" + p.query : "")
}

/** 302 前的最终检查（对应 app.safe_media）。 */
export function safeMedia(url: string, platform: string): boolean {
  const suffixes = (MEDIA_SUFFIXES[platform] ?? []).map(s => "." + s)
  if (!suffixes.length || typeof url !== "string" || url.length > 16384 || hasControl(url) || url.includes("\\")) return false
  const p = splitUrl(url)
  return !!p && p.scheme === "https" && (p.port === "" || p.port === "443") && !p.userinfo && !url.includes("#")
    && !!p.host && suffixes.some(s => p.host.endsWith(s)) && !!p.path
}

const LOGO_SUFFIXES = [".hdslb.com", ".douyinpic.com", ".douyincdn.com", ".byteimg.com", ".douyucdn.cn", ".msstatic.com"]

/** 只输出官方图床的头像地址并升级为 HTTPS（对应 app.safe_logo）。 */
export function safeLogo(url: string): string {
  if (typeof url !== "string" || !url || url.length > 2048 || hasControl(url) || /["\\'<>]/.test(url)) return ""
  if (url.startsWith("//")) url = "https:" + url
  else if (url.startsWith("http://")) url = "https://" + url.slice(7)
  const p = splitUrl(url)
  const ok = !!p && p.scheme === "https" && (p.port === "" || p.port === "443") && !p.userinfo && !!p.host && LOGO_SUFFIXES.some(s => p.host.endsWith(s))
  return ok ? url : ""
}

export function cleanText(value: unknown): string {
  let out = ""
  for (const ch of String(value ?? "")) {
    const c = ch.charCodeAt(0)
    if (c >= 32 && c !== 127) out += ch
  }
  return out.replace(/"/g, "'").slice(0, 300)
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }

/** html.unescape + strip，足够处理平台返回的昵称和标题。 */
export function clean(value: unknown): string {
  return String(value ?? "").replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all
    }
    return ENTITIES[body.toLowerCase()] ?? all
  }).trim()
}

/** 人气可能是整数，也可能是 “12.3万” 这样的展示文本。 */
export function parseHeat(raw: unknown): number {
  if (typeof raw === "boolean") return 0
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0
  const m = /([0-9]+(?:\.[0-9]+)?)\s*(亿|万)?/.exec(String(raw ?? "").replace(/,/g, ""))
  if (!m) return 0
  return Math.trunc(parseFloat(m[1]) * (m[2] === "亿" ? 100_000_000 : m[2] === "万" ? 10_000 : 1))
}

/** 从 start 处的 { 或 [ 开始，按引号感知的括号匹配取出 JSON 字面量再解析，不执行脚本。 */
export function assignedJson(source: string, start: number, limit = 2_000_000): any {
  if (start >= source.length || !"[{".includes(source[start])) throw new ProviderError("Page data unavailable")
  let depth = 0, quote = "", escaped = false
  const end = Math.min(source.length, start + limit)
  for (let i = start; i < end; i++) {
    const ch = source[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === quote) quote = ""
      continue
    }
    if (ch === "\"" || ch === "'") quote = ch
    else if (ch === "[" || ch === "{") depth++
    else if (ch === "]" || ch === "}") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1))
        } catch {
          throw new ProviderError("Page data unavailable")
        }
      }
    }
  }
  throw new ProviderError("Page data unavailable")
}

/** 接受分类 ID 或中文名；未知分类直接报错。 */
export function categoryIds(values: unknown[], table: Record<string, string>, label: string): string[] {
  const result: string[] = []
  for (const raw of values.slice(0, 8)) {
    const value = String(raw)
    const cid = value in table ? value : Object.keys(table).find(k => table[k] === value)
    if (cid === undefined) throw new ProviderError("Invalid " + label + " category")
    if (!result.includes(cid)) result.push(cid)
  }
  return result
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

export function urlencode(params: Record<string, string | number> | [string, string][]): string {
  const pairs = Array.isArray(params) ? params : Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string])
  // 与 Python urlencode 一致：空格编码为 +。
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, "+")
  return pairs.map(([k, v]) => enc(k) + "=" + enc(v)).join("&")
}

/** 对应 urllib.parse.parse_qsl(keep_blank_values=True)。 */
export function parseQsl(query: string): [string, string][] {
  const dec = (s: string) => {
    try { return decodeURIComponent(s.replace(/\+/g, " ")) } catch { return s }
  }
  return query.split(/[&;]/).filter(Boolean).map(part => {
    const i = part.indexOf("=")
    return i < 0 ? [dec(part), ""] : [dec(part.slice(0, i)), dec(part.slice(i + 1))]
  })
}

// ---- 编码 ----

export function utf8Bytes(text: string): number[] {
  const out: number[] = []
  for (const ch of text) {
    let c = ch.codePointAt(0)!
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | c >> 6, 0x80 | c & 63)
    else if (c < 0x10000) out.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63)
    else out.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63)
  }
  return out
}

export function utf8Decode(bytes: number[]): string {
  let out = ""
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++]
    let c: number
    if (b < 0x80) c = b
    else if (b >> 5 === 6) c = (b & 31) << 6 | bytes[i++] & 63
    else if (b >> 4 === 14) c = (b & 15) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63
    else if (b >> 3 === 30) c = (b & 7) << 18 | (bytes[i++] & 63) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63
    else throw new ProviderError("Invalid UTF-8")
    out += String.fromCodePoint(c)
  }
  return out
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** 严格 base64 解码（对应 b64decode(validate=True)），失败抛 ProviderError。 */
export function base64Decode(text: string): string {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new ProviderError("Invalid base64")
  const bytes: number[] = []
  for (let i = 0; i < text.length; i += 4) {
    const n = [0, 1, 2, 3].map(j => text[i + j] === "=" ? 0 : B64.indexOf(text[i + j]))
    const v = n[0] << 18 | n[1] << 12 | n[2] << 6 | n[3]
    bytes.push(v >> 16 & 255)
    if (text[i + 2] !== "=") bytes.push(v >> 8 & 255)
    if (text[i + 3] !== "=") bytes.push(v & 255)
  }
  return utf8Decode(bytes)
}

export function md5(text: string): string {
  const bytes = utf8Bytes(text)
  const len = bytes.length
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const bits = len * 8
  for (let i = 0; i < 8; i++) bytes.push(i < 4 ? bits >>> (8 * i) & 255 : Math.floor(bits / 2 ** (8 * i)) & 255)
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  for (let off = 0; off < bytes.length; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => bytes[off + 4 * i] | bytes[off + 4 * i + 1] << 8 | bytes[off + 4 * i + 2] << 16 | bytes[off + 4 * i + 3] << 24)
    let a = a0, b = b0, c = c0, d = d0
    for (let i = 0; i < 64; i++) {
      let f: number, g: number
      if (i < 16) { f = b & c | ~b & d; g = i }
      else if (i < 32) { f = d & b | ~d & c; g = (5 * i + 1) % 16 }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
      else { f = c ^ (b | ~d); g = 7 * i % 16 }
      const s = S[(i >> 4) * 4 + i % 4]
      const t = d
      d = c
      c = b
      const x = (a + f + K[i] + M[g]) | 0
      b = (b + (x << s | x >>> (32 - s))) | 0
      a = t
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0
  }
  return [a0, b0, c0, d0].map(w => [0, 8, 16, 24].map(s => (w >>> s & 255).toString(16).padStart(2, "0")).join("")).join("")
}

/** 有界并发 + 共享截止时间（对应 _pool.fan_out）。结果按输入顺序返回。 */
export async function fanOut<T, R>(fn: (item: T) => Promise<R>, items: T[], deadline: number, workers = 4):
  Promise<{ item: T; result?: R; error?: unknown }[]> {
  const results: { item: T; result?: R; error?: unknown }[] = items.map(item => ({ item, error: new TimeoutError() }))
  if (!items.length || deadline - Date.now() <= 0) return results
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      if (Date.now() >= deadline) return
      try {
        const result = await fn(items[index])
        if (Date.now() <= deadline) results[index] = { item: items[index], result }
      } catch (error) {
        results[index] = { item: items[index], error }
      }
    }
  }
  const timer = new Promise<void>(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now())))
  await Promise.race([Promise.all(Array.from({ length: Math.min(workers, items.length) }, worker)), timer])
  return results.map(r => ({ ...r }))
}
