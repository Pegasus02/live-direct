// End-to-end check of backend.ts (local HttpServer + engine) in Node, with small
// shims for the Scripting globals it uses. Run: node scripting/tests/backend.test.mjs
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Module, { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "live-direct")
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ld-backend-"))
for (const rel of ["core/util.ts", "core/net.ts", "core/common.ts", "core/config.ts", "core/engine.ts", "core/douyin.ts", "core/bilibili.ts",
  "core/douyu.ts", "core/huya.ts", "backend.ts", "store.ts", "transport.ts"]) {
  const result = ts.transpileModule(fs.readFileSync(path.join(root, rel), "utf8"), {
    fileName: path.basename(rel), compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
  })
  fs.mkdirSync(path.join(out, path.dirname(rel)), { recursive: true })
  fs.writeFileSync(path.join(out, rel.replace(/\.ts$/, ".js")), result.outputText)
}

// ---- Scripting shims ----
const resolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  return request === "scripting" ? "scripting-shim" : resolveFilename.call(this, request, ...rest)
}
require.cache["scripting-shim"] = { id: "scripting-shim", filename: "scripting-shim", loaded: true, exports: { useState: v => [v, () => {}], useEffect: () => {} } }
const store = new Map(), keychain = new Map()
globalThis.Storage = { get: k => store.has(k) ? structuredClone(store.get(k)) : null, set: (k, v) => { store.set(k, structuredClone(v)); return true }, remove: k => store.delete(k) }
globalThis.Keychain = { get: k => keychain.get(k) ?? null, set: (k, v) => { keychain.set(k, v); return true }, remove: k => keychain.delete(k) }
globalThis.Crypto = { generateSymmetricKey: n => ({ toBase64String: () => require("node:crypto").randomBytes(n).toString("base64") }) }
globalThis.Device = { networkInterfaces: () => ({ en0: [{ family: "IPv4", address: "192.168.1.20", isInternal: false }] }) }
globalThis.Data = { fromRawString: s => ({ text: s }) }
const raw = (statusCode, phrase, options = {}) => ({ statusCode, phrase, headers: options.headers ?? {}, body: options.body?.text ?? "" })
globalThis.HttpResponse = { raw }
const servers = []
globalThis.HttpServer = class {
  constructor() { this.middleware = []; this.routes = []; this.state = "stopped"; this.port = null; servers.push(this) }
  registerMiddleware(fn) { this.middleware.push(fn) }
  registerAsyncHandler(pattern, fn) { this.routes.push([pattern, fn]) }
  setNotFoundHandler(fn) { this.notFound = fn }
  start(options) { this.options = options; this.port = options.port; this.state = "running"; return null }
  stop() { this.state = "stopped" }
  async request(method, p, address = "127.0.0.1:50000") {
    const req = { method, path: p, params: {}, address }
    for (const m of this.middleware) { const r = await m(req); if (r) return r }
    for (const [pattern, fn] of this.routes) {
      const a = pattern.split("/"), b = p.split("/")
      if (a.length !== b.length) continue
      const params = {}
      if (a.every((s, i) => s.startsWith(":") ? (params[s.slice(1)] = b[i], true) : s === b[i])) return fn({ ...req, params })
    }
    return this.notFound(req)
  }
}

// Upstream fixtures (Huya room page with FLV + HLS lines, Douyu room/play APIs).
const fm = Buffer.from("prefix_$0_$1_$2_$3").toString("base64")
const line = { sStreamName: "1-2-abc", sFlvUrl: "http://al.flv.huya.com/src", sFlvUrlSuffix: "flv", sFlvAntiCode: `wsTime=65f0a1b2&fm=${fm}&ctype=huya_live`,
  sHlsUrl: "http://al.hls.huya.com/src", sHlsUrlSuffix: "m3u8", sHlsAntiCode: `wsTime=65f0a1b2&fm=${fm}` }
const huyaPage = "<script>var hyPlayerConfig = {stream: " + JSON.stringify({ data: [{ gameLiveInfo: { profileRoom: 880, uid: 1, nick: "虎牙主播" }, gameStreamInfoList: [line] }], vMultiStreamInfo: [] }) + "};</script>"
const upstream = {
  "https://www.huya.com/880": huyaPage,
  "https://www.douyu.com/betard/1": JSON.stringify({ room: { room_id: 1, show_status: 1, nickname: "斗鱼主播" } }),
  "https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption?did=10000000000000000000000000001501": JSON.stringify({ error: 0, data: { rand_str: "r", key: "k", enc_time: 1, enc_data: "e" } }),
  "https://playweb.douyucdn.cn/lapi/live/getH5PlayV1/1": JSON.stringify({ error: 0, data: { rtmp_url: "https://hw-tct.douyucdn.cn/live", rtmp_live: "1r.flv?x=1" } }),
}
const requested = []
globalThis.fetch = async (url, init) => {
  requested.push([init.method, url])
  assert.equal(typeof init.handleRedirect, "function", "transport must not follow redirects")
  const body = upstream[url]
  return { status: body === undefined ? 404 : 200, cookies: [], headers: { forEach() {} }, text: async () => body ?? "" }
}

