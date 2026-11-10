import { Button, Form, LabeledContent, Picker, Section, Text, TextField, Toggle, useState } from "scripting"
import { backend, useBackend } from "./backend"
import { EXTERNAL_PLAYERS, type ExternalPlayer, type PlayMode, readSettings, saveSettings, type Settings } from "./store"

export function SettingsPage() {
  const b = useBackend()
  const [settings, setSettings] = useState(readSettings)
  const update = (patch: Partial<Settings>) => setSettings(saveSettings(patch))
  // 端口和局域网开关要重启本机服务才生效。
  const restart = (patch: Partial<Settings>) => {
    update(patch)
    if (b.running) b.startServer()
  }

  return <Form navigationTitle="设置">
    <Section header={<Text>本机服务</Text>} footer={<Text>{
      "开启局域网访问后，同一 Wi-Fi 下的设备（如 Apple TV 上的 APTV）可以用局域网订阅地址；地址里带随机令牌，不要分享给别人。"
      + "后台保活会在 Scripting 切到后台时申请继续运行，耗电会增加，iOS 仍可能结束进程。"
    }</Text>}>
      <Button action={async () => {
        const input = await Dialog.prompt({ title: "端口", message: "1024 – 65535", defaultValue: String(settings.port), keyboardType: "numberPad", confirmLabel: "保存" })
        const port = Number(input?.trim())
        if (input == null) return
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          await Dialog.alert({ title: "端口无效", message: "请输入 1024 到 65535 之间的整数" })
          return
        }
        restart({ port })
      }}>
        <LabeledContent title="端口" value={String(settings.port)} />
      </Button>
      <Toggle title="允许局域网访问" value={settings.allowLan} onChanged={value => restart({ allowLan: value })} />
      <Toggle title="启动脚本时自动开启服务" value={settings.autoStart} onChanged={value => update({ autoStart: value })} />
      <Toggle title="后台保活" value={settings.keepAlive} onChanged={value => update({ keepAlive: value })} />
      <Button title="重置订阅令牌" role="destructive" action={async () => {
        const ok = await Dialog.confirm({ title: "重置订阅令牌？", message: "旧的订阅地址会立即失效，需要在播放器里重新添加。", confirmLabel: "重置" })
        if (ok) backend.resetToken()
      }} />
    </Section>

    <Section header={<Text>播放</Text>} footer={<Text>{
      "内置播放器使用系统 AVPlayer，只能播放 HLS：抖音、B站、虎牙会单独取 HLS 流，斗鱼只有 FLV，只能用外部播放器。\n"
      + "APTV 没有公开的“播放指定地址”链接：选 APTV 时会复制播放地址并打开 APTV，在已添加的本机订阅里点同名频道即可。"
    }</Text>}>
      <Picker title="点击频道时" value={settings.playMode} onChanged={(value: string) => update({ playMode: value as PlayMode })} pickerStyle="menu">
        <Text tag="ask">每次询问</Text>
        <Text tag="external">外部播放器</Text>
        <Text tag="inapp">内置播放器</Text>
      </Picker>
      <Picker title="外部播放器" value={settings.externalPlayer} onChanged={(value: string) => update({ externalPlayer: value as ExternalPlayer })} pickerStyle="menu">
        {(Object.keys(EXTERNAL_PLAYERS) as ExternalPlayer[]).map(key => <Text key={key} tag={key}>{EXTERNAL_PLAYERS[key].label}</Text>)}
      </Picker>
      {settings.externalPlayer === "custom"
        ? <TextField title="URL Scheme" value={settings.customTemplate} onChanged={value => update({ customTemplate: value })} prompt="例如 xxx://play?url={url}" />
        : <LabeledContent title="URL Scheme" value={EXTERNAL_PLAYERS[settings.externalPlayer].template} />}
    </Section>

    <Section header={<Text>关于</Text>} footer={<Text>{
      "解析逻辑移植自 Live Direct 服务端，在手机上直接请求各平台公开接口，不经过任何中转服务器。"
      + "仅在有权访问的范围内使用，遵守平台条款与当地法律。本脚本以 GPL-3.0 发布。"
    }</Text>}>
      <LabeledContent title="频道数" value={String(b.engine.channels.size)} />
    </Section>
  </Form>
}
