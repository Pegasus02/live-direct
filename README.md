# Live Direct

独立的抖音 / B站 / 斗鱼 / 虎牙直播订阅应用：管理主播与分类，生成 M3U，播放时解析最新地址并 302 跳转到平台 CDN。无需另一个 IPTV 服务，不转码、不代理视频。

> 开发验证中。接口可能随平台变化；短时解码成功不代表长期稳定。抖音 FLV 在 APTV 的单频道直连与302原型已由用户确认流畅，独立应用仍需多平台验收。

## 能力与限制

- 抖音：手动房间、公开分类发现、蓝光/超清/高清/标清偏好，优先FLV，无可用FLV时尝试HLS。
- B站：手动房间、分区发现、画质及H.264偏好，可选SESSDATA；仅获取账号本来有权限的流，不绕过会员/付费/DRM。
- 斗鱼：手动房间（数字房间号）、官网分类热门（网游竞技/单机热游/手游休闲/娱乐），原画/蓝光/超清/高清偏好。匿名 websec 签名取 HTTP-FLV，不执行网页脚本；默认线路不是可信HTTPS CDN时尝试其他线路。未登录时斗鱼可能把原画降为超清，档位以返回的流名为准。轮播（录像循环）房间按未开播处理。
- 虎牙：手动房间、分类热门（网游/手游/单机/娱乐），原画/4K/2K/蓝光/超清/流畅偏好。只解析房间页 `hyPlayerConfig.stream` 的JSON，对FLV防盗链参数重新签名；无可用FLV时回退HLS。播放器短时间内（2分钟）重复请求同一房间时自动换下一条CDN线路，应对个别线路播放几分钟后拒绝同一出口的情况。
- 四个平台共用同一套发现逻辑：手动房间优先，分类按热度轮流挑选、互不挤占，45秒时间预算；未开播静默跳过，抓取失败才计入警告。
- 中文后台按总览 `/admin`、抖音 `/admin/douyin`、B站 `/admin/bilibili`、斗鱼 `/admin/douyu`、虎牙 `/admin/huya` 分页；平台页仅保存当前平台并预览本平台频道，未来新增平台扩展导航与配置卡片即可。独立配置持久化；未提供凭据时不谎称已登录。支持原生二维码扫码登录与手动可选Cookie输入，扫码成功后自动持久化SESSDATA并触发高画质流刷新。
- 私密订阅、管理员会话与CSRF保护；签名地址不存盘、不写日志。管理员和订阅令牌必须不同。
- 启用的平台名单按请求定期刷新；播放地址短时缓存，过期后按需获取，不是持续后台监控。
- 原服务不作为依赖，也没有NAS中转回退。解析失败返回503；播放器已跳到CDN后，本应用无法感知卡顿，也不能保证自动重连。
- 302不能强制播放器携带Referer等请求头；如果平台CDN要求特定头，需播放器支持，不能声称所有频道通用。
- 分类来自公开页面/API，不是用户账号的关注或个性化推荐。

## Docker

运行时仅Python标准库。先复制 `.env.example` 为 `.env`，生成两个不同的随机令牌，并修改PUBLIC_BASE为播放器能访问的地址；不要上传真实.env或data。

```sh
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
mkdir -p data
# Linux NAS：数据目录交给容器专用UID；不要递归修改其他目录
sudo chown 10001:10001 data
chmod 700 data
docker compose config --quiet
docker compose up -d --build
```

默认仅发布到127.0.0.1:1907。内网使用需明确修改BIND_IP；不要直接开放公网。生产远程访问使用可信VPN或HTTPS反代，明文HTTP不能保护Cookie/订阅令牌。

访问PUBLIC_BASE的 `/login`，输入管理员令牌；保存配置并刷新频道，再从后台复制私密订阅到播放器。订阅令牌虽不是平台账号凭据，仍应保密。

容器非root、只读根、无capabilities，只将配置目录持久化。某些NAS内核不支持CPU/PIDs配额，本例不宣称这些限额生效；仍设置内存限制。

## 本地开发

```sh
python3 -B -m unittest discover -s tests -v
# 设置ADMIN_TOKEN、SUBSCRIPTION_TOKEN、PUBLIC_BASE和DATA_DIR后
python3 -m live_direct.app
```

默认所有平台均关闭。已有只含抖音/B站的配置文件会自动补上斗鱼、虎牙的关闭默认值。配置不会从其他服务偷偷读取，更不会自动迁移账号Cookie。已有服务应保留到独立应用验收完成，再另行确认停机。

## 可选免登录后台

默认 `ADMIN_AUTH_ENABLED=true`，缺省也保持登录保护。仅在完全可信内网/VPN且用户明确接受风险时，可在.env设置 `ADMIN_AUTH_ENABLED=false` 后重建容器。此时 `/admin` 和管理API不再要求密码或Cookie，`/login` 跳转后台；ADMIN_TOKEN可不配置。所有能连到端口的人都可修改配置并获取订阅URL。严禁直接开放公网；订阅令牌仍有效，但同一网络用户可以从开放后台获取它。写请求仍需同源CSRF令牌，CORS不放开。重新设true并配置有效ADMIN_TOKEN即可恢复登录。此选项不保证解决浏览器白屏，白屏根因仍应单独排查。

## 安全与隐私

不向客户端返回SESSDATA；省略或空值更新会保留已有秘密，显式清除另设开关。配置原子写入权限0600。只允许固定平台API/page端点及校验过的媒体域名，未知频道不提供任意解析服务。服务不执行网页脚本，无任意URL代理、无Docker socket、无管理NAS系统功能。

请勿提交.env、data、私密订阅、平台Cookie、真实内网地址或日志到仓库。健康端点只说明进程存活；频道状态需看管理后台。网络错误不会被当成未开播。

## 致谢与许可证

特别感谢 [wbt5/real-url](https://github.com/wbt5/real-url) 展示了“解析直播真实地址，交给外部播放器播放”的思路。本项目未复制其GPL-2.0代码。

提取器实现参考并改写自 [akiralereal/iptv](https://github.com/akiralereal/iptv) 的GPL-3.0模块，保留相应来源说明。本项目以GPL-3.0发布。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [LICENSE](LICENSE)。

非官方项目，与平台及上游作者无隶属关系。仅在有权访问的范围内使用，遵守平台条款、当地法律和创作者权利；不提供再分发许可。
