// 平台共用的数据结构与发现逻辑（对应 models.py 和 providers/common.py）。
import { fanOut, ProviderError, RoomOfflineError, TimeoutError } from "./util"

export type Platform = "douyin" | "bilibili" | "douyu" | "huya"
export const PLATFORMS: Platform[] = ["douyin", "bilibili", "douyu", "huya"]
export const LABELS: Record<Platform, string> = { douyin: "抖音", bilibili: "B站", douyu: "斗鱼", huya: "虎牙" }

export type Channel = { platform: Platform; room_id: string; name: string; title: string; logo: string }
export type Stream = { url: string; format: "flv" | "hls"; quality: string; headers: Record<string, string> }
export type Format = "flv" | "hls"
export const ALL_FORMATS: Format[] = ["flv", "hls"]

export interface Provider {
  warnings: string[]
  /** 支持只取 HLS（系统播放器不支持 FLV）。 */
  hls?: boolean
  /** 引擎缓存成功地址的秒数上限。 */
  cacheTtl?: number
  discover(config: any): Promise<Channel[]>
  resolve(roomId: string, config: any, formats?: Format[]): Promise<Stream>
}

export const BUDGET = 45_000

export type Row = { id: string; key: string; name: string; title: string; logo: string; viewers: number; [extra: string]: any }

/** 手动房间优先；分类按热度轮流挑选直到 count；未开播静默跳过，抓取失败记一条警告。 */
export async function discover(
  platform: Platform, label: string, warnings: string[], manual: string[],
  room: (id: string) => Promise<Row>, categories: string[], category: (id: string) => Promise<Row[]>,
  count: number, minViewers: number,
): Promise<Channel[]> {
  const deadline = Date.now() + BUDGET
  let errors = 0
  const failed = (error: unknown, message: string) => {
    if (error instanceof RoomOfflineError) return
    if (error instanceof TimeoutError) message = "Discovery time budget reached; remaining requests deferred"
    else if (!(error instanceof ProviderError)) throw error
    errors++
    if (!warnings.includes(message)) warnings.push(message)
  }
  const rows: Row[] = []
  for (const r of await fanOut(room, manual, deadline)) {
    if (r.error === undefined) rows.push(r.result!)
    else failed(r.error, "A manual " + label + " room could not be fetched")
  }
  const buckets: Row[][] = []
  for (const r of await fanOut(category, count ? categories : [], deadline)) {
    if (r.error === undefined) buckets.push(r.result!.filter(x => x.viewers >= minViewers).sort((a, b) => b.viewers - a.viewers))
    else failed(r.error, "A " + label + " category could not be fetched")
  }
  const channels: Channel[] = []
  const seen = new Set<string>()
  const add = (row: Row) => {
    if (seen.has(row.key)) return false
    channels.push({ platform, room_id: row.id, name: row.name, title: row.title, logo: row.logo })
    seen.add(row.key)
    return true
  }
  rows.forEach(add)
  roundRobin(buckets, count, add)
  if (!channels.length && errors) throw new ProviderError(label + " discovery failed")
  return channels
}

/** 分类之间轮流取当前人气最高的一个，避免一个热门分类挤占名额。 */
export function roundRobin(buckets: Row[][], count: number, add: (row: Row) => boolean) {
  let added = 0
  while (buckets.some(b => b.length) && added < count) {
    const ordered = buckets.filter(b => b.length).sort((a, b) => b[0].viewers - a[0].viewers)
    for (const bucket of ordered) {
      if (added >= count) break
      if (add(bucket.shift()!)) added++
    }
  }
}
