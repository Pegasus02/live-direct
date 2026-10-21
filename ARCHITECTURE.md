# Live Direct — implementation contract

Standalone Python 3.12 application (standard library runtime), no dependency on another IPTV service. Environment secrets: ADMIN_TOKEN and SUBSCRIPTION_TOKEN, PUBLIC_BASE and DATA_DIR. No user-specific values in committed examples. Existing deployments must remain unchanged.

## Module contract

`live_direct/models.py`: dataclasses Channel(platform: str, room_id: str, name: str, title: str = '', logo: str = ''), Stream(url: str, format: str, quality: str = '', headers: dict = field(default_factory=dict)).

`live_direct/net.py`: bounded HTTP client `fetch_json(url, headers=None)` and `fetch_text(url, headers=None)`; HTTPS only external domains allowlisted exact/suffix on each request, no cookies persisted, no signed URL/error logging, redirect rejection for API/pages. Injectable clients for provider tests.

`live_direct/providers/douyin.py`: `Douyin(client=None)` with `discover(config:dict)->list[Channel]`, `resolve(room_id:str, config:dict)->Stream`. Config {enabled, rooms:list[str], categories:list[str], count:int, min_viewers:int, quality:str}. Rooms accept only raw IDs or exact live.douyin.com links, not arbitrary URLs. Public category page https://live.douyin.com/categorynew/4_103 etc, public room page; parse Flight JSON without executing JS. FLV preferred, missing FLV HLS fallback; normalize official HTTP CDN to HTTPS and validate.

`live_direct/providers/bilibili.py`: `Bilibili(client=None)` same contract. Config {enabled, rooms:list[str], areas:list[str], top_per_area:int, min_online:int, quality:int, prefer_avc:bool, sessdata:str}. Fixed api.live.bilibili.com room/info, play URL, area listing; implement documented factual API responses with tests. Anonymous works where available; configured SESSDATA only sent in Cookie to fixed Bilibili API, never echoed. Prefer HTTP-FLV H264 stream where available; HLS fallback. Optional QR login helper using passport.bilibili.com; do not invent unsupported login functionality. Session status must distinguish configured from validated.

`live_direct/config.py`: independent JSON persistence, validate fields, preserve omitted secrets; redacted config GET incl secret configured booleans, never emit secret. Atomic replacement mode0600; samples no real credentials. Defaults should be conservative: providers disabled, no rooms; categories/areas may default empty.

`live_direct/app.py`: standalone HTTP backend and static admin UI. Provider calls bounded, caches success30s/failed5s, discovery TTL60+, last-known channels can remain on discovery error with honest warning; no old NAS fallback. Token subscription /s/TOKEN/interface.m3u; fixed /s/TOKEN/live/{platform}/{room_id} redirects302 no-store to validated Stream URL. Only known discovered channels permitted. HLS is CDN-direct and requires player compatibility; headers cannot magically survive302: clearly report limitation, do not forward login cookies to media client. No arbitrary URL proxy. Admin bearer or password session with HttpOnly/SameSite cookie + CSRF protection for browser, never URL admin tokens; webUI stores no secrets in localStorage. All admin routes authenticated except login page. /health generic. Non-root Docker, readonly root with dedicated writable config dir. Logs generic no signed URLs/token request paths. No remote shell or docker socket.

## Delivery and verification

Unit tests with fixtures/mocks for both providers, config secret preservation, URL restrictions, auth/CSRF, subscription escaping, caching and unknown channels. Live tests anonymous first, any real credentials migration separately scoped; do not commit current user room lists, private addresses or credentials. README installation, limitations, real-url acknowledgement and actual licensed references. GitHub visibility must be confirmed before publication. No claims of fully stable/long-term tested from brief decode tests.
