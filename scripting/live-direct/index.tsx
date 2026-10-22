import { Button, ContentUnavailableView, Group, HStack, Image, List, Menu, Navigation, NavigationStack, Script, Section, Spacer, Text, Toolbar, ToolbarItem, useEffect, useState, VStack } from "scripting"
import { type Channel, fetchChannels, LABELS, type Platform, PLATFORMS, readSubscription } from "./api"
import { canPlayInApp, openExternal, play, presentPlayer } from "./player"
import { ServerPage } from "./server-page"
import { promptSubscription, SettingsPage } from "./settings-page"
import { type Favorite, moveFavorite, readSettings, removeFavorite, saveSettings, syncFavorites, toggleFavorite, useFavorites } from "./store"

const PLATFORM_COLORS: Record<Platform, string> = { douyin: "systemPink", bilibili: "systemBlue", douyu: "systemOrange", huya: "systemYellow" }

function Avatar({ logo, platform, dimmed }: { logo: string; platform: Platform; dimmed?: boolean }) {
  const fallback = <Image systemName="person.crop.circle.fill" font={36} foregroundStyle={PLATFORM_COLORS[platform]} />
  return <Group frame={{ width: 40, height: 40 }} clipShape="circle" opacity={dimmed ? 0.4 : 1}>
    {logo ? <Image imageUrl={logo} resizable scaleToFill placeholder={fallback} frame={{ width: 40, height: 40 }} /> : fallback}
  </Group>
}

function PlatformTag({ platform }: { platform: Platform }) {
  return <Text font="caption2" foregroundStyle={PLATFORM_COLORS[platform]}>{LABELS[platform]}</Text>
}

function ChannelRow({ channel, favorite }: { channel: Channel; favorite: boolean }) {
  return <Button
    action={() => { void play(channel) }}
    buttonStyle="plain"
    leadingSwipeActions={{ actions: [<Button title={favorite ? "取消关注" : "关注"} systemImage={favorite ? "star.slash" : "star"} tint="systemYellow" action={() => { toggleFavorite(channel) }} />] }}
    contextMenu={{
      menuItems: <Group>
        <Button title="外部播放器打开" systemImage="arrow.up.forward.app" action={() => { void openExternal(channel) }} />
        {canPlayInApp(channel) ? <Button title="在 Scripting 内播放" systemImage="play.rectangle" action={() => { void presentPlayer(channel) }} /> : null}
        <Button title="复制播放地址" systemImage="doc.on.doc" action={() => { void Pasteboard.setString(channel.url) }} />
        <Button title={favorite ? "取消关注" : "关注"} systemImage={favorite ? "star.slash" : "star"} action={() => { toggleFavorite(channel) }} />
        {favorite ? <Button title="上移" systemImage="arrow.up" action={() => moveFavorite(channel.key, -1)} /> : null}
        {favorite ? <Button title="下移" systemImage="arrow.down" action={() => moveFavorite(channel.key, 1)} /> : null}
      </Group>,
    }}
  >
    <HStack spacing={12} contentShape="rect">
      <Avatar logo={channel.logo} platform={channel.platform} />
      <VStack alignment="leading" spacing={2}>
        <HStack spacing={6}>
          <Text font="headline" lineLimit={1}>{channel.name}</Text>
          {favorite ? <Image systemName="star.fill" font="caption" foregroundStyle="systemYellow" /> : null}
        </HStack>
        {channel.title ? <Text font="subheadline" foregroundStyle="secondaryLabel" lineLimit={1}>{channel.title}</Text> : null}
        <PlatformTag platform={channel.platform} />
      </VStack>
      <Spacer />
      <Image systemName="play.circle.fill" font="title2" foregroundStyle="systemRed" />
    </HStack>
  </Button>
}

function OfflineRow({ favorite }: { favorite: Favorite }) {
  return <HStack
    spacing={12}
    trailingSwipeActions={{ actions: [<Button title="取消关注" systemImage="star.slash" role="destructive" action={() => removeFavorite(favorite.key)} />] }}
    contextMenu={{
      menuItems: <Group>
        <Button title="上移" systemImage="arrow.up" action={() => moveFavorite(favorite.key, -1)} />
        <Button title="下移" systemImage="arrow.down" action={() => moveFavorite(favorite.key, 1)} />
        <Button title="取消关注" systemImage="star.slash" role="destructive" action={() => removeFavorite(favorite.key)} />
      </Group>,
    }}
  >
    <Avatar logo={favorite.logo} platform={favorite.platform} dimmed />
    <VStack alignment="leading" spacing={2}>
      <Text font="headline" foregroundStyle="secondaryLabel" lineLimit={1}>{favorite.name || favorite.room}</Text>
      <HStack spacing={6}>
        <PlatformTag platform={favorite.platform} />
        <Text font="caption2" foregroundStyle="tertiaryLabel">未开播或不在订阅中</Text>
      </HStack>
    </VStack>
  </HStack>
}

