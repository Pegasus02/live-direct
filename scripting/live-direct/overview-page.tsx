import { Button, type Color, HStack, Image, List, NavigationLink, ProgressView, Section, Spacer, Text, Toggle, VStack } from "scripting"
import { backend, useBackend } from "./backend"
import { LABELS, PLATFORMS, type Platform } from "./core/common"
import { describeError, translate } from "./messages"
import { PlatformPage } from "./platform-page"
import { readSettings } from "./store"

export const PLATFORM_COLORS: Record<Platform, Color> = { douyin: "systemPink", bilibili: "systemBlue", douyu: "systemOrange", huya: "systemYellow" }

const STATUS: Record<string, [string, Color]> = {
  ok: ["正常", "systemGreen"], error: ["刷新失败", "systemRed"], disabled: ["未启用", "secondaryLabel"],
}

async function copy(text: string, what: string) {
  await Pasteboard.setString(text)
  await Dialog.alert({ title: "已复制", message: what })
}

function setEnabled(platform: Platform, enabled: boolean) {
  try {
    backend.update({ [platform]: { enabled } })
  } catch (e) {
    void Dialog.alert({ title: "保存失败", message: describeError(e) })
  }
}

export function OverviewPage({ onExit }: { onExit: () => void }) {
  const b = useBackend()
  const status = b.engine.status()
  const lan = readSettings().allowLan ? b.lanAddress() : null
  const updated = b.engine.updated ? new Date(b.engine.updated).toLocaleTimeString() : "尚未刷新"

  return <List
    navigationTitle="Live Direct"
    refreshable={async () => { b.engine.startRefresh(); await b.engine.waitForRefresh() }}
    toolbar={{
      cancellationAction: <Button title="退出" action={onExit} />,
      topBarTrailing: status.refreshing ? <ProgressView /> : <Button title="刷新频道" systemImage="arrow.triangle.2.circlepath" action={() => b.engine.startRefresh()} />,
    }}
  >
    <Section header={<Text>本机服务</Text>} footer={<Text>{
      "在 APTV 里添加上面的订阅地址即可，用法与 NAS 版相同。播放器通过本机服务取地址，所以看直播时需要 Scripting 保持运行："
      + "下滑关闭页面会最小化到后台继续服务，点“退出”才会停止。iOS 仍可能在内存紧张时结束后台进程。"
    }</Text>}>
      <Toggle
        title={b.running ? `运行中 · 端口 ${b.server?.port}` : "已停止"}
        systemImage={b.running ? "dot.radiowaves.left.and.right" : "pause.circle"}
        value={b.running}
        onChanged={on => { if (on) b.startServer(); else b.stopServer() }}
      />
      {b.serverError ? <Text foregroundStyle="systemRed">{`启动失败：${b.serverError}`}</Text> : null}
      <Button action={() => { void copy(b.subscriptionUrl(), "本机订阅地址（同一台设备上的播放器使用）") }}>
        <VStack alignment="leading" spacing={2}>
          <Text>复制本机订阅地址</Text>
          <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{b.subscriptionUrl().replace(b.token, "••••")}</Text>
        </VStack>
      </Button>
      {lan ? <Button action={() => { void copy(b.subscriptionUrl(lan), "局域网订阅地址（Apple TV 等同一 Wi-Fi 设备使用）") }}>
        <VStack alignment="leading" spacing={2}>
          <Text>复制局域网订阅地址</Text>
          <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{b.subscriptionUrl(lan).replace(b.token, "••••")}</Text>
        </VStack>
      </Button> : null}
      <Button title="复制订阅并打开 APTV" systemImage="arrow.up.forward.app" action={async () => {
        await Pasteboard.setString(b.subscriptionUrl())
        if (!(await Safari.openURL("aptv://"))) await Dialog.alert({ title: "未能打开 APTV", message: "订阅地址已复制，可手动打开 APTV 添加。" })
      }} />
    </Section>

    <Section header={<Text>平台</Text>} footer={<Text>{`共 ${status.channel_count} 个频道 · 上次刷新 ${updated}`}</Text>}>
      {PLATFORMS.map(platform => {
        const health = status.platforms[platform]
        const enabled = b.config[platform].enabled
        const [label, color] = STATUS[health?.status ?? (enabled ? "" : "disabled")] ?? ["等待刷新", "secondaryLabel"] as [string, Color]
        return <NavigationLink key={platform} destination={<PlatformPage platform={platform} />}>
          <VStack alignment="leading" spacing={4}>
            <HStack>
              <Image systemName="circle.fill" font={10} foregroundStyle={PLATFORM_COLORS[platform]} />
              <Text font="headline">{LABELS[platform]}</Text>
              <Spacer />
              <Text foregroundStyle={color}>{label}</Text>
              {enabled && health?.enabled ? <Text foregroundStyle="secondaryLabel">{` · ${health.count} 个`}</Text> : null}
            </HStack>
            {health?.message ? <Text font="caption" foregroundStyle="secondaryLabel">{health.message}</Text> : null}
            {(health?.warnings ?? []).slice(0, 3).map(w => <Text key={w} font="caption" foregroundStyle="systemOrange">{translate(w)}</Text>)}
          </VStack>
        </NavigationLink>
      })}
    </Section>

    <Section header={<Text>快速开关</Text>}>
      {PLATFORMS.map(platform => <Toggle
        key={platform}
        title={LABELS[platform]}
        value={b.config[platform].enabled}
        onChanged={value => setEnabled(platform, value)}
      />)}
    </Section>
  </List>
}
