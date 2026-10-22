// 手机上的 Live Direct 后端：引擎 + 本机 HTTP 服务，路由与 NAS 版一致：
//   /s/令牌/interface.m3u、/s/令牌/live/平台/房间（302 到 CDN）、/s/令牌/hls/平台/房间（只取 HLS）
import { useEffect, useState } from "scripting"
import { Bilibili } from "./core/bilibili"
import type { Platform } from "./core/common"
import { type Config, merge } from "./core/config"
import { defaultProviders, Engine, LookupError, ROOM } from "./core/engine"
import { createClient } from "./core/net"
import { loadConfig, readSettings, saveConfig, subscriptionToken, syncFavorites } from "./store"
import { scriptingTransport } from "./transport"

export const client = createClient(scriptingTransport)

class Backend {
  config: Config = loadConfig()
  token = subscriptionToken()
  engine = new Engine(() => this.config, defaultProviders(client))
  server: HttpServer | null = null
  serverError = ""
  private listeners = new Set<() => void>()
  private notifyQueued = false

  constructor() {
    this.engine.onChange = () => {
      syncFavorites(this.engine.listChannels())
      this.notify()
    }
  }

  get bilibili(): Bilibili {
    return this.engine.providers.bilibili as Bilibili
  }

  /** 合并保存配置；校验失败抛 ConfigError，原配置不变。 */
  update(patch: any): Config {
    const next = merge(this.config, patch)
    this.config = next
    saveConfig(next)
    this.engine.invalidate()
    this.engine.startRefresh()
    return next
  }

  enabled(platform: Platform) {
    return this.config[platform].enabled
  }

  get running() {
    return this.server?.state === "running"
  }

  /** 本机订阅地址；host 为局域网 IP 时供其他设备使用。 */
  subscriptionUrl(host = "127.0.0.1") {
    return `http://${host}:${this.server?.port ?? readSettings().port}/s/${this.token}/interface.m3u`
  }

  liveUrl(platform: Platform, room: string) {
    return `http://127.0.0.1:${this.server?.port ?? readSettings().port}/s/${this.token}/live/${platform}/${room}`
  }

  lanAddress(): string | null {
    try {
      for (const name of ["en0", "en1", "bridge100"]) {
        const found = (Device.networkInterfaces()[name] ?? []).find(i => i.family === "IPv4" && !i.isInternal)
        if (found) return found.address
      }
    } catch {}
    return null
  }

  resetToken() {
    this.token = subscriptionToken(true)
    this.notify()
  }

  startServer(): boolean {
    this.stopServer()
    const settings = readSettings()
    const server = new HttpServer()
    const base = () => `http://127.0.0.1:${server.port}`
    const text = (code: number, phrase: string, body = "") => HttpResponse.raw(code, phrase, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      body: Data.fromRawString(body, "utf-8") ?? undefined,
    })
    // 令牌比对放在中间件里：路径不对一律 404，不暴露是否存在。
    server.registerMiddleware(async req => {
      const parts = req.path.split("/")
      if (parts[1] !== "s" || parts[2] !== this.token) return text(404, "Not Found")
      if (req.method !== "GET" && req.method !== "HEAD") return text(405, "Method Not Allowed")
      return null
    })
    server.registerAsyncHandler("/s/:token/interface.m3u", async () => {
      let playlist: string
      try {
        playlist = this.engine.playlist(base(), this.token)
      } catch {
        return HttpResponse.raw(503, "Service Unavailable", {
          headers: { "Retry-After": "5", "Content-Type": "text/plain; charset=utf-8" },
          body: Data.fromRawString("Channels updating; retry shortly", "utf-8") ?? undefined,
        })
      }
      return HttpResponse.raw(200, "OK", {
        headers: { "Content-Type": "audio/x-mpegurl; charset=utf-8", "Cache-Control": "no-store" },
        body: Data.fromRawString(playlist, "utf-8") ?? undefined,
      })
    })
    for (const kind of ["live", "hls"] as const) {
      server.registerAsyncHandler(`/s/:token/${kind}/:platform/:room`, async req => {
        const { platform, room } = req.params
        if (!ROOM.test(room ?? "")) return text(404, "Not Found")
        this.engine.maybeRefresh()
        try {
          const stream = await this.engine.resolve(platform as Platform, room, kind === "hls")
          return HttpResponse.raw(302, "Found", { headers: { Location: stream.url, "Cache-Control": "no-store" } })
        } catch (e) {
          return e instanceof LookupError ? text(404, "Not Found") : text(503, "Service Unavailable")
        }
      })
    }
    server.setNotFoundHandler(async () => text(404, "Not Found"))
    if (!settings.allowLan) {
      // 只监听回环地址，局域网其他设备无法访问。
      server.listenAddressIPv4 = "127.0.0.1"
    }
    const error = server.start({ port: settings.port, forceIPv4: !settings.allowLan })
    this.serverError = error ?? ""
    this.server = error ? null : server
    if (!error) this.engine.maybeRefresh()
    this.notify()
    return !error
  }

  stopServer() {
    this.server?.stop()
    this.server = null
    this.notify()
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 合并同一轮事件里的多次通知，避免界面反复重绘。 */
  notify() {
    if (this.notifyQueued) return
    this.notifyQueued = true
    setTimeout(() => {
      this.notifyQueued = false
      for (const listener of this.listeners) listener()
    }, 0)
  }
}

export const backend = new Backend()

/** 后端状态变化时重绘组件。 */
export function useBackend() {
  const [, setTick] = useState(0)
  useEffect(() => backend.subscribe(() => setTick(t => t + 1)), [])
  return backend
}

export { ROOM }
