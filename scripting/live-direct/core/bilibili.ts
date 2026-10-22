// B站：固定 API 域名（对应 providers/bilibili.py）。
// 接口与选流参考 akiralereal/iptv extractors/bilibili-live（GPL-3.0）。
import { ALL_FORMATS, type Channel, type Format, type Provider, type Stream } from "./common"
import type { Client } from "./net"
import { fanOut, mediaUrl, ProviderError, RoomOfflineError, TimeoutError, unique, urlencode, validateUrl } from "./util"

const API = "https://api.live.bilibili.com"
const PASSPORT_API = "https://passport.bilibili.com"
const REFERER = "https://live.bilibili.com/"
export const AREAS: Record<string, string> = {
  "2": "网游", "3": "手游", "6": "单机游戏", "1": "娱乐", "5": "电台", "9": "虚拟主播", "10": "生活", "11": "知识", "13": "赛事",
}
export const QUALITIES: Record<number, string> = { 0: "最高", 30000: "杜比", 20000: "4K", 10000: "原画", 400: "蓝光", 250: "超清", 150: "高清", 80: "流畅" }

export function normalizeRoom(value: unknown): string {
  let text = String(value).trim()
  if (text.includes("://")) {
    const p = validateUrl(text, ["live.bilibili.com"])
    if (p.query) throw new ProviderError("Invalid Bilibili room identifier")
    text = p.path.replace(/^\/+|\/+$/g, "")
    if (text.startsWith("h5/")) text = text.slice(3)
  }
  if (!/^[0-9]{1,20}$/.test(text) || BigInt(text) <= 0n) throw new ProviderError("Invalid Bilibili room identifier")
  return BigInt(text).toString()
}

type Candidate = { rank: number[]; stream: Stream }

