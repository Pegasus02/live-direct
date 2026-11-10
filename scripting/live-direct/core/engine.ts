// 频道发现、播放地址缓存与 M3U 生成（对应 app.Engine）。JS 单线程，用 Promise 做单飞与并发上限。
import { Bilibili } from "./bilibili"
import { type Channel, LABELS, type Platform, PLATFORMS, type Provider, type Stream } from "./common"
import type { Config } from "./config"
import { Douyin } from "./douyin"
import { Douyu } from "./douyu"
import { Huya } from "./huya"
import type { Client } from "./net"
import { cleanText, safeLogo, safeMedia } from "./util"

export const ROOM = /^[A-Za-z0-9_-]{1,64}$/

export type Health = {
  enabled: boolean; status: "ok" | "error" | "disabled"; count: number
  cached?: boolean; last_success?: number; warnings?: string[]; message?: string
}

export class LookupError extends Error {}
export class UnavailableError extends Error {}

export function defaultProviders(client: Client): Record<Platform, Provider> {
  return { douyin: new Douyin(client), bilibili: new Bilibili(client), douyu: new Douyu(client), huya: new Huya(client) }
}

const key = (platform: string, room: string) => platform + "/" + room

export class Engine {
  channels = new Map<string, Channel>()
  health: Partial<Record<Platform, Health>> = {}
  updated = 0
  private generation = 0
  private revision = 0
  private cache = new Map<string, [number, Stream | null]>()
  private pending = new Map<string, Promise<Stream>>()
  private resolving = 0
  private refreshing: Promise<void> | null = null
  private refreshAgain = false
  /** 每次频道列表或状态变化时通知界面。 */
  onChange?: () => void

  constructor(private config: () => Config, public providers: Partial<Record<Platform, Provider>>) {}

  /** 配置变化后立即作废旧频道和地址。 */
  invalidate() {
    this.revision++
    this.generation++
    this.channels = new Map()
    this.cache.clear()
    this.updated = 0
    this.onChange?.()
  }

  get isRefreshing() {
    return this.refreshing !== null
  }

  /** 已在刷新时只记下再刷一次，返回 false。 */
  startRefresh(): boolean {
    if (this.refreshing) {
      this.refreshAgain = true
      return false
    }
    this.refreshing = (async () => {
      try {
        do {
          this.refreshAgain = false
          await this.refresh()
        } while (this.refreshAgain)
      } finally {
        this.refreshing = null
        this.onChange?.()
      }
    })()
    this.onChange?.()
    return true
  }

  async waitForRefresh() {
    while (this.refreshing) await this.refreshing
  }

  maybeRefresh() {
    if (this.updated === 0 || Date.now() - this.updated > 120_000) this.startRefresh()
  }

  private async refresh() {
    const revision = this.revision
    const cfg = this.config()
    const updated = new Map<string, Channel>()
    const health: Partial<Record<Platform, Health>> = {}
    const entries = Object.entries(this.providers) as [Platform, Provider][]
    // 各平台互不依赖，并发发现。
    const results = await Promise.all(entries.map(async ([platform, provider]) => {
      if (!cfg[platform]?.enabled) return { platform, provider, skipped: true as const }
      try {
        return { platform, provider, rows: await provider.discover(cfg[platform]) }
      } catch (error) {
        return { platform, provider, error }
      }
    }))
    for (const r of results) {
      if ("skipped" in r) {
        health[r.platform] = { enabled: false, status: "disabled", count: 0 }
      } else if ("rows" in r) {
        let count = 0
        for (const ch of r.rows!.slice(0, 500)) {
          if (ch.platform === r.platform && ROOM.test(String(ch.room_id))) {
            if (!updated.has(key(r.platform, ch.room_id))) count++
            updated.set(key(r.platform, String(ch.room_id)), ch)
          }
        }
        health[r.platform] = {
          enabled: true, status: "ok", count, cached: false, last_success: Math.floor(Date.now() / 1000),
          warnings: Array.from(new Set(r.provider.warnings)).slice(0, 20),
        }
      } else {
        const old = [...this.channels].filter(([k]) => k.startsWith(r.platform + "/"))
        old.forEach(([k, v]) => updated.set(k, v))
        health[r.platform] = { enabled: true, status: "error", count: old.length, cached: old.length > 0, message: "频道刷新失败；保留上次成功列表，不代表当前可播" }
      }
    }
    if (revision !== this.revision) return
    this.channels = updated
    this.health = health
    this.updated = Date.now()
    this.generation++
    this.cache.clear()
    this.onChange?.()
  }

