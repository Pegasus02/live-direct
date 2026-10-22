import { Button, HStack, Image, List, Navigation, ProgressView, Section, Spacer, Text, useEffect, useState, VStack } from "scripting"
import { fetchConfig, fetchStatus, LABELS, type Platform, PLATFORMS, readAdminToken, requestRefresh, type ServerConfig, type ServerStatus, updateConfig } from "./api"

const STATUS_TEXT: Record<string, [string, string]> = {
  ok: ["正常", "systemGreen"],
  error: ["刷新失败", "systemRed"],
  disabled: ["未启用", "secondaryLabel"],
}

const ADD_HINT: Record<Platform, string> = {
  douyin: "粘贴抖音 App 的分享链接（v.douyin.com/…，可带整段分享文案），或网页房间号。",
  bilibili: "B站房间号，或 live.bilibili.com/房间号 链接。",
  douyu: "斗鱼数字房间号，或 www.douyu.com/房间号 链接。",
  huya: "虎牙房间号，或 www.huya.com/房间号 链接。",
}

/** 服务端“手动房间”就是要长期关注的主播：开播后出现在订阅里。 */
function entries(config: ServerConfig, platform: Platform): { field: "rooms" | "share_links"; value: string }[] {
  const item = config[platform]
  return [
    ...(item.share_links ?? []).map(value => ({ field: "share_links" as const, value })),
    ...item.rooms.map(value => ({ field: "rooms" as const, value })),
  ]
}

export function ServerPage({ onChanged }: { onChanged: () => void }) {
  const dismiss = Navigation.useDismiss()
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function load() {
    setBusy(true)
    try {
      // 先登录一次，避免两个请求同时登录。
      const nextStatus = await fetchStatus()
      setStatus(nextStatus)
      setConfig(await fetchConfig())
      setError("")
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(readAdminToken() ? message : `${message}\n在设置中填写管理员令牌后，可以在这里添加/删除主播、刷新频道。`)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void load() }, [])

  async function save(platform: Platform, patch: Partial<ServerConfig[Platform]>) {
    setBusy(true)
    try {
      setConfig(await updateConfig({ [platform]: patch }))
      onChanged()
      // 保存后服务端会在后台重新发现频道。
      setTimeout(() => { void load() }, 2000)
    } catch (e) {
      await Dialog.alert({ title: "保存失败", message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  async function addRoom(platform: Platform) {
    if (!config) return
    const input = (await Dialog.prompt({ title: `添加${LABELS[platform]}主播`, message: ADD_HINT[platform], placeholder: "房间号或链接", confirmLabel: "添加" }))?.trim()
    if (!input) return
    const item = config[platform]
    // 服务端负责校验与规范化；抖音分享链接单独存放。
    const share = platform === "douyin" && /v\.douyin\.com\//.test(input)
    const patch = share
      ? { share_links: [...(item.share_links ?? []), input] }
      : { rooms: [...item.rooms, input] }
    await save(platform, item.enabled ? patch : { ...patch, enabled: await askEnable(platform) })
  }

  async function askEnable(platform: Platform): Promise<boolean> {
    return Dialog.confirm({ title: `${LABELS[platform]}未启用`, message: "是否同时启用该平台？未启用时不会出现在订阅里。", confirmLabel: "启用", cancelLabel: "暂不" })
  }

  async function remove(platform: Platform, field: "rooms" | "share_links", value: string) {
    if (!config) return
    const list = (config[platform][field] ?? []).filter(item => item !== value)
    await save(platform, { [field]: list })
  }

  async function refresh() {
    try {
      const { accepted } = await requestRefresh()
      await Dialog.alert({ title: accepted ? "已开始刷新" : "正在刷新中", message: "频道发现在后台进行，稍后下拉主页即可看到新列表。" })
      onChanged()
    } catch (e) {
      await Dialog.alert({ title: "刷新失败", message: e instanceof Error ? e.message : String(e) })
    }
  }

  return <List
    navigationTitle="服务器"
    navigationBarTitleDisplayMode="inline"
    refreshable={load}
    toolbar={{
      cancellationAction: <Button title="关闭" action={dismiss} />,
      topBarTrailing: busy ? <ProgressView /> : <Button title="刷新频道" systemImage="arrow.triangle.2.circlepath" action={() => { void refresh() }} />,
    }}
  >
    {error ? <Section><Text foregroundStyle="systemRed">{error}</Text></Section> : null}
    {status ? <Section header={<Text>状态</Text>} footer={<Text>{`订阅共 ${status.channel_count} 个频道${status.refreshing ? "，正在刷新…" : ""}`}</Text>}>
      {PLATFORMS.map(platform => {
        const health = status.platforms[platform]
        const [label, color] = STATUS_TEXT[health?.status ?? "disabled"] ?? [health?.status ?? "", "secondaryLabel"]
        return <VStack key={platform} alignment="leading" spacing={4}>
          <HStack>
            <Text font="headline">{LABELS[platform]}</Text>
            <Spacer />
            <Text foregroundStyle={color}>{label}</Text>
            {health?.enabled ? <Text foregroundStyle="secondaryLabel">{` · ${health.count} 个`}</Text> : null}
          </HStack>
          {health?.message ? <Text font="caption" foregroundStyle="secondaryLabel">{health.message}</Text> : null}
          {(health?.warnings ?? []).slice(0, 3).map(warning => <Text key={warning} font="caption" foregroundStyle="systemOrange">{warning}</Text>)}
        </VStack>
      })}
    </Section> : null}
    {config ? PLATFORMS.map(platform => {
      const rows = entries(config, platform)
      return <Section key={platform} header={<Text>{`${LABELS[platform]}关注的主播${config[platform].enabled ? "" : "（平台未启用）"}`}</Text>}>
        {rows.map(row => <HStack
          key={row.field + row.value}
          trailingSwipeActions={{ actions: [<Button title="删除" systemImage="trash" role="destructive" action={() => { void remove(platform, row.field, row.value) }} />] }}
        >
          <Image systemName={row.field === "share_links" ? "link" : "person.crop.circle"} foregroundStyle="secondaryLabel" />
          <Text lineLimit={1}>{row.value}</Text>
        </HStack>)}
        <Button title={`添加${LABELS[platform]}主播`} systemImage="plus" action={() => { void addRoom(platform) }} />
      </Section>
    }) : null}
  </List>
}
