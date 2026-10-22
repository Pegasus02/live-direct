// 用 Scripting 的 fetch 实现 core/net.ts 需要的 Transport：不跟随重定向，返回小写响应头与 Cookie。
import type { Transport } from "./core/net"

export const scriptingTransport: Transport = async request => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    timeout: request.timeout,
    handleRedirect: async () => null,
  })
  const headers: Record<string, string> = {}
  response.headers.forEach((value: string, key: string) => { headers[key.toLowerCase()] = value })
  const text = request.method === "HEAD" ? "" : await response.text()
  return { status: response.status, headers, cookies: response.cookies.map(c => ({ name: c.name, value: c.value })), text }
}