function compareRank(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

export function selectStream(data: any, preferAvc = true, formats: Format[] = ALL_FORMATS): Stream {
  const streams = data?.playurl_info?.playurl?.stream
  if (data?.playurl_info?.playurl === undefined || streams === undefined) throw new ProviderError("Bilibili play data unavailable")
  const candidates: Candidate[] = []
  for (const stream of streams || []) {
    const protocol = stream?.protocol_name
    for (const fmt of stream?.format || []) {
      const name = fmt?.format_name
      const kind: Format | null = protocol === "http_stream" && name === "flv" ? "flv"
        : protocol === "http_hls" && (name === "ts" || name === "fmp4") ? "hls" : null
      if (!kind || !formats.includes(kind)) continue
      for (const codec of fmt.codec || []) {
        const cname = codec?.codec_name
        if (cname !== "avc" && cname !== "hevc") continue
        for (const host of codec.url_info || []) {
          let url: string
          try {
            // 直接拼接，保留签名参数原样。
            if (typeof host?.host !== "string" || typeof codec.base_url !== "string") continue
            url = mediaUrl((host.host ?? "") + codec.base_url + (host.extra ?? ""), "bilibili", kind)
          } catch (e) {
            if (e instanceof ProviderError) continue
            throw e
          }
          const rank = preferAvc ? [cname === "avc" ? 0 : 1, kind === "flv" ? 0 : 1] : [kind === "flv" ? 0 : 1, cname === "hevc" ? 0 : 1]
          candidates.push({ rank, stream: { url, format: kind, quality: String(codec.current_qn || ""), headers: { Referer: REFERER } } })
        }
      }
    }
  }
  if (!candidates.length) throw new ProviderError("Bilibili room has no trusted playable stream")
  return candidates.reduce((best, c) => compareRank(c.rank, best.rank) < 0 ? c : best).stream
}

export class Bilibili implements Provider {
  hls = true
  warnings: string[] = []

  constructor(private client: Client) {}

  private async api(path: string, params: Record<string, string | number>, config: any): Promise<any> {
    const headers: Record<string, string> = { Referer: REFERER, Accept: "application/json" }
    const session = config.sessdata || ""
    if (session) {
      if (typeof session !== "string" || session.length > 4096 || /[\s;\x00-\x1f\x7f]/.test(session)) {
        throw new ProviderError("Invalid Bilibili session configuration")
      }
      headers.Cookie = "SESSDATA=" + session
    }
    const payload = await this.client.fetchJson(API + path + "?" + urlencode(params), headers)
    if (!payload || typeof payload !== "object" || payload.code !== 0) {
      if (payload?.code === -352) throw new ProviderError("Bilibili API risk control; anonymous access unavailable")
      throw new ProviderError("Bilibili API request failed")
    }
    return payload.data
  }

  private async room(rid: string, config: any): Promise<Channel> {
    const data = await this.api("/room/v1/Room/get_info", { room_id: rid }, config)
    if (!data || typeof data !== "object" || !("live_status" in data)) throw new ProviderError("Bilibili room info unavailable")
    if (data.live_status !== 1) throw new RoomOfflineError("Bilibili room is offline")
    const canonical = normalizeRoom(data.room_id || rid)
    return {
      platform: "bilibili", room_id: canonical, name: String(data.uname || "Bilibili " + canonical),
      title: String(data.title || ""), logo: String(data.user_cover || data.keyframe || ""),
    }
  }

  async discover(config: any): Promise<Channel[]> {
    this.warnings = []
    if (!config.enabled) return []
    const channels: Channel[] = []
    const seen = new Set<string>()
    let errors = 0
    const deadline = Date.now() + 45_000
    const warn = (m: string) => { if (!this.warnings.includes(m)) this.warnings.push(m) }
    const add = (c: Channel) => {
      if (!seen.has(c.room_id)) {
        channels.push(c)
        seen.add(c.room_id)
      }
    }
    const failed = (error: unknown, message: string) => {
      if (error instanceof RoomOfflineError) return
      if (error instanceof TimeoutError) { errors++; warn("Discovery time budget reached") }
      else if (error instanceof ProviderError) { errors++; warn(message) }
      else throw error
    }
    const manual = unique((config.rooms || []).slice(0, 100).map(normalizeRoom)) as string[]
    for (const r of await fanOut(rid => this.room(rid, config), manual, deadline)) {
      if (r.error === undefined) add(r.result!)
      else failed(r.error, "A Bilibili room could not be fetched")
    }
    const areas = unique((config.areas || []).slice(0, 16).map(String)) as string[]
    const count = Math.max(0, Math.min(50, Math.trunc(Number(config.top_per_area ?? 5))))
    if (areas.length && count) {
      let areaMap: Record<string, string> = {}
      if (areas.some(a => !/^[0-9]{1,4}$/.test(a))) {
        const raw = await this.api("/room/v1/Area/getList", {}, config)
        if (!Array.isArray(raw)) throw new ProviderError("Bilibili area list unavailable")
        areaMap = Object.fromEntries(raw.filter(a => a && typeof a === "object").map(a => [String(a.name), String(a.id)]))
      }
      const areaIds = areas.map(area => {
        const aid = /^[0-9]{1,4}$/.test(area) ? area : areaMap[area]
        if (aid === undefined) throw new ProviderError("Unknown Bilibili parent area")
        return aid
      })
      const minOnline = Math.trunc(Number(config.min_online ?? 0))
      const areaRows = async (aid: string) => {
        const rows = await this.api("/room/v1/Area/getRoomList", {
          platform: "web", parent_area_id: aid, area_id: 0, sort_type: "online", page: 1, page_size: Math.min(count * 2, 50),
        }, config)
        if (!Array.isArray(rows)) throw new ProviderError("Bilibili area data unavailable")
        return rows
      }
      for (const r of await fanOut(areaRows, areaIds, deadline)) {
        if (r.error !== undefined) {
          failed(r.error, "A Bilibili area could not be fetched")
          continue
        }
        let accepted = 0
        for (const item of r.result!) {
          if (!item || typeof item !== "object") continue
          let online: number, rid: string
          try {
            online = Math.trunc(Number(item.online ?? 0))
            if (!Number.isFinite(online)) continue
            rid = normalizeRoom(item.roomid ?? "")
          } catch {
            continue
          }
          if (online < minOnline || seen.has(rid)) continue
          // 分区列表只含在播房间，并已带规范房间号和元数据，不必逐个查询。
          add({
            platform: "bilibili", room_id: rid, name: String(item.uname || "Bilibili " + rid),
            title: String(item.title || ""), logo: String(item.face || item.user_cover || ""),
          })
          if (++accepted >= count) break
        }
      }
    }
    if (!channels.length && errors) throw new ProviderError("Bilibili discovery failed")
    return channels
  }

  async resolve(roomId: string, config: any, formats: Format[] = ALL_FORMATS): Promise<Stream> {
    const rid = normalizeRoom(roomId)
    const wanted = Math.trunc(Number(config.quality ?? 10000))
    const play = async (qn: number) => {
      // getRoomPlayInfo 自带 live_status，切换画质只需一次请求。
      const data = await this.api("/xlive/web-room/v2/index/getRoomPlayInfo", {
        room_id: rid, protocol: "0,1", format: "0,1,2", codec: "0,1", qn, platform: "web", ptype: 8,
      }, config)
      if (!data || typeof data !== "object") throw new ProviderError("Bilibili play data unavailable")
      if ("live_status" in data && data.live_status !== 1) throw new RoomOfflineError("Bilibili room is offline")
      return data
    }
    const preferAvc = config.prefer_avc ?? true
    const data = await play(wanted || 10000)
    let stream = selectStream(data, preferAvc, formats)
    if (wanted === 0 && Number(stream.quality || 0) >= 10000) {
      // “最高”取接口宣称的最高档，但不重试被匿名降级的请求。
      const accepted: number[] = []
      for (const protocol of data.playurl_info?.playurl?.stream || []) {
        for (const fmt of protocol.format || []) {
          for (const codec of fmt.codec || []) {
            accepted.push(...(codec.accept_qn || []).filter((q: unknown) => Number.isInteger(q) && (q as number) > 0 && (q as number) <= 30000))
          }
        }
      }
      const highest = Math.max(0, ...accepted)
      if (highest > Number(stream.quality)) stream = selectStream(await play(highest), preferAvc, formats)
    }
    return stream
  }

  async qrcodeGenerate(): Promise<{ url: string; qrcode_key: string }> {
    const payload = await this.client.fetchJson(PASSPORT_API + "/x/passport-login/web/qrcode/generate", { Accept: "application/json" })
    if (!payload || payload.code !== 0) throw new ProviderError("Bilibili QR generate failed")
    const { url, qrcode_key } = payload.data || {}
    if (typeof url !== "string" || !url || typeof qrcode_key !== "string" || !qrcode_key) throw new ProviderError("Invalid Bilibili QR payload")
    return { url, qrcode_key }
  }

  async qrcodePoll(key: string): Promise<{ status: string; message: string; sessdata?: string }> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new ProviderError("Invalid qrcode_key")
    const { cookies, json } = await this.client.fetchJsonWithCookies(
      PASSPORT_API + "/x/passport-login/web/qrcode/poll?" + urlencode({ qrcode_key: key }), { Accept: "application/json" })
    if (!json || json.code !== 0) throw new ProviderError("Bilibili QR poll failed")
    const data = json.data || {}
    if (data.code === 86101) return { status: "waiting", message: "未扫码" }
    if (data.code === 86090) return { status: "scanned", message: "已扫码，请在手机上确认" }
    if (data.code === 86038) return { status: "expired", message: "二维码已失效" }
    if (data.code === 0) {
      let sessdata = cookies.find(c => c.name === "SESSDATA")?.value
      if (!sessdata && typeof data.url === "string") {
        // 保留原始百分号编码，与 Cookie 中的值一致。
        sessdata = /[?&]SESSDATA=([^&#]+)/.exec(data.url)?.[1]
      }
      if (!sessdata || sessdata.length > 4096 || /[\s;\x00-\x1f\x7f]/.test(sessdata)) {
        throw new ProviderError("Failed to extract valid SESSDATA from login response")
      }
      return { status: "success", sessdata, message: "登录成功" }
    }
    return { status: "error", message: String(data.message || "未知状态") }
  }
}
