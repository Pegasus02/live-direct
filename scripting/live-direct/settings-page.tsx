import { Button, Form, LabeledContent, Navigation, Picker, Section, Text, TextField, Toggle, Toolbar, ToolbarItem, useState } from "scripting"
import { parseSubscription, readAdminToken, readSubscription, saveAdminToken, saveSubscription } from "./api"
import { EXTERNAL_PLAYERS, type ExternalPlayer, type PlayMode, readSettings, saveSettings } from "./store"

function mask(value: string): string {
  return value.length <= 8 ? "已设置" : value.slice(0, 4) + "…" + value.slice(-4)
}

/** 首次运行或订阅无效时也用这个提示框收集订阅链接。 */
export async function promptSubscription(): Promise<boolean> {
  const fromClipboard = (await Pasteboard.getString())?.trim() ?? ""
  const input = await Dialog.prompt({
    title: "私密订阅链接",
    message: "在 Live Direct 后台复制订阅地址，形如 https://你的地址/s/订阅令牌/interface.m3u。只保存在本机钥匙串。",
    defaultValue: parseSubscription(fromClipboard) ? fromClipboard : readSubscription(),
    placeholder: "https://…/s/…/interface.m3u",
    keyboardType: "URL",
    confirmLabel: "保存",
  })
  if (input == null) return false
  if (input.trim() && !parseSubscription(input)) {
    await Dialog.alert({ title: "格式不对", message: "订阅链接应以 /s/订阅令牌/interface.m3u 结尾。" })
    return false
  }
  saveSubscription(input)
  return true
}

export function SettingsPage() {
  const dismiss = Navigation.useDismiss()
  const [settings, setSettings] = useState(readSettings)
  const [subscription, setSubscription] = useState(readSubscription)
  const [adminToken, setAdminToken] = useState(readAdminToken)
  const update = (patch: Parameters<typeof saveSettings>[0]) => setSettings(saveSettings(patch))
  const server = parseSubscription(subscription)?.base

  async function editAdminToken() {
    const input = await Dialog.prompt({
      title: "管理员令牌（可选）",
      message: "填写后可在脚本里添加/删除主播、刷新频道。令牌只存本机钥匙串；不需要这些功能可以留空。",
      obscureText: true,
      confirmLabel: "保存",
    })
    if (input == null) return
    saveAdminToken(input)
    setAdminToken(readAdminToken())
  }

  return <Form
    navigationTitle="设置"
    navigationBarTitleDisplayMode="inline"
    toolbar={<Toolbar><ToolbarItem placement="confirmationAction"><Button title="完成" action={dismiss} /></ToolbarItem></Toolbar>}
  >
    <Section header={<Text>服务器</Text>} footer={<Text>订阅只用于读取频道列表和播放地址；管理员令牌用于“服务器”页面。</Text>}>
      <LabeledContent title="地址" value={server ?? "未设置"} />
      <Button title={subscription ? "修改订阅链接" : "填写订阅链接"} action={async () => { if (await promptSubscription()) setSubscription(readSubscription()) }} />
      <LabeledContent title="管理员令牌" value={adminToken ? mask(adminToken) : "未设置"} />
      <Button title={adminToken ? "修改管理员令牌" : "填写管理员令牌"} action={() => { void editAdminToken() }} />
      {adminToken ? <Button title="清除管理员令牌" role="destructive" action={() => { saveAdminToken(""); setAdminToken("") }} /> : null}
    </Section>

    <Section header={<Text>播放</Text>} footer={<Text>{
      "内置播放器使用系统 AVPlayer，只能播放 HLS：抖音、B站、虎牙会向服务端请求 HLS 流（需服务端支持 /hls/ 路由），斗鱼只有 FLV，始终用外部播放器。\n" +
      "APTV 没有公开的“播放指定地址”链接：选 APTV 时会复制播放地址并打开 APTV，在已添加的订阅里点同名频道即可。"
    }</Text>}>
      <Picker title="点击频道时" value={settings.playMode} onChanged={(value: PlayMode) => update({ playMode: value })} pickerStyle="menu">
        <Text tag="ask">每次询问</Text>
        <Text tag="external">外部播放器</Text>
        <Text tag="inapp">内置播放器</Text>
      </Picker>
      <Picker title="外部播放器" value={settings.externalPlayer} onChanged={(value: ExternalPlayer) => update({ externalPlayer: value })} pickerStyle="menu">
        {(Object.keys(EXTERNAL_PLAYERS) as ExternalPlayer[]).map(key => <Text key={key} tag={key}>{EXTERNAL_PLAYERS[key].label}</Text>)}
      </Picker>
      {settings.externalPlayer === "custom"
        ? <TextField title="URL Scheme" value={settings.customTemplate} onChanged={value => update({ customTemplate: value })} prompt="例如 xxx://play?url={url}" />
        : <LabeledContent title="URL Scheme" value={EXTERNAL_PLAYERS[settings.externalPlayer].template} />}
    </Section>

    <Section header={<Text>列表</Text>}>
      <Toggle title="显示全部频道（不只关注）" value={settings.showAll} onChanged={value => update({ showAll: value })} />
    </Section>
  </Form>
}
