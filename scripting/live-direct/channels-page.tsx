import { Button, ContentUnavailableView, Group, HStack, Image, List, Menu, Section, Spacer, Text, useState, VStack } from "scripting"
import { backend, useBackend } from "./backend"
import { type Channel, LABELS, type Platform, PLATFORMS } from "./core/common"
import { PLATFORM_COLORS } from "./overview-page"
import { canPlayInApp, openExternal, play, presentPlayer } from "./player"
import { channelKey, type Favorite, moveFavorite, removeFavorite, toggleFavorite, useFavorites } from "./store"

function Avatar({ logo, platform, dimmed }: { logo: string; platform: Platform; dimmed?: boolean }) {
  const fallback = <Image systemName="person.crop.circle.fill" font={36} foregroundStyle={PLATFORM_COLORS[platform]} />
  const url = logo.startsWith("//") ? "https:" + logo : logo.replace(/^http:\/\//, "https://")
  return <Group frame={{ width: 40, height: 40 }} clipShape="circle" opacity={dimmed ? 0.4 : 1}>
    {url.startsWith("https://") ? <Image imageUrl={url} resizable scaleToFill placeholder={fallback} frame={{ width: 40, height: 40 }} /> : fallback}
  </Group>
}

function PlatformTag({ platform }: { platform: Platform }) {
  return <Text font="caption2" foregroundStyle={PLATFORM_COLORS[platform]}>{LABELS[platform]}</Text>
}

function ChannelRow({ channel, favorite }: { channel: Channel; favorite: boolean }) {
  const key = channelKey(channel)
  return <Button
    action={() => { void play(channel) }}
    buttonStyle="plain"
    leadingSwipeActions={{ actions: [<Button title={favorite ? "取消关注" : "关注"} systemImage={favorite ? "star.slash" : "star"} tint="systemYellow" action={() => { toggleFavorite(channel) }} />] }}
    contextMenu={{
      menuItems: <Group>
        <Button title="外部播放器打开" systemImage="arrow.up.forward.app" action={() => { void openExternal(channel) }} />
        {canPlayInApp(channel) ? <Button title="在 Scripting 内播放" systemImage="play.rectangle" action={() => { void presentPlayer(channel) }} /> : null}
        <Button title="复制播放地址" systemImage="doc.on.doc" action={() => { void Pasteboard.setString(backend.liveUrl(channel.platform, channel.room_id)) }} />
        <Button title={favorite ? "取消关注" : "关注"} systemImage={favorite ? "star.slash" : "star"} action={() => { toggleFavorite(channel) }} />
        {favorite ? <Button title="上移" systemImage="arrow.up" action={() => moveFavorite(key, -1)} /> : null}
        {favorite ? <Button title="下移" systemImage="arrow.down" action={() => moveFavorite(key, 1)} /> : null}
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
        <Text font="caption2" foregroundStyle="tertiaryLabel">未开播或不在当前列表</Text>
      </HStack>
    </VStack>
  </HStack>
}

function matches(query: string, ...fields: string[]): boolean {
  const q = query.trim().toLowerCase()
  return !q || fields.some(field => field.toLowerCase().includes(q))
}

export function ChannelsPage() {
  const b = useBackend()
  const favorites = useFavorites()
  const [query, setQuery] = useState("")
  const [platform, setPlatform] = useState<Platform | "all">("all")
  const [showAll, setShowAll] = useState(true)
  const channels = b.engine.listChannels()

  const live = new Map(channels.map(c => [channelKey(c), c]))
  const favoriteKeys = new Set(favorites.map(f => f.key))
  const inPlatform = (p: Platform) => platform === "all" || platform === p
  const liveFavorites = favorites.map(f => live.get(f.key)).filter((c): c is Channel => !!c && inPlatform(c.platform) && matches(query, c.name, c.title, c.room_id))
  const offlineFavorites = favorites.filter(f => !live.has(f.key) && inPlatform(f.platform) && matches(query, f.name, f.room))
  const others = channels.filter(c => !favoriteKeys.has(channelKey(c)) && inPlatform(c.platform) && matches(query, c.name, c.title, c.room_id))
  const grouped = PLATFORMS.map(p => ({ platform: p, items: others.filter(c => c.platform === p) })).filter(g => g.items.length)
  const empty = liveFavorites.length + offlineFavorites.length + (showAll ? others.length : 0) === 0

  return <List
    navigationTitle="频道"
    refreshable={async () => { b.engine.startRefresh(); await b.engine.waitForRefresh() }}
    searchable={{ value: query, onChanged: setQuery, prompt: "搜索主播、标题或房间号" }}
    toolbar={{
      topBarTrailing: [
        <Menu label={<Image systemName={platform === "all" ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill"} />}>
          <Button title="全部平台" systemImage={platform === "all" ? "checkmark" : undefined} action={() => setPlatform("all")} />
          {PLATFORMS.map(p => <Button key={p} title={LABELS[p]} systemImage={platform === p ? "checkmark" : undefined} action={() => setPlatform(p)} />)}
        </Menu>,
        <Button title={showAll ? "只看关注" : "显示全部"} systemImage={showAll ? "star" : "list.bullet"} action={() => setShowAll(!showAll)} />,
      ],
    }}
    overlay={empty
      ? <ContentUnavailableView
        title={query ? "没有匹配的频道" : b.engine.isRefreshing ? "正在刷新频道…" : "暂无直播"}
        systemImage="tv"
        description={query ? undefined : "在“平台”里启用平台并添加主播或分类；左滑频道可加入关注。"}
      />
      : undefined}
  >
    {liveFavorites.length + offlineFavorites.length > 0
      ? <Section header={<Text>{`关注 · ${liveFavorites.length} 个在播`}</Text>}>
        {liveFavorites.map(c => <ChannelRow key={channelKey(c)} channel={c} favorite />)}
        {offlineFavorites.map(f => <OfflineRow key={f.key} favorite={f} />)}
      </Section>
      : null}
    {showAll ? grouped.map(g => <Section key={g.platform} header={<Text>{`${LABELS[g.platform]} · ${g.items.length}`}</Text>}>
      {g.items.map(c => <ChannelRow key={channelKey(c)} channel={c} favorite={false} />)}
    </Section>) : null}
  </List>
}
