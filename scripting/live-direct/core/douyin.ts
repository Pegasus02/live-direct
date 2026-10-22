// 抖音：公开 Flight 页面 + 分享短链回流接口，不执行网页脚本（对应 providers/douyin.py）。
// 解析思路改写自 akiralereal/iptv extractors/douyin-live（GPL-3.0）。
import { ALL_FORMATS, type Channel, type Format, type Provider, roundRobin, type Row, type Stream } from "./common"
import type { Client } from "./net"
import { fanOut, mediaUrl, ProviderError, RoomOfflineError, TimeoutError, unique, validateUrl } from "./util"

const ORIGIN = "https://live.douyin.com"
export const CATEGORIES: Record<string, string> = {
  "101": "聊天", "102": "音乐", "103": "游戏", "104": "二次元", "105": "舞蹈", "106": "文化", "107": "生活", "108": "运动",
}
export const QUALITIES = ["FULL_HD1", "HD1", "SD2", "SD1"]
const HEADERS = { Referer: ORIGIN + "/", Accept: "text/html", "Accept-Language": "zh-CN" }

export function normalizeRoom(value: unknown): string {
  let text = String(value).trim()
  if (text.includes("://")) {
    const p = validateUrl(text, ["live.douyin.com"])
    if (p.query) throw new ProviderError("Invalid Douyin room identifier")
    text = p.path.replace(/^\/+|\/+$/g, "")
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(text)) throw new ProviderError("Invalid Douyin room identifier")
  return text
}

/** 只解析已知格式的 self.__pace_f.push([...]) 参数（JSON），从不执行脚本。 */
export function flightData(page: string): any[] {
  const values: any[] = []
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(page))) {
    let script = m[1].trim()
    if (script.endsWith(";")) script = script.slice(0, -1)
    const prefix = "self.__pace_f.push("
    if (!script.startsWith(prefix) || !script.endsWith(")")) continue
    try {
      const args = JSON.parse(script.slice(prefix.length, -1))
      const chunk = args[1]
      if (typeof chunk !== "string" || !/^[0-9a-f]+:/i.test(chunk)) continue
      values.push(JSON.parse(chunk.slice(chunk.indexOf(":") + 1)))
    } catch {
      continue
    }
  }
  return values
}

function row(item: any, category = ""): Row | null {
  const room = item?.room || {}
  const rid = String(item?.web_rid || "")
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(rid) || !room.stream_url) return null
  const owner = room.owner || {}
  const avatars = (owner.avatar_thumb || {}).url_list || [""]
  // 与 Python int() 一致：整数或纯数字文本，其余（如 “1.2万”）记 0。
  const raw = (room.room_view_stats || {}).display_value ?? 0
  const viewers = typeof raw === "number" ? Math.trunc(raw) : /^\s*[+-]?\d+\s*$/.test(String(raw)) ? parseInt(String(raw), 10) : 0
  return {
    id: rid, key: String(room.id_str || rid), name: String(owner.nickname || rid), title: String(room.title || ""),
    logo: String(item.avatar || avatars[0] || ""), viewers, streams: room.stream_url, category,
  }
}

export function parseCategoryPage(page: string, category = ""): Row[] {
  for (const data of flightData(page)) {
    const items = data?.[3]?.roomsData?.data
    if (Array.isArray(items)) {
      return items.filter(i => i && typeof i === "object" && !Array.isArray(i)).map(i => row(i, category)).filter((r): r is Row => !!r)
    }
  }
  throw new ProviderError("Douyin category page format unavailable")
}

export function parseRoomPage(page: string, requestedId: string): Row {
  for (const data of flightData(page)) {
    const info = data?.[3]?.state?.roomStore?.roomInfo
    if (!info || typeof info !== "object" || !("room" in info)) continue
    const room = info.room
    if (!room) throw new RoomOfflineError("Douyin room is offline")
    if (room.status !== 2 && room.status !== "2") throw new RoomOfflineError("Douyin room is offline")
    const r = row({ room, web_rid: info.web_rid || requestedId })
    if (r) return r
  }
  // 拿不到页面数据可能是反爬页面，不能当作未开播。
  throw new ProviderError("Douyin room page format unavailable")
}

export function selectStream(streams: any, quality = "HD1", formats: Format[] = ALL_FORMATS): Stream {
  const tiers = unique([quality, ...QUALITIES])
  const fields: Record<Format, string> = { flv: "flv_pull_url", hls: "hls_pull_url_map" }
  for (const fmt of formats) {
    const mapping = streams?.[fields[fmt]] || {}
    if (typeof mapping !== "object" || Array.isArray(mapping)) continue
    for (const tier of tiers) {
      if (!mapping[tier]) continue
      try {
        return { url: mediaUrl(mapping[tier], "douyin", fmt), format: fmt, quality: tier, headers: { Referer: ORIGIN + "/" } }
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e
      }
    }
  }
  throw new ProviderError("Douyin room has no trusted playable stream")
}

export class Douyin implements Provider {
  hls = true
  warnings: string[] = []
  // web_rid -> [内部 ID, 分享链接来源, 过期时间]
  private identities = new Map<string, [string, string, number]>()

  constructor(private client: Client) {}

  private remember(rid: string, internal: string, source = "") {
    if (!/^[0-9]{19}$/.test(String(internal))) return
    if (this.identities.size >= 500) this.identities.clear()
    this.identities.set(rid, [String(internal), source, Date.now() + 60_000])
  }

