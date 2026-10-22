// 虎牙：公开房间页 / 分类页，只解析 JSON，重新签名 FLV 防盗链参数（对应 providers/huya.py）。
// 页面解析、码率选择和匿名签名改写自 akiralereal/iptv extractors/huya-live（GPL-3.0）。
import { ALL_FORMATS, type Channel, discover, type Format, type Provider, type Row, type Stream } from "./common"
import type { Client } from "./net"
import { assignedJson, base64Decode, categoryIds, clean, md5, mediaUrl, parseHeat, parseQsl, ProviderError, RoomOfflineError, unique, urlencode, validateUrl } from "./util"

const ORIGIN = "https://www.huya.com"
const REFERER = ORIGIN + "/"
export const CATEGORIES: Record<string, string> = { "100023": "网游", "100004": "手游", "100002": "单机", "100022": "娱乐" }
export const QUALITIES: Record<number, string> = { 0: "原画", 20000: "4K", 14000: "2K", 4000: "蓝光", 2000: "超清", 500: "流畅" }
const HEADERS = { Referer: REFERER, Accept: "text/html", "Accept-Language": "zh-CN" }
const HIGH_RES = 10000
// 同一房间在这段时间内再次请求，从下一条 CDN 线路开始。
const RETRY_WINDOW = 120_000

export function normalizeRoom(value: unknown): string {
  let text = String(value).trim()
  if (text.includes("://")) {
    const p = validateUrl(text, ["www.huya.com", "huya.com"])
    if (p.query) throw new ProviderError("Invalid Huya room identifier")
    text = p.path.replace(/^\/+|\/+$/g, "")
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(text) || ["g", "m", "l"].includes(text.toLowerCase())) throw new ProviderError("Invalid Huya room identifier")
  return text
}

export function parseCategoryPage(page: string, category = ""): Row[] {
  const marker = /var\s+ALL_LIST_DATA\s*=\s*/.exec(page)
  if (!marker) throw new ProviderError("Huya category page format unavailable")
  const rows = assignedJson(page, marker.index + marker[0].length)
  if (!Array.isArray(rows)) throw new ProviderError("Huya category page format unavailable")
  const result: Row[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    let rid: string
    try {
      rid = normalizeRoom(row.lProfileRoom || row.sPrivateHost || "")
    } catch {
      continue
    }
    const nick = clean(row.sNick), title = clean(row.sIntroduction || row.sRoomName)
    result.push({
      id: rid, key: rid, name: nick || title || "Huya " + rid, title, logo: String(row.sScreenshot || row.sAvatar180 || ""),
      viewers: parseHeat(row.lTotalCount || row.lUserCount || 0), category,
    })
  }
  return result
}

/** 只读 hyPlayerConfig.stream；外层是脚本对象，不是 JSON。 */
export function parseRoomPage(page: string, requestedId: string): Row {
  const configAt = page.indexOf("var hyPlayerConfig")
  let markerEnd = -1
  if (configAt >= 0) {
    const re = /\bstream\s*:\s*/g
    re.lastIndex = configAt
    const m = re.exec(page)
    if (m) markerEnd = m.index + m[0].length
  }
  // 没有播放器数据可能是反爬页面，不能当作未开播。
  if (markerEnd < 0) throw new ProviderError("Huya room page format unavailable")
  if (["\"", "'", "n"].includes(page[markerEnd])) throw new RoomOfflineError("Huya room is offline")
  const stream = assignedJson(page, markerEnd)
  const rows = stream && typeof stream === "object" && !Array.isArray(stream) ? stream.data : null
  const row = (Array.isArray(rows) ? rows : []).find((r: any) => r && typeof r === "object" && r.gameStreamInfoList && (!Array.isArray(r.gameStreamInfoList) || r.gameStreamInfoList.length))
  if (!row || !Array.isArray(row.gameStreamInfoList)) throw new RoomOfflineError("Huya room is offline")
  const info = row.gameLiveInfo || {}
  const rid = normalizeRoom(String(info.profileRoom || requestedId))
  const nick = clean(info.nick), title = clean(info.introduction || info.roomName)
  return {
    id: rid, key: rid, name: nick || title || "Huya " + rid, title, logo: String(info.screenshot || info.avatar180 || ""),
    viewers: parseHeat(info.totalCount || 0), uid: String(info.uid || "0"), lines: row.gameStreamInfoList,
    bitrates: stream.vMultiStreamInfo || [],
  }
}

export function selectBitrate(rows: any[], requested = 0): number {
  // HDR 档（iCompatibleFlag 非 0）网页线路不提供。
  const rates = unique(rows.filter(r => r && typeof r === "object" && !r.iCompatibleFlag && Number.isInteger(r.iBitRate) && typeof r.iBitRate === "number" && r.iBitRate > 0)
    .map(r => r.iBitRate as number)).sort((a, b) => b - a)
  if (requested === 0) return rates.length && rates[0] >= HIGH_RES ? rates[0] : 0
  if (requested >= HIGH_RES) {
    // 要 2K/4K 但房间没有：给原画，不低于原画。
    return rates.find(r => HIGH_RES <= r && r <= requested) ?? 0
  }
  if (!rates.length) return requested
  return rates.find(r => r <= requested) ?? rates[rates.length - 1]
}

