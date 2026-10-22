// Check the TypeScript port against cases recorded from the Python backend.
//   npm i --no-save typescript   (once)
//   python3 scripting/tests/gen_cases.py > /tmp/cases.json && node scripting/tests/run.mjs /tmp/cases.json
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const here = path.dirname(fileURLToPath(import.meta.url))
const coreDir = path.join(here, "..", "live-direct", "core")
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ld-core-"))
for (const file of fs.readdirSync(coreDir).filter(f => f.endsWith(".ts"))) {
  const result = ts.transpileModule(fs.readFileSync(path.join(coreDir, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, reportDiagnostics: true, fileName: file,
  })
  if (result.diagnostics.length) throw new Error(file + ": " + result.diagnostics.map(d => d.messageText).join("; "))
  fs.writeFileSync(path.join(out, file.replace(/\.ts$/, ".js")), result.outputText)
}
const load = name => require(path.join(out, name + ".js"))
const util = load("util"), config = load("config")
const douyin = load("douyin"), bilibili = load("bilibili"), douyu = load("douyu"), huya = load("huya")
export const core = { util, config, douyin, bilibili, douyu, huya, engine: load("engine"), net: load("net"), common: load("common") }

/** Same substring-matching fake as tests/test_providers.Fake. */
function fake(responses) {
  const calls = [], forms = []
  const find = (url, headers, form = null) => {
    calls.push(url)
    forms.push(form)
    for (const [key, value] of Object.entries(responses)) if (url.includes(key)) return value
    throw new Error("Unexpected fixture request " + url)
  }
  return {
    calls, forms,
    fetchText: async (url, headers) => find(url, headers),
    fetchJson: async (url, headers, form) => find(url, headers, form ?? null),
    fetchJsonWithCookies: async (url, headers) => ({ cookies: [], json: find(url, headers) }),
  }
}

const channels = cs => cs.map(c => [c.platform, c.room_id, c.name, c.title, c.logo])
const stream = s => [s.url, s.format, s.quality]

const scenarios = {
  douyin: async c => [channels(await new douyin.Douyin(c).discover({ enabled: true, rooms: ["123"], categories: ["游戏"], count: 2, quality: "HD1" })),
    stream(await new douyin.Douyin(c).resolve("123", {}))],
  bilibili: async c => [channels(await new bilibili.Bilibili(c).discover({ enabled: true, rooms: ["12"], areas: ["网游"], min_online: 10, sessdata: "abc%2C1" })),
    stream(await new bilibili.Bilibili(c).resolve("12", { quality: 0 }))],
  douyu: async c => [channels(await new douyu.Douyu(c).discover({ enabled: true, rooms: ["https://www.douyu.com/09999"], categories: ["娱乐"], count: 2, min_viewers: 5 })),
    stream(await new douyu.Douyu(c).resolve("9999", { quality: 0 }))],
  huya: async c => [channels(await new huya.Huya(c).discover({ enabled: true, rooms: ["vanity"], categories: ["网游"], count: 1 })),
    stream(await new huya.Huya(c).resolve("vanity", { quality: 4000 }))],
}

const fns = {
  md5: util.md5, parseHeat: util.parseHeat, clean: util.clean, assignedJson: util.assignedJson,
  mediaUrl: util.mediaUrl, safeMedia: util.safeMedia, safeLogo: util.safeLogo, cleanText: util.cleanText,
  "douyin.normalizeRoom": douyin.normalizeRoom, "bilibili.normalizeRoom": bilibili.normalizeRoom,
  "douyu.normalizeRoom": douyu.normalizeRoom, "huya.normalizeRoom": huya.normalizeRoom,
  "config.normalizeRoom": config.normalizeRoom, "config.shareLinks": config.shareLinks, "config.validate": config.validate,
  "douyu.sign": douyu.sign, "douyu.streamFrom": douyu.streamFrom,
  "huya.parseRoomPage": huya.parseRoomPage, "huya.parseCategoryPage": huya.parseCategoryPage, "huya.selectBitrate": huya.selectBitrate,
  "huya.selectStream": (page, q, start, formats) => huya.selectStream(huya.parseRoomPage(page, "880"), q, start, 1700000000000, formats),
  "douyin.parseRoomPage": douyin.parseRoomPage, "douyin.parseCategoryPage": douyin.parseCategoryPage, "douyin.selectStream": douyin.selectStream,
  "bilibili.selectStream": bilibili.selectStream,
  scenario: async (name, responses) => {
    const client = fake(responses)
    let result
    try {
      result = await scenarios[name](client)
    } catch (e) {
      if (!(e instanceof util.ProviderError)) throw e
      result = { error: e instanceof util.RoomOfflineError ? "RoomOfflineError" : "ProviderError" }
    }
    return { result, calls: client.calls, forms: client.forms }
  },
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  return value
}

if (process.argv[2]) {
  const realNow = Date.now
  Date.now = () => 1700000000000
  const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
  let failed = 0
  for (const c of cases) {
    let actual
    try {
      actual = await fns[c.fn](...structuredClone(c.args))
    } catch (e) {
      if (e instanceof util.RoomOfflineError) actual = { error: "RoomOfflineError" }
      else if (e instanceof util.ProviderError) actual = { error: "ProviderError" }
      else if (e instanceof config.ConfigError) actual = { error: "ConfigError" }
      else actual = { error: "Unexpected " + e.stack }
    }
    if (actual === undefined) actual = null
    const a = JSON.stringify(canonical(actual)), b = JSON.stringify(canonical(c.expect))
    if (a !== b) {
      failed++
      if (failed <= 15) console.log("MISMATCH", c.fn, JSON.stringify(c.args).slice(0, 200), "\n  ts:", a.slice(0, 400), "\n  py:", b.slice(0, 400))
    }
  }
  Date.now = realNow
  console.log(`${cases.length - failed}/${cases.length} cases match`)
  process.exitCode = failed ? 1 : 0
}