  private async reflow(internal: string, expected?: string, source = "", renew = true): Promise<Row> {
    const body = await this.client.fetchDouyinReflow(internal)
    if (!body || typeof body !== "object" || body.status_code !== 0) throw new ProviderError("Douyin reflow request rejected")
    const room = body.data?.room
    if (!room || typeof room !== "object") throw new ProviderError("Douyin reflow room unavailable")
    const owner = room.owner || {}
    const rid = typeof owner === "object" ? String(owner.web_rid || "") : ""
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(rid) || (expected && rid !== expected)) throw new ProviderError("Douyin reflow room identity mismatch")
    if (String(room.id_str || "") !== String(internal)) throw new ProviderError("Douyin reflow internal identity mismatch")
    if (renew) this.remember(rid, internal, source)
    if (room.status === 4 || room.status === "4") throw new RoomOfflineError("Douyin room is offline")
    if (room.status !== 2 && room.status !== "2") throw new ProviderError("Douyin live status unavailable")
    const r = row({ room, web_rid: rid })
    if (!r || typeof r.streams !== "object") throw new ProviderError("Douyin reflow stream unavailable")
    return r
  }

  private async sharedRoom(link: string, expected?: string): Promise<Row> {
    return this.reflow(await this.client.resolveDouyinShare(link), expected, link)
  }

  private async lookup(rid: string, config: any): Promise<Row> {
    let identity = this.identities.get(rid)
    if (identity) {
      const [internal, source, expires] = identity
      if (source && !(config.share_links || []).includes(source)) identity = undefined
      else if (Date.now() < expires) return this.reflow(internal, rid, source, false)
      else if (source) return this.sharedRoom(source, rid)
      else this.identities.delete(rid)
    }
    return this.room(rid)
  }

  private async room(rid: string): Promise<Row> {
    const page = await this.client.fetchText(ORIGIN + "/" + rid, HEADERS)
    if (page.includes("验证码中间页")) throw new ProviderError("Douyin room request requires verification")
    return parseRoomPage(page, rid)
  }

  async discover(config: any): Promise<Channel[]> {
    this.warnings = []
    if (!config.enabled) return []
    const manual = unique((config.rooms || []).slice(0, 100).map(normalizeRoom)) as string[]
    const count = Math.max(0, Math.min(100, Math.trunc(Number(config.count ?? 20))))
    const categories: string[] = []
    for (const raw of (config.categories || []).slice(0, 8)) {
      const value = String(raw)
      const cid = value in CATEGORIES ? value : Object.keys(CATEGORIES).find(k => CATEGORIES[k] === value)
      if (cid === undefined) throw new ProviderError("Invalid Douyin category")
      if (!categories.includes(cid)) categories.push(cid)
    }
    const rows: Row[] = []
    let errors = 0
    const deadline = Date.now() + 45_000
    const failed = (error: unknown, message: string) => {
      if (error instanceof RoomOfflineError) return
      if (error instanceof TimeoutError) message = "Discovery time budget reached; remaining requests deferred"
      else if (!(error instanceof ProviderError)) throw error
      errors++
      if (!this.warnings.includes(message)) this.warnings.push(message)
    }
    // 先解析分享链接，匹配到的手动房间可以直接走接口，不必请求带验证码的网页。
    const links = unique((config.share_links || []).slice(0, 100)) as string[]
    const sharedIds = new Set<string>()
    for (const r of await fanOut(link => this.sharedRoom(link), links, deadline)) {
      if (r.error === undefined) {
        rows.push(r.result!)
        sharedIds.add(r.result!.id)
      } else failed(r.error, "A Douyin share link could not be fetched")
    }
    for (const r of await fanOut(rid => this.lookup(rid, config), manual.filter(rid => !sharedIds.has(rid)), deadline)) {
      if (r.error === undefined) rows.push(r.result!)
      else failed(r.error, "A manual Douyin room could not be fetched")
    }
    const minViewers = Math.trunc(Number(config.min_viewers ?? 0))
    const buckets: Row[][] = []
    const categoryRows = async (cid: string) => parseCategoryPage(await this.client.fetchText(ORIGIN + "/categorynew/4_" + cid, HEADERS), cid)
    for (const r of await fanOut(categoryRows, count ? categories : [], deadline)) {
      if (r.error === undefined) {
        for (const item of r.result!) this.remember(item.id, item.key, this.identities.get(item.id)?.[1] ?? "")
        buckets.push(r.result!.filter(x => x.viewers >= minViewers).sort((a, b) => b.viewers - a.viewers))
      } else failed(r.error, "A Douyin category could not be fetched")
    }
    const channels: Channel[] = []
    const seen = new Set<string>()
    const add = (r: Row) => {
      if (seen.has(r.key)) return false
      try {
        selectStream(r.streams, config.quality || "HD1")
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e
        if (!this.warnings.includes("A Douyin room has no trusted stream")) this.warnings.push("A Douyin room has no trusted stream")
        return false
      }
      channels.push({ platform: "douyin", room_id: r.id, name: r.name, title: r.title, logo: r.logo })
      seen.add(r.key)
      return true
    }
    rows.forEach(add)
    roundRobin(buckets, count, add)
    if (!channels.length && errors) throw new ProviderError("Douyin discovery failed")
    return channels
  }

  async resolve(roomId: string, config: any, formats: Format[] = ALL_FORMATS): Promise<Stream> {
    const r = await this.lookup(normalizeRoom(roomId), config)
    return selectStream(r.streams, config.quality || "HD1", formats)
  }
}
