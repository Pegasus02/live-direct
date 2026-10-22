// 配置默认值与校验（对应 live_direct/config.py）。错误信息只含字段名，不含取值。
import type { Platform } from "./common"
import { splitUrl } from "./util"

export type PlatformConfig = {
  enabled: boolean
  rooms: string[]
  categories?: string[]
  count?: number
  min_viewers?: number
  quality: string | number
  share_links?: string[]
  areas?: string[]
  top_per_area?: number
  min_online?: number
  prefer_avc?: boolean
  sessdata?: string
}
export type Config = Record<Platform, PlatformConfig>

export const DEFAULTS: Config = {
  douyin: { enabled: false, rooms: [], share_links: [], categories: [], count: 10, min_viewers: 0, quality: "FULL_HD1" },
  bilibili: { enabled: false, rooms: [], areas: [], top_per_area: 10, min_online: 0, quality: 10000, prefer_avc: true, sessdata: "" },
  douyu: { enabled: false, rooms: [], categories: [], count: 10, min_viewers: 0, quality: 0 },
  huya: { enabled: false, rooms: [], categories: [], count: 10, min_viewers: 0, quality: 0 },
}
const DOUYIN_QUALITIES = ["FULL_HD1", "HD1", "SD2", "SD1"]
const BILIBILI_QUALITIES = [0, 80, 150, 250, 400, 10000, 20000, 30000]
const DOUYU_QUALITIES = [0, 4, 3, 2]
const HUYA_QUALITIES = [0, 20000, 14000, 4000, 2000, 500]
// 房间号格式、是否为正整数、允许的官方房间链接域名。
const ROOMS: Record<Platform, [RegExp, boolean, string[]]> = {
  douyin: [/^[A-Za-z0-9_-]{1,64}$/, false, ["live.douyin.com"]],
  bilibili: [/^[0-9]{1,20}$/, true, ["live.bilibili.com"]],
  douyu: [/^[0-9]{1,12}$/, true, ["www.douyu.com", "douyu.com"]],
  huya: [/^(?![gGmMlL]$)[A-Za-z0-9_-]{1,64}$/, false, ["www.huya.com", "huya.com"]],
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function integer(value: unknown, low: number, high: number, field: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) {
    throw new ConfigError(`${field}: integer must be between ${low} and ${high}`)
  }
}

export function normalizeRoom(value: unknown, platform: Platform): string {
  if (typeof value !== "string" || value.length > 256) throw new ConfigError(`${platform}.rooms: invalid room`)
  value = value.trim()
  const [pattern, numeric, hosts] = ROOMS[platform]
  let room = value as string
  if (!pattern.test(room)) {
    const p = splitUrl(room)
    const path = p ? p.path.replace(/^\/+|\/+$/g, "") : ""
    if (!p || !["https", "http"].includes(p.scheme) || p.userinfo || p.port || !hosts.includes(p.host) || p.query || room.includes("#")
      || room.includes("?") || (p.path !== "/" + path && p.path !== "/" + path + "/") || !pattern.test(path)) {
      throw new ConfigError(`${platform}.rooms: use a room ID or exact platform room link`)
    }
    room = path
  }
  if (numeric) {
    if (BigInt(room) <= 0n) throw new ConfigError(`${platform}.rooms: expected positive ID`)
    return BigInt(room).toString()
  }
  return room
}

/** 每条分享文案只提取一个 v.douyin.com 短链，不在这里发起请求。 */
export function shareLinks(value: unknown): string[] {
  const field = "douyin.share_links"
  if (!Array.isArray(value) || value.length > 100) throw new ConfigError(`${field}: expected a list of at most 100 items`)
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== "string" || item.length > 2048 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(item)) throw new ConfigError(`${field}: invalid share text`)
    // 统计所有链接起点：第二个链接不能被悄悄丢掉，也拒绝协议相对和 www 链接。
    const starts = [...item.matchAll(/(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/|www\./gi)]
    const links = [...item.matchAll(/https:\/\/[^\s<>"'（）()【】\[\]，。！？；、]+/g)]
    const at = links[0]?.index ?? -1
    if (starts.length !== 1 || links.length !== 1 || starts[0].index !== at
      || (at > 0 && /[A-Za-z0-9_./:@%+\\-]/.test(item[at - 1]))
      || !/^https:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/$/.test(links[0][0])) {
      throw new ConfigError(`${field}: use one exact Douyin short URL per item`)
    }
    if (!result.includes(links[0][0])) result.push(links[0][0])
  }
  return result
}

function strings(value: unknown, field: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new ConfigError(`${field}: expected a list of at most ${maximum} items`)
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== "string" || !/^[A-Za-z0-9_\-一-鿿]{1,64}$/.test(item)) throw new ConfigError(`${field}: invalid identifier`)
    if (!result.includes(item)) result.push(item)
  }
  return result
}

