// 把 core 的英文错误与警告翻译成界面中文；未知内容原样显示。
import { ConfigError } from "./core/config"
import { ProviderError, RoomOfflineError } from "./core/util"

const TEXT: Record<string, string> = {
  "Discovery time budget reached; remaining requests deferred": "发现超时（45 秒），剩余请求留到下次刷新",
  "Discovery time budget reached": "发现超时（45 秒），剩余请求留到下次刷新",
  "A Douyin share link could not be fetched": "有抖音分享链接解析失败（链接可能已失效）",
  "A manual Douyin room could not be fetched": "有抖音手动房间查询失败（可能被验证码拦截）",
  "A Douyin category could not be fetched": "有抖音分类抓取失败",
  "A Douyin room has no trusted stream": "有抖音房间没有可信的播放地址",
  "A Bilibili room could not be fetched": "有 B站房间查询失败",
  "A Bilibili area could not be fetched": "有 B站分区抓取失败",
  "A manual Douyu room could not be fetched": "有斗鱼手动房间查询失败",
  "A Douyu category could not be fetched": "有斗鱼分类抓取失败",
  "A manual Huya room could not be fetched": "有虎牙手动房间查询失败",
  "A Huya category could not be fetched": "有虎牙分类抓取失败",
  "Bilibili API risk control; anonymous access unavailable": "B站风控拦截了匿名请求，可登录后重试",
  "Douyin room request requires verification": "抖音网页要求验证码，请改用分享链接添加",
  "Invalid Douyin category": "抖音分类无效",
  "Invalid Douyu category": "斗鱼分类无效",
  "Invalid Huya category": "虎牙分类无效",
  "Unknown Bilibili parent area": "B站分区名称无效",
  "Upstream request failed": "网络请求失败",
  "Upstream HTTP request failed": "平台接口返回错误",
  "Untrusted media URL": "平台返回了不可信的播放地址",
  "Failed to extract valid SESSDATA from login response": "登录成功但没有拿到 SESSDATA",
}

export function translate(message: string): string {
  if (TEXT[message]) return TEXT[message]
  if (/discovery failed$/.test(message)) return "频道发现全部失败"
  if (/has no trusted playable stream$/.test(message)) return "该房间没有可信的播放地址"
  return message
}

export function describeError(error: unknown): string {
  if (error instanceof RoomOfflineError) return "主播未开播"
  if (error instanceof ConfigError) {
    const field = error.message.split(":")[0]
    if (/rooms$/.test(field)) return "房间号或链接无效：请填房间号或官方房间链接"
    if (/share_links$/.test(field)) return "分享链接无效：每条只能包含一个 https://v.douyin.com/… 短链"
    if (/categories$|areas$/.test(field)) return "分类名称无效"
    if (/sessdata$/.test(field)) return "SESSDATA 格式不对（只填 Cookie 的值，不含分号）"
    return "配置无效：" + error.message
  }
  if (error instanceof ProviderError) return translate(error.message)
  return error instanceof Error ? error.message : String(error)
}
