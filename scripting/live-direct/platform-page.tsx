import { Button, HStack, Image, LabeledContent, List, Navigation, NavigationStack, Picker, ProgressView, Section, Text, Toggle, useEffect, useState, VStack } from "scripting"
import { backend, useBackend } from "./backend"
import * as bilibili from "./core/bilibili"
import { LABELS, type Platform } from "./core/common"
import * as douyin from "./core/douyin"
import * as douyu from "./core/douyu"
import * as huya from "./core/huya"
import { describeError } from "./messages"

// 每个平台在表单里的差异：分类表、数量/门槛字段名、画质选项。
const META: Record<Platform, {
  categories: Record<string, string>; categoryField: "categories" | "areas"; countField: "count" | "top_per_area"
  minField: "min_viewers" | "min_online"; maxCount: number; qualities: [string | number, string][]; roomHint: string
}> = {
  douyin: {
    categories: douyin.CATEGORIES, categoryField: "categories", countField: "count", minField: "min_viewers", maxCount: 100,
    qualities: [["FULL_HD1", "蓝光"], ["HD1", "超清"], ["SD2", "高清"], ["SD1", "标清"]],
    roomHint: "每行一个：抖音 App 的分享链接或整段分享文案（推荐），也可填网页房间号 / live.douyin.com 链接。",
  },
  bilibili: {
    categories: bilibili.AREAS, categoryField: "areas", countField: "top_per_area", minField: "min_online", maxCount: 50,
    qualities: Object.entries(bilibili.QUALITIES).map(([k, v]) => [Number(k), v] as [number, string]).sort((a, b) => a[0] === 0 ? -1 : b[0] === 0 ? 1 : b[0] - a[0]),
    roomHint: "每行一个 B站房间号，或 live.bilibili.com/房间号 链接。",
  },
  douyu: {
    categories: douyu.CATEGORIES, categoryField: "categories", countField: "count", minField: "min_viewers", maxCount: 100,
    qualities: Object.entries(douyu.QUALITIES).map(([k, v]) => [Number(k), v] as [number, string]).sort((a, b) => a[0] === 0 ? -1 : b[0] === 0 ? 1 : b[0] - a[0]),
    roomHint: "每行一个斗鱼数字房间号，或 www.douyu.com/房间号 链接。",
  },
  huya: {
    categories: huya.CATEGORIES, categoryField: "categories", countField: "count", minField: "min_viewers", maxCount: 100,
    qualities: Object.entries(huya.QUALITIES).map(([k, v]) => [Number(k), v] as [number, string]).sort((a, b) => a[0] === 0 ? -1 : b[0] === 0 ? 1 : b[0] - a[0]),
    roomHint: "每行一个虎牙房间号，或 www.huya.com/房间号 链接。",
  },
}

async function save(patch: any): Promise<boolean> {
  try {
    backend.update(patch)
    return true
  } catch (e) {
    await Dialog.alert({ title: "保存失败", message: describeError(e) })
    return false
  }
}

async function promptNumber(title: string, current: number, max: number): Promise<number | null> {
  const input = await Dialog.prompt({ title, message: `0 – ${max}`, defaultValue: String(current), keyboardType: "numberPad", confirmLabel: "保存" })
  if (input == null) return null
  const value = Number(input.trim())
  if (!Number.isInteger(value) || value < 0 || value > max) {
    await Dialog.alert({ title: "数值无效", message: `请输入 0 到 ${max} 之间的整数` })
    return null
  }
  return value
}