export function validate(input: any): Config {
  const config = clone(input)
  if (!config || typeof config !== "object" || Object.keys(config).sort().join() !== Object.keys(DEFAULTS).sort().join()) {
    throw new ConfigError("config: only registered platforms are allowed")
  }
  for (const platform of Object.keys(DEFAULTS) as Platform[]) {
    const values = config[platform]
    if (!values || typeof values !== "object" || Object.keys(values).sort().join() !== Object.keys(DEFAULTS[platform]).sort().join()) {
      throw new ConfigError(`${platform}: unknown or missing fields`)
    }
    if (typeof values.enabled !== "boolean") throw new ConfigError(`${platform}.enabled: expected boolean`)
    if (!Array.isArray(values.rooms) || values.rooms.length > 100) throw new ConfigError(`${platform}.rooms: expected at most 100 rooms`)
    values.rooms = Array.from(new Set(values.rooms.map((r: unknown) => normalizeRoom(r, platform))))
  }
  const dy = config.douyin, bili = config.bilibili
  dy.share_links = shareLinks(dy.share_links)
  for (const platform of ["douyin", "douyu", "huya"] as Platform[]) {
    config[platform].categories = strings(config[platform].categories, `${platform}.categories`, 8)
  }
  bili.areas = strings(bili.areas, "bilibili.areas", 16)
  for (const [platform, limit, minimum, maximum] of [
    ["douyin", "count", "min_viewers", 100], ["bilibili", "top_per_area", "min_online", 50],
    ["douyu", "count", "min_viewers", 100], ["huya", "count", "min_viewers", 100]] as [Platform, string, string, number][]) {
    integer((config[platform] as any)[limit], 0, maximum, `${platform}.${limit}`)
    integer((config[platform] as any)[minimum], 0, 1_000_000_000, `${platform}.${minimum}`)
  }
  if (!DOUYIN_QUALITIES.includes(dy.quality)) throw new ConfigError("douyin.quality: unsupported quality")
  if (!DOUYU_QUALITIES.includes(config.douyu.quality)) throw new ConfigError("douyu.quality: unsupported quality")
  if (!HUYA_QUALITIES.includes(config.huya.quality)) throw new ConfigError("huya.quality: unsupported quality")
  if (!BILIBILI_QUALITIES.includes(bili.quality)) throw new ConfigError("bilibili.quality: unsupported quality")
  if (typeof bili.prefer_avc !== "boolean") throw new ConfigError("bilibili.prefer_avc: expected boolean")
  const secret = bili.sessdata
  if (typeof secret !== "string" || secret.length > 4096 || /[^\x21-\x7e]|[;,]/.test(secret)) {
    throw new ConfigError("bilibili.sessdata: expected a single cookie value")
  }
  return config
}

/** 合并补丁：对象逐层合并，列表与标量整体替换；省略或空的 SESSDATA 保留原值。 */
export function merge(current: Config, patch: any): Config {
  const next = clone(current)
  if (!patch || typeof patch !== "object") throw new ConfigError("config: expected object")
  for (const [platform, values] of Object.entries(patch)) {
    if (!(platform in next) || !values || typeof values !== "object") throw new ConfigError("config: only registered platforms are allowed")
    const clear = (values as any).clear_sessdata ?? false
    if (platform !== "bilibili" && "clear_sessdata" in (values as object)) throw new ConfigError(`${platform}: unknown or missing fields`)
    if (typeof clear !== "boolean") throw new ConfigError("bilibili.clear_sessdata: expected boolean")
    if (clear && (values as any).sessdata) throw new ConfigError("bilibili: cannot set and clear sessdata together")
    for (const [key, value] of Object.entries(values as object)) {
      if (key === "clear_sessdata") continue
      if (platform === "bilibili" && key === "sessdata" && value === "") continue
      if (!(key in (next as any)[platform])) throw new ConfigError(`${platform}: unknown or missing fields`)
      ;(next as any)[platform][key] = clone(value)
    }
    if (clear) next.bilibili.sessdata = ""
  }
  return validate(next)
}

/** 读取旧配置时补上缺失的平台和字段默认值。 */
export function withDefaults(saved: any): Config {
  const result = clone(DEFAULTS)
  if (saved && typeof saved === "object") {
    for (const platform of Object.keys(DEFAULTS) as Platform[]) {
      const values = saved[platform]
      if (!values || typeof values !== "object") continue
      for (const key of Object.keys(DEFAULTS[platform])) if (key in values) (result as any)[platform][key] = values[key]
    }
  }
  try {
    return validate(result)
  } catch {
    return clone(DEFAULTS)
  }
}
