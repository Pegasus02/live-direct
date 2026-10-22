// 斗鱼：固定域名网页接口，websec 密钥交换（纯 MD5）签名，不执行远程脚本（对应 providers/douyu.py）。
// 分类与房间数据参考 akiralereal/iptv extractors/douyu-live（GPL-3.0）。
import { type Channel, discover, type Provider, type Row, type Stream } from "./common"
import type { Client } from "./net"
import { categoryIds, clean, md5, mediaUrl, parseHeat, ProviderError, RoomOfflineError, unique, validateUrl } from "./util"

const ORIGIN = "https://www.douyu.com"
const PLAY_API = "https://playweb.douyucdn.cn"
const REFERER = ORIGIN + "/"
// 网页播放器的匿名设备号，不是账号凭据。
const DID = "10000000000000000000000000001501"
const PLAYER_VERSION = "219032101"
export const CATEGORIES: Record<string, string> = { "1_1": "网游竞技", "1_15": "单机热游", "1_9": "手游休闲", "1_2": "娱乐" }
export const QUALITIES: Record<number, string> = { 0: "原画", 4: "蓝光", 3: "超清", 2: "高清" }
const HEADERS = { Referer: REFERER, Accept: "application/json" }

export function normalizeRoom(value: unknown): string {
  let text = String(value).trim()
  if (text.includes("://")) {
    const p = validateUrl(text, ["www.douyu.com", "douyu.com"])
    if (p.query) throw new ProviderError("Invalid Douyu room identifier")
    text = p.path.replace(/^\/+|\/+$/g, "")
  }
  if (!/^[0-9]{1,12}$/.test(text) || Number(text) <= 0) throw new ProviderError("Invalid Douyu room identifier")
  return String(Number(text))
}

/** 根据 getEncryption 返回的数据生成 getH5PlayV1 表单。 */
export function sign(keyData: any, rid: string, now: number): Record<string, string> {
  const { rand_str: rand, key, enc_time: rounds, enc_data: enc } = keyData && typeof keyData === "object" ? keyData : {} as any
  if (![rand, key, enc].every(v => typeof v === "string" && v.length > 0 && v.length <= 4096)
    || typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 0 || rounds > 64) {
    throw new ProviderError("Douyu play key unavailable")
  }
  let secret: string = rand
  for (let i = 0; i < rounds; i++) secret = md5(secret + key)
  const salt = keyData.is_special ? "" : rid + String(now)
  return { enc_data: enc, tt: String(now), did: DID, auth: md5(secret + key + salt) }
}

export function parseCategory(payload: any, category = ""): Row[] {
  if (!payload || typeof payload !== "object" || payload.code !== 0) throw new ProviderError("Douyu category data unavailable")
  const rows = (payload.data || {}).rl
  if (!Array.isArray(rows)) throw new ProviderError("Douyu category data unavailable")
  const result: Row[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    let rid: string
    try {
      rid = normalizeRoom(row.rid ?? "")
    } catch {
      continue
    }
    const nick = clean(row.nn), title = clean(row.rn)
    result.push({ id: rid, key: rid, name: nick || title || "Douyu " + rid, title, logo: String(row.rs16 || ""), viewers: parseHeat(row.ol), category })
  }
  return result
}

export function parseRoom(payload: any): Row {
  const room = payload?.room
  if (!room || typeof room !== "object" || !("show_status" in room)) throw new ProviderError("Douyu room info unavailable")
  // show_status 1 为直播中；videoLoop 表示录像轮播。
  if (![1, "1"].includes(room.show_status) || [1, "1"].includes(room.videoLoop)) throw new RoomOfflineError("Douyu room is offline")
  const rid = normalizeRoom(room.room_id ?? "")
  const nick = clean(room.nickname), title = clean(room.room_name)
  return { id: rid, key: rid, name: nick || "Douyu " + rid, title, logo: String(room.room_pic || ""), viewers: 0 }
}

/** 与网页播放器一样拼接 FLV 地址和签名后的流名。 */
export function streamFrom(data: any): Stream {
  if (!data || typeof data !== "object") throw new ProviderError("Douyu play data unavailable")
  const base = data.rtmp_url, live = data.rtmp_live
  if (typeof base !== "string" || typeof live !== "string" || !base || !live) throw new ProviderError("Douyu play data unavailable")
  const url = mediaUrl(base.replace(/\/+$/, "") + "/" + live.replace(/^\/+/, ""), "douyu", "flv")
  // 流名后缀（如 _2000）是实际码率，没有则为原画。
  const tier = /_([0-9]{3,5})\.flv(?:\?|$)/.exec(live)
  return { url, format: "flv", quality: tier ? tier[1] : "origin", headers: { Referer: REFERER } }
}

export class Douyu implements Provider {
  warnings: string[] = []

  constructor(private client: Client) {}

  private async room(rid: string): Promise<Row> {
    return parseRoom(await this.client.fetchJson(ORIGIN + "/betard/" + rid, HEADERS))
  }

  private async play(rid: string, rate: number, cdn?: string): Promise<any> {
    const key = await this.client.fetchJson(ORIGIN + "/wgapi/livenc/liveweb/websec/getEncryption?did=" + DID, HEADERS)
    if (!key || typeof key !== "object" || key.error !== 0) throw new ProviderError("Douyu play key unavailable")
    const form = sign(key.data, rid, Math.floor(Date.now() / 1000))
    Object.assign(form, { rate: String(rate), ver: PLAYER_VERSION, iar: "0", ive: "0", rid, hevc: "0", fa: "0", sov: "0" })
    if (cdn) form.cdn = cdn
    const payload = await this.client.fetchJson(PLAY_API + "/lapi/live/getH5PlayV1/" + rid, { ...HEADERS, Origin: ORIGIN }, form)
    if (!payload || typeof payload !== "object" || payload.error !== 0) throw new ProviderError("Douyu play API request failed")
    return payload.data
  }

  async discover(config: any): Promise<Channel[]> {
    this.warnings = []
    if (!config.enabled) return []
    const manual = unique((config.rooms || []).slice(0, 100).map(normalizeRoom)) as string[]
    const count = Math.max(0, Math.min(100, Math.trunc(Number(config.count ?? 10))))
    const categories = categoryIds(config.categories || [], CATEGORIES, "Douyu")
    const category = async (cid: string) => parseCategory(await this.client.fetchJson(ORIGIN + "/gapi/rkc/directory/mixListV1/" + cid + "/1", HEADERS), cid)
    return discover("douyu", "Douyu", this.warnings, manual, rid => this.room(rid), categories, category, count, Math.trunc(Number(config.min_viewers ?? 0)))
  }

  async resolve(roomId: string, config: any): Promise<Stream> {
    const rid = (await this.room(normalizeRoom(roomId))).id
    const rate = Math.trunc(Number(config.quality ?? 0))
    const data = await this.play(rid, rate)
    try {
      return streamFrom(data)
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e
    }
    // 默认线路不是可信 HTTPS CDN 时，换其他宣称的线路。
    const lines = Array.isArray(data?.cdnsWithName) ? data.cdnsWithName.slice(0, 4) : []
    for (const line of lines) {
      const cdn = line?.cdn
      if (typeof cdn !== "string" || cdn === data.rtmp_cdn || !/^[A-Za-z0-9_-]{1,32}$/.test(cdn)) continue
      try {
        return streamFrom(await this.play(rid, rate, cdn))
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e
      }
    }
    throw new ProviderError("Douyu room has no trusted playable stream")
  }
}