// ---- Tests ----
const { backend } = require(path.join(out, "backend.js"))
const { channelKey } = require(path.join(out, "store.js"))
assert.match(backend.token, /^[A-Za-z0-9_-]{32,}$/)
assert.equal(backend.startServer(), true)
const server = servers.at(-1)
assert.deepEqual(server.options, { port: 19070, forceIPv4: true })
assert.equal(server.listenAddressIPv4, "127.0.0.1")
const base = `/s/${backend.token}`

// No platform enabled yet: empty playlist, unknown channels 404.
assert.equal((await server.request("GET", base + "/interface.m3u")).statusCode, 200)
assert.equal((await server.request("GET", base + "/live/huya/880")).statusCode, 404)

backend.update({ huya: { enabled: true, rooms: ["https://www.huya.com/880"] }, douyu: { enabled: true, rooms: ["0001"] } })
assert.deepEqual(backend.config.huya.rooms, ["880"])
assert.deepEqual(backend.config.douyu.rooms, ["1"])
assert.equal(Storage.get("live-direct.config").bilibili.sessdata, undefined, "SESSDATA must not be stored in Storage")
await backend.engine.waitForRefresh()

const m3u = await server.request("GET", base + "/interface.m3u")
assert.equal(m3u.statusCode, 200)
assert.equal(m3u.headers["Content-Type"], "audio/x-mpegurl; charset=utf-8")
assert.match(m3u.body, /group-title="虎牙",虎牙主播\nhttp:\/\/127\.0\.0\.1:19070\/s\/[^/]+\/live\/huya\/880\n/)
assert.match(m3u.body, /group-title="斗鱼",斗鱼主播\nhttp:\/\/127\.0\.0\.1:19070\/s\/[^/]+\/live\/douyu\/1\n/)

let r = await server.request("GET", base + "/live/huya/880")
assert.equal(r.statusCode, 302)
assert.match(r.headers.Location, /^https:\/\/al\.flv\.huya\.com\/src\/1-2-abc\.flv\?wsSecret=/)
r = await server.request("GET", base + "/hls/huya/880")
assert.equal(r.statusCode, 302)
assert.match(r.headers.Location, /^https:\/\/al\.hls\.huya\.com\/src\/1-2-abc\.m3u8\?/)
r = await server.request("GET", base + "/live/douyu/1")
assert.equal(r.statusCode, 302)
assert.equal(r.headers.Location, "https://hw-tct.douyucdn.cn/live/1r.flv?x=1")
assert.equal((await server.request("GET", base + "/hls/douyu/1")).statusCode, 404, "Douyu has no HLS")
assert.equal((await server.request("GET", base + "/live/huya/999")).statusCode, 404, "unknown channel")
assert.equal((await server.request("GET", "/s/wrong-token/live/huya/880")).statusCode, 404, "token gate")
assert.equal((await server.request("POST", base + "/live/huya/880")).statusCode, 405)
assert.equal((await server.request("GET", "/admin")).statusCode, 404)
// listenAddressIPv4 is ignored by the app, so LAN peers are refused by address.
assert.equal((await server.request("GET", base + "/interface.m3u", "::1:50001")).statusCode, 200)
assert.equal((await server.request("GET", base + "/interface.m3u", "192.168.1.30:50002")).statusCode, 403)
assert.equal((await server.request("GET", base + "/interface.m3u", null)).statusCode, 403)
assert.ok(requested.every(([, url]) => url.startsWith("https://www.huya.com/") || url.startsWith("https://www.douyu.com/") || url.startsWith("https://playweb.douyucdn.cn/")))

// Disabling a platform revokes its channels immediately.
backend.update({ huya: { enabled: false } })
assert.equal((await server.request("GET", base + "/live/huya/880")).statusCode, 404)
assert.equal(channelKey({ platform: "huya", room_id: "880" }), "huya-880")

// Invalid input is rejected and leaves config unchanged.
assert.throws(() => backend.update({ douyu: { rooms: ["https://evil.test/1"] } }), /rooms/)
assert.deepEqual(backend.config.douyu.rooms, ["1"])
assert.throws(() => backend.update({ bilibili: { sessdata: "a;b" } }), /sessdata/)
backend.update({ bilibili: { sessdata: "abc%2C1" } })
assert.equal(Keychain.get("live-direct.sessdata"), "abc%2C1")
backend.update({ bilibili: { clear_sessdata: true } })
assert.equal(Keychain.get("live-direct.sessdata"), null)

// LAN mode listens on all interfaces; token reset invalidates the old URL.
Storage.set("live-direct.settings", { allowLan: true })
backend.startServer()
assert.deepEqual(servers.at(-1).options, { port: 19070, forceIPv4: false })
assert.equal(backend.subscriptionUrl(backend.lanAddress()).startsWith("http://192.168.1.20:19070/s/"), true)
assert.notEqual((await servers.at(-1).request("GET", `/s/${backend.token}/interface.m3u`, "192.168.1.30:50003")).statusCode, 403, "LAN peers allowed")
const old = backend.token
backend.resetToken()
assert.notEqual(backend.token, old)
assert.equal((await servers.at(-1).request("GET", `/s/${old}/interface.m3u`)).statusCode, 404)
backend.stopServer()
console.log("backend: all checks passed")
process.exit(0)