export function PlatformPage({ platform }: { platform: Platform }) {
  const b = useBackend()
  const meta = META[platform]
  const cfg = b.config[platform] as any
  const channels = b.engine.listChannels().filter(c => c.platform === platform)
  const health = b.engine.status().platforms[platform]
  const selected: string[] = cfg[meta.categoryField] ?? []
  const customAreas = platform === "bilibili" ? selected.filter(a => !(a in meta.categories) && !Object.values(meta.categories).includes(a)) : []
  const isSelected = (id: string) => selected.includes(id) || selected.includes(meta.categories[id])

  async function addRooms() {
    const input = await Dialog.prompt({ title: `添加${LABELS[platform]}主播`, message: meta.roomHint, placeholder: "房间号或链接", confirmLabel: "添加" })
    const lines = (input ?? "").split(/\n+/).map(l => l.trim()).filter(Boolean)
    if (!lines.length) return
    if (platform === "douyin") {
      const shares = lines.filter(l => /v\.douyin\.com\//.test(l))
      const rooms = lines.filter(l => !/v\.douyin\.com\//.test(l))
      await save({ douyin: { share_links: [...cfg.share_links, ...shares], rooms: [...cfg.rooms, ...rooms] } })
    } else {
      await save({ [platform]: { rooms: [...cfg.rooms, ...lines] } })
    }
  }

  function toggleCategory(id: string) {
    const name = meta.categories[id]
    const next = isSelected(id) ? selected.filter(v => v !== id && v !== name) : [...selected, id]
    if (next.length > (platform === "bilibili" ? 16 : 8)) {
      void Dialog.alert({ title: "分类过多", message: `最多选择 ${platform === "bilibili" ? 16 : 8} 个` })
      return
    }
    void save({ [platform]: { [meta.categoryField]: next } })
  }

  return <List navigationTitle={LABELS[platform]} navigationBarTitleDisplayMode="inline">
    <Section footer={<Text>{health?.status === "error" ? health.message ?? "" : `当前 ${channels.length} 个频道在订阅中`}</Text>}>
      <Toggle title={`启用${LABELS[platform]}`} value={cfg.enabled} onChanged={enabled => { void save({ [platform]: { enabled } }) }} />
    </Section>

    {platform === "douyin"
      ? <Section header={<Text>手机分享链接</Text>} footer={<Text>在抖音 App 直播间点“分享 → 复制链接”，整段粘贴即可。分享链接本身也可能失效，主播重新开播后若失败请更新链接。</Text>}>
        {cfg.share_links.map((link: string) => <Text key={link} lineLimit={1}
          trailingSwipeActions={{ actions: [<Button title="删除" systemImage="trash" role="destructive" action={() => { void save({ douyin: { share_links: cfg.share_links.filter((l: string) => l !== link) } }) }} />] }}
        >{link}</Text>)}
        <Button title="添加主播" systemImage="plus" action={() => { void addRooms() }} />
      </Section>
      : null}

    <Section header={<Text>{platform === "douyin" ? "网页房间号（兼容）" : "关注的主播（手动房间）"}</Text>}
      footer={<Text>{platform === "douyin" ? "没有分享链接且网页被验证码拦截时会查询失败，不代表未开播。" : "手动房间排在订阅最前；未开播的房间不会出现在订阅里。左滑删除。"}</Text>}>
      {cfg.rooms.map((room: string) => <HStack key={room}
        trailingSwipeActions={{ actions: [<Button title="删除" systemImage="trash" role="destructive" action={() => { void save({ [platform]: { rooms: cfg.rooms.filter((r: string) => r !== room) } }) }} />] }}
      >
        <Image systemName="person.crop.circle" foregroundStyle="secondaryLabel" />
        <Text>{room}</Text>
        {channels.some(c => c.room_id === room) ? <Text foregroundStyle="systemGreen" font="caption">直播中</Text> : null}
      </HStack>)}
      {platform !== "douyin" ? <Button title="添加主播" systemImage="plus" action={() => { void addRooms() }} /> : null}
    </Section>

    <Section header={<Text>{platform === "bilibili" ? "分区热门" : "分类热门"}</Text>}
      footer={<Text>分类来自平台公开页面，不是账号的关注或推荐。多个分类之间按热度轮流挑选。</Text>}>
      {Object.entries(meta.categories).map(([id, name]) => <Toggle key={id} title={name} value={isSelected(id)} onChanged={() => toggleCategory(id)} />)}
      {customAreas.map(area => <HStack key={area}
        trailingSwipeActions={{ actions: [<Button title="删除" role="destructive" action={() => { void save({ bilibili: { areas: selected.filter(a => a !== area) } }) }} />] }}
      ><Text>{area}</Text></HStack>)}
      {platform === "bilibili" ? <Button title="添加其他分区（名称或 ID）" systemImage="plus" action={async () => {
        const input = (await Dialog.prompt({ title: "B站父分区", message: "填分区名称（如“知识”）或数字 ID", confirmLabel: "添加" }))?.trim()
        if (input) await save({ bilibili: { areas: [...selected, input] } })
      }} /> : null}
      <Button action={async () => {
        const value = await promptNumber(platform === "bilibili" ? "每个分区取多少个" : "分类频道总数", cfg[meta.countField], meta.maxCount)
        if (value != null) await save({ [platform]: { [meta.countField]: value } })
      }}>
        <LabeledContent title={platform === "bilibili" ? "每个分区数量" : "分类频道数量"} value={String(cfg[meta.countField])} />
      </Button>
      <Button action={async () => {
        const value = await promptNumber("最低人气（低于此值不收录）", cfg[meta.minField], 1_000_000_000)
        if (value != null) await save({ [platform]: { [meta.minField]: value } })
      }}>
        <LabeledContent title="最低人气" value={String(cfg[meta.minField])} />
      </Button>
    </Section>

    <Section header={<Text>画质</Text>} footer={<Text>{{
      douyin: "优先 FLV，没有 FLV 时用 HLS；房间没有所选画质时自动降一档。",
      bilibili: "“最高”取接口宣称的最高档。未登录时 B站可能限制画质。",
      douyu: "未登录时斗鱼可能把原画降为超清，实际档位以返回的流为准。",
      huya: "2K/4K 只有部分房间提供，没有时回到原画。",
    }[platform]}</Text>}>
      <Picker title="画质" value={cfg.quality} pickerStyle="menu" onChanged={(value: any) => { void save({ [platform]: { quality: value } }) }}>
        {meta.qualities.map(([value, label]) => <Text key={String(value)} tag={value}>{label}</Text>)}
      </Picker>
      {platform === "bilibili"
        ? <Toggle title="优先 H.264（兼容性更好）" value={cfg.prefer_avc} onChanged={value => { void save({ bilibili: { prefer_avc: value } }) }} />
        : null}
    </Section>

    {platform === "bilibili" ? <BilibiliLogin /> : null}

    <Section header={<Text>{`频道预览 · ${channels.length}`}</Text>}>
      {channels.length ? channels.map(c => <VStack key={c.room_id} alignment="leading" spacing={2}>
        <Text lineLimit={1}>{c.name}</Text>
        <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{`${c.room_id}${c.title ? " · " + c.title : ""}`}</Text>
      </VStack>) : <Text foregroundStyle="secondaryLabel">{b.engine.isRefreshing ? "正在刷新…" : "暂无在播频道"}</Text>}
    </Section>
  </List>
}

function BilibiliLogin() {
  const b = useBackend()
  const configured = !!b.config.bilibili.sessdata
  return <Section header={<Text>B站登录（可选）</Text>}
    footer={<Text>登录只用于获取账号本来有权限的更高画质，不绕过会员/付费限制。SESSDATA 只存本机钥匙串，只发给 B站接口。“已保存”不代表已验证有效。</Text>}>
    <LabeledContent title="SESSDATA" value={configured ? "已保存" : "未设置"} />
    <Button title="扫码登录" systemImage="qrcode" action={() => { void Navigation.present({ element: <NavigationStack><QrLoginPage /></NavigationStack> }) }} />
    <Button title="手动填写 SESSDATA" systemImage="key" action={async () => {
      const input = (await Dialog.prompt({ title: "SESSDATA", message: "只填 Cookie 中 SESSDATA 的值", obscureText: true, confirmLabel: "保存" }))?.trim()
      if (input) await save({ bilibili: { sessdata: input } })
    }} />
    {configured ? <Button title="清除登录" role="destructive" action={() => { void save({ bilibili: { clear_sessdata: true } }) }} /> : null}
  </Section>
}

/** 生成二维码后每 2 秒轮询一次，最多 3 分钟。 */
function QrLoginPage() {
  const dismiss = Navigation.useDismiss()
  const [image, setImage] = useState<UIImage | null>(null)
  const [url, setUrl] = useState("")
  const [message, setMessage] = useState("正在生成二维码…")
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let stopped = false
    ;(async () => {
      try {
        const qr = await backend.bilibili.qrcodeGenerate()
        if (stopped) return
        setUrl(qr.url)
        setImage(await QRCode.generate(qr.url))
        setMessage("请用另一台设备上的 B站 App 扫码，或点下方按钮在本机 B站 App 中打开确认。")
        for (let i = 0; i < 90 && !stopped; i++) {
          await new Promise<void>(resolve => setTimeout(() => resolve(), 2000))
          if (stopped) return
          const poll = await backend.bilibili.qrcodePoll(qr.qrcode_key)
          if (poll.status === "success" && poll.sessdata) {
            await save({ bilibili: { sessdata: poll.sessdata } })
            await Dialog.alert({ title: "登录成功", message: "已保存 SESSDATA 并开始刷新频道。" })
            dismiss()
            return
          }
          setMessage(poll.message)
          if (poll.status === "expired" || poll.status === "error") return
        }
        if (!stopped) setMessage("二维码已过期，请重新生成。")
      } catch (e) {
        if (!stopped) setMessage(describeError(e))
      }
    })()
    return () => { stopped = true }
  }, [attempt])

  return <List navigationTitle="B站扫码登录" navigationBarTitleDisplayMode="inline" toolbar={{ cancellationAction: <Button title="关闭" action={dismiss} /> }}>
    <Section footer={<Text>{message}</Text>}>
      <HStack frame={{ maxWidth: "infinity" }}>
        {image ? <Image image={image} resizable interpolation="none" frame={{ width: 220, height: 220 }} /> : <ProgressView />}
      </HStack>
    </Section>
    <Section>
      {url ? <Button title="在 B站 App 中打开" systemImage="arrow.up.forward.app" action={() => { void Safari.openURL(url) }} /> : null}
      <Button title="重新生成" systemImage="arrow.clockwise" action={() => { setImage(null); setUrl(""); setAttempt(attempt + 1) }} />
    </Section>
  </List>
}
