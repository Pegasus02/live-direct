# Live Direct · Scripting 独立版

把整个 Live Direct 后端搬进 iPhone / iPad 上的 [Scripting](https://apps.apple.com/app/scripting/id6479691128) App：不需要 NAS 或服务器，手机直接请求抖音、B站、斗鱼、虎牙的公开接口解析直播地址。

## 功能

- **完整后台**：总览（本机服务开关、订阅地址、各平台状态与频道数、警告）、平台页（启用开关、手动房间、抖音分享链接、分类/分区热门、数量与人气门槛、画质、B站 H.264 偏好）、B站扫码登录 / 手动填写 SESSDATA、频道预览。
- **本机订阅服务**：脚本在手机上运行一个 HTTP 服务，路由与 NAS 版完全相同：
  - `http://127.0.0.1:19070/s/令牌/interface.m3u`：M3U 订阅，APTV 等播放器直接添加；
  - `/s/令牌/live/平台/房间`：每次播放时现场解析，302 跳转到平台 CDN；
  - `/s/令牌/hls/平台/房间`：只取 HLS（斗鱼没有 HLS，返回 404）。
  - 可选“允许局域网访问”，同一 Wi-Fi 下的 Apple TV 等设备用 `http://手机IP:19070/…` 订阅。
- **频道列表与关注**：搜索、按平台筛选；左滑或长按关注，关注的主播置顶，下播后保留（灰色）。
- **播放**：外部播放器（APTV / VLC / Infuse / 自定义 URL Scheme），或 Scripting 内置播放器（系统 AVPlayer，支持画中画；带 Referer 请求头播放 HLS）。

## 安装

1. 在 Scripting 里新建一个名为 `Live Direct` 的脚本，把本目录的所有文件按原样放进去，包括 `core/` 子目录：
   `script.json`、`index.tsx`、`backend.ts`、`store.ts`、`transport.ts`、`messages.ts`、`player.tsx`、`overview-page.tsx`、`platform-page.tsx`、`channels-page.tsx`、`settings-page.tsx`，以及 `core/` 下的 9 个 `.ts` 文件。
2. 运行脚本，本机服务会自动启动。到“总览 → 平台”里启用平台、添加主播或分类，下拉刷新。
3. 在“总览”点“复制订阅并打开 APTV”，在 APTV 里添加这个订阅。

## 运行方式（重要）

播放器每次播放都要向本机服务取地址，所以**看直播期间 Scripting 需要保持运行**：

- 下滑关闭页面：脚本最小化到后台，服务继续运行；在 Scripting 的运行中脚本列表里可以重新打开。
- 点“退出”：停止服务并结束脚本，APTV 里的频道随即无法播放。
- “后台保活”（默认开启）会在切到后台时申请继续运行，耗电会增加；iOS 仍可能在内存紧张时结束后台进程。这时回到 Scripting 重新运行脚本即可。

## 播放限制

| 平台 | 外部播放器（APTV 等） | Scripting 内置播放器 |
| --- | --- | --- |
| 抖音 | ✅ 优先 FLV | 取 HLS |
| B站 | ✅ | 取 HLS（ts / fmp4） |
| 虎牙 | ✅ | 取 HLS |
| 斗鱼 | ✅ | ❌ 只有 FLV，系统播放器不支持 |

- 302 跳转不能携带 Referer 等请求头，和 NAS 版一样，个别 CDN 若要求请求头，外部播放器可能播不了；内置播放器会带上 Referer。
- APTV 没有公开的“播放指定地址”链接格式；选 APTV 时会复制该频道的播放地址并用 `aptv://` 打开 APTV，在本机订阅里点同名频道即可。
- 分类来自平台公开页面，不是账号的关注或推荐。B站登录只用于获取账号本来有权限的画质，不绕过会员/付费限制。

## 隐私与安全

- 订阅令牌和 SESSDATA 只存本机钥匙串；配置存 Scripting 的脚本私有存储，不含 SESSDATA。
- 只请求固定的官方接口域名，只把 302 跳转到校验过的官方 CDN 域名；不执行网页脚本、不代理视频流。
- 默认请求只监听 `127.0.0.1`（该设置是否生效尚未在真机上验证）；开启局域网访问后监听所有网卡。无论哪种情况，订阅地址里的随机令牌都是访问凭据，不要分享，设置里可以重置。

## 实现与验证

- `core/` 是 Python 服务端 `live_direct/` 的 TypeScript 移植（平台解析与签名、配置校验、发现与缓存引擎），不依赖 Scripting，可在 Node 中测试。
- `scripting/tests/gen_cases.py` 用 Python 版生成对照用例，`scripting/tests/run.mjs` 检查 TS 移植的输出完全一致（543 个用例）；`scripting/tests/backend.test.mjs` 用 Scripting API 的替身测试本机服务的令牌校验、M3U 与 302/404 行为。CI 会运行这些检查。
- 以上都是离线测试：开发环境无法访问各平台，界面布局、真实平台请求、后台保活和外部 App 跳转都需要在真机上验收。

解析逻辑参考 akiralereal/iptv（GPL-3.0）并改写，本脚本随项目以 GPL-3.0 发布；致谢见仓库根目录 `THIRD_PARTY_NOTICES.md`。
