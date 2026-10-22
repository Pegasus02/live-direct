// 本机持久化：配置存 Storage（不含 SESSDATA），SESSDATA 与订阅令牌存钥匙串。
import { useEffect, useState } from "scripting"
import type { Channel, Platform } from "./core/common"
import { type Config, withDefaults } from "./core/config"

const CONFIG_KEY = "live-direct.config"
const SESSDATA_KEY = "live-direct.sessdata"
const TOKEN_KEY = "live-direct.token"

export function loadConfig(): Config {
  const saved = Storage.get<any>(CONFIG_KEY)
  const config = withDefaults(saved)
  config.bilibili.sessdata = Keychain.get(SESSDATA_KEY) ?? ""
  return withDefaults(config)
}

export function saveConfig(config: Config) {
  const { sessdata, ...bilibili } = config.bilibili
  Storage.set(CONFIG_KEY, { ...config, bilibili })
  if (sessdata) Keychain.set(SESSDATA_KEY, sessdata, { synchronizable: false })
  else Keychain.remove(SESSDATA_KEY)
}

function randomToken(): string {
  try {
    return Crypto.generateSymmetricKey(32).toBase64String().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  } catch {
    return Array.from({ length: 43 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[Math.floor(Math.random() * 64)]).join("")
  }
}

/** 订阅令牌：首次运行生成，可在设置里重置（重置后需在播放器里重新添加订阅）。 */
export function subscriptionToken(reset = false): string {
  let token = reset ? "" : Keychain.get(TOKEN_KEY) ?? ""
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    token = randomToken()
    Keychain.set(TOKEN_KEY, token, { synchronizable: false })
  }
  return token
}

// ---- 应用设置 ----

export type PlayMode = "ask" | "external" | "inapp"
export type ExternalPlayer = "aptv" | "vlc" | "infuse" | "custom"

export type Settings = {
  port: number
  /** 允许局域网设备（如 Apple TV 上的 APTV）访问本机订阅。 */
  allowLan: boolean
  /** 启动脚本时自动开启本机服务。 */
  autoStart: boolean
  /** 进入后台时申请保活，让 APTV 等播放器能继续取地址。 */
  keepAlive: boolean
  playMode: PlayMode
  externalPlayer: ExternalPlayer
  customTemplate: string
}

const SETTINGS_KEY = "live-direct.settings"
export const DEFAULT_SETTINGS: Settings = {
  port: 19070, allowLan: false, autoStart: true, keepAlive: true, playMode: "ask", externalPlayer: "aptv", customTemplate: "",
}

export const EXTERNAL_PLAYERS: Record<ExternalPlayer, { label: string; template: string }> = {
  // APTV 没有公开“播放指定地址”的链接格式：复制地址后用 aptv:// 打开 APTV，
  // 在已添加的本机订阅里点同名频道即可；知道可用格式时改用“自定义”。
  aptv: { label: "APTV", template: "aptv://" },
  vlc: { label: "VLC", template: "vlc-x-callback://x-callback-url/stream?url={url}" },
  infuse: { label: "Infuse", template: "infuse://x-callback-url/play?url={url}" },
  custom: { label: "自定义", template: "" },
}

export function readSettings(): Settings {
  const saved = Storage.get<Partial<Settings>>(SETTINGS_KEY)
  const merged = { ...DEFAULT_SETTINGS, ...(saved && typeof saved === "object" ? saved : {}) }
  if (!Number.isInteger(merged.port) || merged.port < 1024 || merged.port > 65535) merged.port = DEFAULT_SETTINGS.port
  return merged
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...readSettings(), ...patch }
  Storage.set(SETTINGS_KEY, next)
  return next
}

// ---- 关注列表：只存本机 ----

const FAVORITES_KEY = "live-direct.favorites"

/** 保存最后一次见到的名字和头像，下播后仍能显示。 */
export type Favorite = { key: string; platform: Platform; room: string; name: string; logo: string; addedAt: number }

const listeners = new Set<() => void>()
export const channelKey = (c: { platform: string; room_id: string }) => `${c.platform}-${c.room_id}`

export function readFavorites(): Favorite[] {
  const saved = Storage.get<Favorite[]>(FAVORITES_KEY)
  return Array.isArray(saved) ? saved : []
}

function saveFavorites(favorites: Favorite[]) {
  Storage.set(FAVORITES_KEY, favorites)
  for (const listener of listeners) listener()
}

/** 返回切换后的关注状态。 */
export function toggleFavorite(channel: Channel): boolean {
  const key = channelKey(channel)
  const favorites = readFavorites()
  if (favorites.some(item => item.key === key)) {
    saveFavorites(favorites.filter(item => item.key !== key))
    return false
  }
  saveFavorites([...favorites, { key, platform: channel.platform, room: channel.room_id, name: channel.name, logo: channel.logo, addedAt: Date.now() }])
  return true
}

export function removeFavorite(key: string) {
  saveFavorites(readFavorites().filter(item => item.key !== key))
}

export function moveFavorite(key: string, offset: number) {
  const favorites = readFavorites()
  const index = favorites.findIndex(item => item.key === key)
  const target = index + offset
  if (index < 0 || target < 0 || target >= favorites.length) return
  const [item] = favorites.splice(index, 1)
  favorites.splice(target, 0, item)
  saveFavorites(favorites)
}

/** 刷新频道时顺手更新关注主播的名字与头像。 */
export function syncFavorites(channels: Channel[]) {
  const live = new Map(channels.map(c => [channelKey(c), c]))
  let changed = false
  const next = readFavorites().map(item => {
    const c = live.get(item.key)
    if (!c || (c.name === item.name && c.logo === item.logo)) return item
    changed = true
    return { ...item, name: c.name || item.name, logo: c.logo || item.logo }
  })
  if (changed) saveFavorites(next)
}

export function useFavorites(): Favorite[] {
  const [favorites, setFavorites] = useState(readFavorites)
  useEffect(() => {
    const listener = () => setFavorites(readFavorites())
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  return favorites
}
