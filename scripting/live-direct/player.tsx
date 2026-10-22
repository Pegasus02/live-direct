import { AVPlayerView, Button, HStack, Navigation, NavigationStack, ProgressView, Spacer, Text, Toolbar, ToolbarItem, useEffect, useMemo, useObservable, useState, VStack } from "scripting"
import { type Channel, HLS_PLATFORMS, LABELS, resolveStream } from "./api"
import { EXTERNAL_PLAYERS, readSettings } from "./store"

// ---- 外部播放器 ----

export async function openExternal(channel: Channel) {
  const settings = readSettings()
  const template = settings.externalPlayer === "custom" ? settings.customTemplate.trim() : EXTERNAL_PLAYERS[settings.externalPlayer].template
  if (!template) {
    await Dialog.alert({ title: "未设置外部播放器", message: "请在设置里填写自定义 URL Scheme，例如 xxx://play?url={url}" })
    return
  }
  // 交给外部播放器的是服务端固定地址，每次打开都由服务端重新解析并 302 到 CDN。
  await Pasteboard.setString(channel.url)
  const target = template.replace("{url}", encodeURIComponent(channel.url)).replace("{raw}", channel.url)
  if (!(await Safari.openURL(target))) {
    await Dialog.alert({ title: "无法打开播放器", message: `未能打开 ${target.split(":")[0]}://，请确认已安装对应 App。播放地址已复制到剪贴板。` })
  }
}

// ---- 内置播放器 ----

export function canPlayInApp(channel: Channel): boolean {
  return HLS_PLATFORMS.includes(channel.platform)
}

export async function play(channel: Channel, mode = readSettings().playMode) {
  const inApp = canPlayInApp(channel)
  const external = EXTERNAL_PLAYERS[readSettings().externalPlayer].label
  if (mode === "ask") {
    const actions = [{ label: `在 ${external} 中播放` }, ...(inApp ? [{ label: "在 Scripting 内播放（HLS）" }] : [])]
    const index = await Dialog.actionSheet({
      title: channel.name,
      message: inApp ? channel.title || undefined : "斗鱼只提供 FLV，系统播放器不支持，只能用外部播放器。",
      actions,
    })
    if (index === 0) await openExternal(channel)
    else if (index === 1) await presentPlayer(channel)
    return
  }
  if (mode === "inapp" && inApp) await presentPlayer(channel)
  else await openExternal(channel)
}

export async function presentPlayer(channel: Channel) {
  await Navigation.present({ element: <PlayerPage channel={channel} /> })
}

function PlayerPage({ channel }: { channel: Channel }) {
  const dismiss = Navigation.useDismiss()
  const pipStatus = useObservable<PIPStatus>()
  const [state, setState] = useState<"loading" | "playing" | "error">("loading")
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const player = useMemo(() => {
    SharedAudioSession.setActive(true)
    SharedAudioSession.setCategory("playback", [])
    return new AVPlayer()
  }, [])

  useEffect(() => () => { player.dispose() }, [])

  useEffect(() => {
    let cancelled = false
    setState("loading")
    player.onReadyToPlay = () => { if (!cancelled) { setState("playing"); player.play() } }
    player.onError = message => {
      if (cancelled) return
      setError(`播放失败：${message}\n直播 CDN 可能需要请求头或已切换线路，可点“重试”重新解析，或改用外部播放器。`)
      setState("error")
    }
    resolveStream(channel, true).then(url => {
      if (cancelled) return
      if (!player.setSource(url)) throw new Error("系统播放器无法加载该地址")
    }).catch((e: unknown) => {
      if (cancelled) return
      setError(e instanceof Error ? e.message : String(e))
      setState("error")
    })
    return () => { cancelled = true }
  }, [attempt])

  return <NavigationStack>
    <VStack
      navigationTitle={channel.name}
      navigationBarTitleDisplayMode="inline"
      background="black"
      toolbar={<Toolbar>
        <ToolbarItem placement="cancellationAction"><Button title="关闭" action={() => { player.stop(); dismiss() }} /></ToolbarItem>
        <ToolbarItem placement="topBarTrailing"><Button title="重试" systemImage="arrow.clockwise" action={() => { player.stop(); setAttempt(attempt + 1) }} /></ToolbarItem>
      </Toolbar>}
    >
      <Spacer />
      {state === "error"
        ? <VStack spacing={12} padding>
          <Text foregroundStyle="white" multilineTextAlignment="center">{error}</Text>
          <HStack spacing={16}>
            <Button title="重试" action={() => setAttempt(attempt + 1)} />
            <Button title={`用 ${EXTERNAL_PLAYERS[readSettings().externalPlayer].label} 打开`} action={() => { void openExternal(channel) }} />
          </HStack>
        </VStack>
        : <AVPlayerView
          player={player}
          pipStatus={pipStatus}
          canStartPictureInPictureAutomaticallyFromInline
          updatesNowPlayingInfoCenter
          frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          overlay={state === "loading" ? <ProgressView tint="white" /> : undefined}
        />}
      <Spacer />
      <Text font={12} foregroundStyle="gray" padding lineLimit={2}>{`${LABELS[channel.platform]} · ${channel.room}${channel.title ? " · " + channel.title : ""}`}</Text>
    </VStack>
  </NavigationStack>
}
