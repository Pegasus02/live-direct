import { AVPlayerView, Button, HStack, Navigation, NavigationStack, type PIPStatus, ProgressView, Spacer, Text, useEffect, useMemo, useObservable, useState, VStack } from "scripting"
import { backend } from "./backend"
import { type Channel, LABELS } from "./core/common"
import { LookupError } from "./core/engine"
import { EXTERNAL_PLAYERS, readSettings } from "./store"

// ---- 外部播放器：走本机服务的固定地址，每次打开都重新解析并 302 ----

export async function openExternal(channel: Channel) {
  if (!backend.running && !backend.startServer()) {
    await Dialog.alert({ title: "本机服务未启动", message: backend.serverError || "无法启动本机服务" })
    return
  }
  const settings = readSettings()
  const template = settings.externalPlayer === "custom" ? settings.customTemplate.trim() : EXTERNAL_PLAYERS[settings.externalPlayer].template
  if (!template) {
    await Dialog.alert({ title: "未设置外部播放器", message: "请在设置里填写自定义 URL Scheme，例如 xxx://play?url={url}" })
    return
  }
  const url = backend.liveUrl(channel.platform, channel.room_id)
  await Pasteboard.setString(url)
  const target = template.replace("{url}", encodeURIComponent(url)).replace("{raw}", url)
  if (!(await Safari.openURL(target))) {
    await Dialog.alert({ title: "无法打开播放器", message: `未能打开 ${target.split(":")[0]}://，请确认已安装对应 App。播放地址已复制到剪贴板。` })
  }
}

// ---- 内置播放器：系统 AVPlayer 只能播 HLS ----

export function canPlayInApp(channel: Channel): boolean {
  return !!backend.engine.providers[channel.platform]?.hls
}

export async function play(channel: Channel, mode = readSettings().playMode) {
  const inApp = canPlayInApp(channel)
  const external = EXTERNAL_PLAYERS[readSettings().externalPlayer].label
  if (mode === "ask") {
    const index = await Dialog.actionSheet({
      title: channel.name,
      message: inApp ? channel.title || undefined : "斗鱼只提供 FLV，系统播放器不支持，只能用外部播放器。",
      actions: [{ label: `在 ${external} 中播放` }, ...(inApp ? [{ label: "在 Scripting 内播放（HLS）" }] : [])],
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
  const [quality, setQuality] = useState("")
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
      setError(`播放失败：${message}\n可点“重试”重新解析（虎牙会换线路），或改用外部播放器。`)
      setState("error")
    }
    backend.engine.resolve(channel.platform, channel.room_id, true).then(stream => {
      if (cancelled) return
      setQuality(stream.quality)
      // 平台 CDN 可能校验 Referer，用 AVAsset 带上请求头。
      const asset = new AVAsset(stream.url, { headers: { ...stream.headers, "User-Agent": "Mozilla/5.0 LiveDirect/1.0" } })
      if (!player.setSource(asset)) throw new Error("系统播放器无法加载该地址")
    }).catch((e: unknown) => {
      if (cancelled) return
      setError(e instanceof LookupError ? "该频道不在当前列表中或没有 HLS 流，请刷新频道后重试，或改用外部播放器。"
        : e instanceof Error && e.message ? `解析失败：${e.message}` : "解析失败，可能刚下播或平台限流，请稍后重试。")
      setState("error")
    })
    return () => { cancelled = true }
  }, [attempt])

  const retry = () => { player.stop(); setAttempt(attempt + 1) }

  return <NavigationStack>
    <VStack
      navigationTitle={channel.name}
      navigationBarTitleDisplayMode="inline"
      background="black"
      toolbar={{
        cancellationAction: <Button title="关闭" action={() => { player.stop(); dismiss() }} />,
        topBarTrailing: <Button title="重试" systemImage="arrow.clockwise" action={retry} />,
      }}
    >
      <Spacer />
      {state === "error"
        ? <VStack spacing={12} padding>
          <Text foregroundStyle="white" multilineTextAlignment="center">{error}</Text>
          <HStack spacing={16}>
            <Button title="重试" action={retry} />
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
      <Text font={12} foregroundStyle="gray" padding lineLimit={2}>
        {`${LABELS[channel.platform]} · ${channel.room_id}${quality ? " · " + quality : ""}${channel.title ? " · " + channel.title : ""}`}
      </Text>
    </VStack>
  </NavigationStack>
}