  status() {
    return { platforms: { ...this.health }, channel_count: this.channels.size, refreshing: this.isRefreshing }
  }

  listChannels(): Channel[] {
    return [...this.channels.values()].map(c => ({ ...c, name: cleanText(c.name), title: cleanText(c.title) }))
  }

  /** 与服务端完全相同的 M3U；播放地址指向本机服务。 */
  playlist(base: string, token: string): string {
    this.maybeRefresh()
    const cfg = this.config()
    if (!this.channels.size && (this.updated === 0 || Object.values(this.health).some(h => h?.status === "error"))) {
      if (PLATFORMS.some(p => cfg[p].enabled)) throw new UnavailableError("channels not ready")
    }
    const lines = ["#EXTM3U"]
    for (const ch of this.channels.values()) {
      const group = LABELS[ch.platform] ?? ch.platform
      const title = cleanText(ch.name) + (ch.title ? " · " + cleanText(ch.title) : "")
      const logo = safeLogo(ch.logo)
      const attrs = `tvg-id="${ch.platform}-${ch.room_id}"` + (logo ? ` tvg-logo="${logo}"` : "")
      lines.push(`#EXTINF:-1 ${attrs} group-title="${group}",${title}`, `${base}/s/${token}/live/${ch.platform}/${ch.room_id}`)
    }
    return lines.join("\n") + "\n"
  }

  /** LookupError：未知/未启用/不支持 HLS；其它错误：暂时无法解析。 */
  async resolve(platform: Platform, room: string, hls = false): Promise<Stream> {
    const cfg = this.config()
    const provider = this.providers[platform]
    if (!provider || !cfg[platform]?.enabled || !this.channels.has(key(platform, room))) throw new LookupError()
    if (hls && !provider.hls) throw new LookupError()
    const generation = this.generation
    const cacheKey = [generation, platform, room, hls].join("|")
    const cached = this.cache.get(cacheKey)
    if (cached && cached[0] > Date.now()) {
      if (!cached[1]) throw new UnavailableError("temporarily unavailable")
      return cached[1]
    }
    const inflight = this.pending.get(cacheKey)
    if (inflight) return inflight
    if (this.resolving >= 6) throw new UnavailableError("busy")
    this.resolving++
    const work = (async () => {
      let stream: Stream | null = null
      try {
        stream = await (hls ? provider.resolve(room, cfg[platform], ["hls"]) : provider.resolve(room, cfg[platform]))
        if (!safeMedia(stream.url, platform)) throw new Error("invalid media")
        // 302 不会把请求头带给播放器，带登录 Cookie 的地址不能跳转。
        if (Object.keys(stream.headers).some(k => k.toLowerCase() === "cookie")) throw new Error("credential-bound media cannot redirect")
        if (generation !== this.generation || !this.channels.has(key(platform, room))) throw new UnavailableError("configuration changed")
        return stream
      } catch (e) {
        stream = null
        throw e
      } finally {
        if (generation === this.generation) {
          const ttl = stream ? Math.min(30, provider.cacheTtl ?? 30) : 5
          this.cache.set(cacheKey, [Date.now() + ttl * 1000, stream])
        }
        this.pending.delete(cacheKey)
        this.resolving--
      }
    })()
    this.pending.set(cacheKey, work)
    return work
  }
}