/** 用页面 anti-code 中 base64 的 fm 模板（$0..$3 占位）重新计算 wsSecret。 */
export function signUrl(line: any, uid: string, bitrate: number, fmt: Format, nowMs: number): string {
  const prefix = fmt === "flv" ? "sFlv" : "sHls"
  const name = line.sStreamName, base = line[prefix + "Url"]
  const suffix = line[prefix + "UrlSuffix"] || (fmt === "hls" ? "m3u8" : "flv"), anti = line[prefix + "AntiCode"]
  if (![name, base, suffix, anti].every(v => typeof v === "string" && v) || !/^[A-Za-z0-9_.-]{1,200}$/.test(name)) {
    throw new ProviderError("Huya line unavailable")
  }
  const old = parseQsl(anti.replace(/&amp;/g, "&"))
  const values: Record<string, string> = Object.fromEntries(old)
  const wsTime = values.wsTime ?? "", ctype = values.ctype || "huya_webh5"
  let template: string
  try {
    template = base64Decode((values.fm ?? "").replace(/ /g, "+"))
  } catch {
    throw new ProviderError("Huya line signature unavailable")
  }
  if (!/^[0-9a-fA-F]{1,16}$/.test(wsTime) || !template.includes("$1")) throw new ProviderError("Huya line signature unavailable")
  const seqid = String(nowMs), platform = "100"
  const secret = md5(template.split("$0").join(uid).split("$1").join(name)
    .split("$2").join(md5(seqid + "|" + ctype + "|" + platform)).split("$3").join(wsTime))
  const replaced = new Set(["wsSecret", "wsTime", "fm", "seqid", "ctype", "ver", "ratio", "u", "t"])
  const params: [string, string][] = [["wsSecret", secret], ["wsTime", wsTime], ["seqid", seqid], ["ctype", ctype], ["ver", "1"]]
  params.push(...old.filter(([k]) => !replaced.has(k)))
  if (bitrate > 0) params.push(["ratio", String(bitrate)])
  params.push(["u", uid], ["t", platform])
  const url = base.replace(/\/+$/, "") + "/" + name + "." + suffix.replace(/^\.+/, "") + "?" + urlencode(params)
  return mediaUrl(url, "huya", fmt)
}

/** 先在所有线路上找 FLV，再找 HLS；start 决定从哪条 CDN 线路开始。 */
export function selectStream(room: Row, quality = 0, start = 0, nowMs?: number, formats: Format[] = ALL_FORMATS): Stream {
  const lines = (room.lines as any[]).filter(l => l && typeof l === "object")
  if (!lines.length) throw new ProviderError("Huya room has no trusted playable stream")
  start %= lines.length
  const ordered = [...lines.slice(start), ...lines.slice(0, start)]
  const bitrate = selectBitrate(room.bitrates, quality)
  const now = nowMs ?? Date.now()
  for (const fmt of formats) {
    for (const line of ordered) {
      try {
        return { url: signUrl(line, room.uid, bitrate, fmt, now), format: fmt, quality: String(bitrate || "origin"), headers: { Referer: REFERER } }
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e
      }
    }
  }
  throw new ProviderError("Huya room has no trusted playable stream")
}

export class Huya implements Provider {
  hls = true
  // 引擎只缓存成功地址这么久：同一次起播的重复请求共用一个地址，之后重连会换线路。
  cacheTtl = 5
  warnings: string[] = []
  private recent = new Map<string, [number, number]>()

  constructor(private client: Client) {}

  private async room(rid: string): Promise<Row> {
    return parseRoomPage(await this.client.fetchText(ORIGIN + "/" + rid, HEADERS), rid)
  }

  private lineStart(rid: string): number {
    const now = Date.now()
    const [at, index] = this.recent.get(rid) ?? [0, -1]
    const next = now - at < RETRY_WINDOW ? index + 1 : 0
    for (const [k, v] of this.recent) if (now - v[0] >= RETRY_WINDOW) this.recent.delete(k)
    if (this.recent.size < 512 || this.recent.has(rid)) this.recent.set(rid, [now, next])
    return next
  }

  async discover(config: any): Promise<Channel[]> {
    this.warnings = []
    if (!config.enabled) return []
    const manual = unique((config.rooms || []).slice(0, 100).map(normalizeRoom)) as string[]
    const count = Math.max(0, Math.min(100, Math.trunc(Number(config.count ?? 10))))
    const categories = categoryIds(config.categories || [], CATEGORIES, "Huya")
    const category = async (cid: string) => parseCategoryPage(await this.client.fetchText(ORIGIN + "/g/" + cid, HEADERS), cid)
    return discover("huya", "Huya", this.warnings, manual, rid => this.room(rid), categories, category, count, Math.trunc(Number(config.min_viewers ?? 0)))
  }

  async resolve(roomId: string, config: any, formats: Format[] = ALL_FORMATS): Promise<Stream> {
    const room = await this.room(normalizeRoom(roomId))
    return selectStream(room, Math.trunc(Number(config.quality ?? 0)), this.lineStart(room.id), undefined, formats)
  }
}