function matches(query: string, ...fields: string[]): boolean {
  const q = query.trim().toLowerCase()
  return !q || fields.some(field => field.toLowerCase().includes(q))
}

function HomePage() {
  const dismiss = Navigation.useDismiss()
  const favorites = useFavorites()
  const [channels, setChannels] = useState<Channel[]>([])
  const [state, setState] = useState<"idle" | "loading" | "loaded" | "error">("idle")
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [platform, setPlatform] = useState<Platform | "all">("all")
  const [showAll, setShowAll] = useState(() => readSettings().showAll)

  async function load() {
    let subscription = readSubscription()
    if (!subscription) {
      if (!(await promptSubscription())) {
        setState("error")
        setError("还没有填写订阅链接")
        return
      }
      subscription = readSubscription()
    }
    setState("loading")
    try {
      const next = await fetchChannels(subscription)
      setChannels(next)
      syncFavorites(next)
      setState("loaded")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState("error")
    }
  }

  useEffect(() => { void load() }, [])

  const live = new Map(channels.map(channel => [channel.key, channel]))
  const favoriteKeys = new Set(favorites.map(item => item.key))
  const inPlatform = (p: Platform) => platform === "all" || platform === p
  const liveFavorites = favorites.map(item => live.get(item.key)).filter((c): c is Channel => !!c && inPlatform(c.platform) && matches(query, c.name, c.title, c.room))
  const offlineFavorites = favorites.filter(item => !live.has(item.key) && inPlatform(item.platform) && matches(query, item.name, item.room))
  const others = channels.filter(c => !favoriteKeys.has(c.key) && inPlatform(c.platform) && matches(query, c.name, c.title, c.room))
  const grouped = PLATFORMS.map(p => ({ platform: p, items: others.filter(c => c.platform === p) })).filter(group => group.items.length > 0)

  async function openSettings() {
    await Navigation.present({ element: <NavigationStack><SettingsPage /></NavigationStack> })
    setShowAll(readSettings().showAll)
    void load()
  }

  const empty = state === "loaded" && liveFavorites.length + offlineFavorites.length + (showAll ? others.length : 0) === 0

  return <List
    navigationTitle="Live Direct"
    refreshable={load}
    searchable={{ value: query, onChanged: setQuery, prompt: "搜索主播、标题或房间号" }}
    toolbar={<Toolbar>
      <ToolbarItem placement="cancellationAction"><Button title="关闭" action={dismiss} /></ToolbarItem>
      <ToolbarItem placement="topBarTrailing">
        <Menu label={<Image systemName={platform === "all" ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill"} />}>
          <Button title="全部平台" systemImage={platform === "all" ? "checkmark" : undefined} action={() => setPlatform("all")} />
          {PLATFORMS.map(p => <Button key={p} title={LABELS[p]} systemImage={platform === p ? "checkmark" : undefined} action={() => setPlatform(p)} />)}
        </Menu>
      </ToolbarItem>
      <ToolbarItem placement="topBarTrailing">
        <Menu label={<Image systemName="ellipsis.circle" />}>
          <Button title="服务器与主播管理" systemImage="server.rack" action={() => { void Navigation.present({ element: <NavigationStack><ServerPage onChanged={() => { void load() }} /></NavigationStack> }) }} />
          <Button title={showAll ? "只看关注" : "显示全部频道"} systemImage={showAll ? "star" : "list.bullet"} action={() => { setShowAll(saveSettings({ showAll: !showAll }).showAll) }} />
          <Button title="设置" systemImage="gearshape" action={() => { void openSettings() }} />
        </Menu>
      </ToolbarItem>
    </Toolbar>}
    overlay={state === "error"
      ? <ContentUnavailableView title="无法读取频道" systemImage="exclamationmark.triangle" description={error} />
      : empty
        ? <ContentUnavailableView title={query ? "没有匹配的频道" : "暂无直播"} systemImage="tv" description={query ? undefined : "左滑频道可加入关注；在“服务器与主播管理”里添加长期关注的主播。"} />
        : undefined}
  >
    {state === "loading" && channels.length === 0 ? <Section><HStack><Spacer /><Text foregroundStyle="secondaryLabel">正在读取订阅…</Text><Spacer /></HStack></Section> : null}
    {liveFavorites.length + offlineFavorites.length > 0
      ? <Section header={<Text>{`关注 · ${liveFavorites.length} 个在播`}</Text>}>
        {liveFavorites.map(channel => <ChannelRow key={channel.key} channel={channel} favorite />)}
        {offlineFavorites.map(item => <OfflineRow key={item.key} favorite={item} />)}
      </Section>
      : null}
    {showAll ? grouped.map(group => <Section key={group.platform} header={<Text>{`${LABELS[group.platform]} · ${group.items.length}`}</Text>}>
      {group.items.map(channel => <ChannelRow key={channel.key} channel={channel} favorite={false} />)}
    </Section>) : null}
  </List>
}

async function run() {
  await Navigation.present({ element: <NavigationStack><HomePage /></NavigationStack> })
  Script.exit()
}

void run()
