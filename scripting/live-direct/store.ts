import { useEffect, useState } from "scripting"
import type { Channel, Platform } from "./api"

// ---- 关注列表：本地保存，不影响服务端配置 ----

const FAVORITES_KEY = "live-direct.favorites"

/** 保存最后一次见到的名字和头像，下播后仍能显示。 */
export type Favorite = { key: string; platform: Platform; room: string; name: string; logo: string; addedAt: number }

const listeners = new Set<() => void>()

export function readFavorites(): Favorite[] {
  const saved = Storage.get<Favorite[]>(FAVORITES_KEY)
  return Array.isArray(saved) ? saved : []
}

function saveFavorites(favorites: Favorite[]) {
  Storage.set(FAVORITES_KEY, favorites)
  for (const listener of listeners) listener()
}

export function isFavorite(key: string): boolean {
  return readFavorites().some(item => item.key === key)
}

/** 返回切换后的关注状态。 */
export function toggleFavorite(channel: Channel): boolean {
  const favorites = readFavorites()
  if (favorites.some(item => item.key === channel.key)) {
    saveFavorites(favorites.filter(item => item.key !== channel.key))
    return false
  }
  const { key, platform, room, name, logo } = channel
  saveFavorites([...favorites, { key, platform, room, name, logo, addedAt: Date.now() }])
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
  const live = new Map(channels.map(channel => [channel.key, channel]))
  const favorites = readFavorites()
  let changed = false
  const next = favorites.map(item => {
    const channel = live.get(item.key)
    if (!channel || (channel.name === item.name && channel.logo === item.logo)) return item
    changed = true
    return { ...item, name: channel.name || item.name, logo: channel.logo || item.logo }
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

// ---- 播放方式 ----

export type PlayMode = "ask" | "external" | "inapp"
export type ExternalPlayer = "aptv" | "vlc" | "infuse" | "custom"

export type Settings = {
  playMode: PlayMode
  externalPlayer: ExternalPlayer
  /** 自定义 URL Scheme，{url} 替换为编码后的播放地址。 */
  customTemplate: string
  showAll: boolean
}

const SETTINGS_KEY = "live-direct.settings"
const DEFAULT_SETTINGS: Settings = { playMode: "ask", externalPlayer: "aptv", customTemplate: "", showAll: true }

export const EXTERNAL_PLAYERS: Record<ExternalPlayer, { label: string; template: string }> = {
  // APTV 没有公开“播放指定地址”的链接格式：复制地址后用 aptv:// 打开 APTV，
  // 在已添加的订阅里找到同名频道即可；知道可用格式时改用“自定义”。
  aptv: { label: "APTV", template: "aptv://" },
  vlc: { label: "VLC", template: "vlc-x-callback://x-callback-url/stream?url={url}" },
  infuse: { label: "Infuse", template: "infuse://x-callback-url/play?url={url}" },
  custom: { label: "自定义", template: "" },
}

export function readSettings(): Settings {
  const saved = Storage.get<Partial<Settings>>(SETTINGS_KEY)
  return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === "object" ? saved : {}) }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...readSettings(), ...patch }
  Storage.set(SETTINGS_KEY, next)
  return next
}
