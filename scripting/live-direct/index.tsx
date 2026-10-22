import { AppEvents, Navigation, NavigationStack, type ScenePhase, Script, Tab, TabView } from "scripting"
import { backend } from "./backend"
import { ChannelsPage } from "./channels-page"
import { OverviewPage } from "./overview-page"
import { SettingsPage } from "./settings-page"
import { readSettings } from "./store"

// 本机服务要在看直播期间一直可用，所以这是常驻脚本：
// 下滑关闭页面只最小化，点“退出”才停止服务并结束脚本。

function App() {
  const dismiss = Navigation.useDismiss()
  return <TabView tabViewStyle="sidebarAdaptable">
    <Tab title="总览" systemImage="gauge.with.dots.needle.33percent" value="overview">
      <NavigationStack><OverviewPage onExit={dismiss} /></NavigationStack>
    </Tab>
    <Tab title="频道" systemImage="play.tv" value="channels">
      <NavigationStack><ChannelsPage /></NavigationStack>
    </Tab>
    <Tab title="设置" systemImage="gearshape" value="settings">
      <NavigationStack><SettingsPage /></NavigationStack>
    </Tab>
  </TabView>
}

let keepingAlive = false

/** 服务运行中且开启保活时，切到后台申请继续运行，回到前台释放。 */
function onScenePhase(phase: ScenePhase) {
  if (phase === "background" && backend.running && readSettings().keepAlive && !keepingAlive) {
    keepingAlive = true
    void BackgroundKeeper.keepAlive().then(ok => { keepingAlive = ok })
  } else if (phase === "active" && keepingAlive) {
    keepingAlive = false
    void BackgroundKeeper.stopKeepAlive()
  }
}

async function run() {
  if (readSettings().autoStart) backend.startServer()
  backend.engine.startRefresh()
  AppEvents.scenePhase.addListener(onScenePhase)
  if (Script.supportsMinimization()) Script.enableMinimize()
  // 用默认的页面样式，才能下滑最小化。
  await Navigation.present({ element: <App /> })
  AppEvents.scenePhase.removeListener(onScenePhase)
  backend.stopServer()
  if (keepingAlive) await BackgroundKeeper.stopKeepAlive()
  Script.exit()
}

void run()
