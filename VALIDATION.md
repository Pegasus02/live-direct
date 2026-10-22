# Validation status

## Automated

2026-10-21: 34 tests passed (providers10, configuration10, engine/session11, real HTTP auth/CSRF/assets/subscription3). GitHub Actions run39530356657 at commit73f71f6 passed Python3.12 and3.13, JS syntax, Docker build, real non-root readonly startup, health, config0600 persistence and restart reload. First CI exposed fresh-system monotonic<120sec cold-refresh bug; fixed with explicit uninitialized detection and regression test. Exact provider/schema boundaries, positive room IDs, logout/session revocation, and cold-loading subscription Retry-After are covered. Added deterministic stale-discovery and in-flight-resolution revocation tests after independent security review. Management refresh now runs asynchronously; cold enabled subscriptions return retryable503 instead of empty-success while loading. JavaScript syntax check passed. Offline tests do not prove current platform compatibility.

## Douyu / Huya (added 2026-10-21)

Offline fixtures cover Douyu websec signing (MD5 rounds), betard offline/replay-loop handling, category parsing, untrusted-CDN line retry and fixed POST destination; Huya player-config and category JSON extraction without evaluation, FLV anti-code re-signing, HLS fallback, bitrate selection, offline vs. blocked pages and CDN line rotation (including through Engine.resolve). Merged head 8b43d51: 78 Python tests pass, plus JS syntax and the owner's 13 UI-logic checks.

Owner NAS review of 9906c06 (2026-10-21): Douyu category discovery and rooms 762484/63136 resolved; CDN returned HTTP200 with a valid FLV header without Referer, and ffmpeg decoded 6s from each (exit 0) — not a long-playback guarantee. Huya room 660000 resolved and the NAS read HTTP200/valid FLV, but ffmpeg on the player machine got HTTP403 twice (exit 8); cause (Referer, IP binding or other CDN rule) unknown, at that point Huya direct playback was not accepted. One Huya category fetch failed once (UnicodeDecodeError) and later succeeded; treated as intermittent.

Correction (2026-10-23): the owner's earlier generic trial feedback was mistakenly interpreted as Huya acceptance. The owner explicitly clarified that only Bilibili and Douyin played correctly, Huya could not be retrieved, and Douyu repeated the same second in APTV across devices even with hardware decoding disabled. Huya and Douyu target-player acceptance remain OPEN. Earlier Douyu NAS checks decoded short samples, which do not override that report.

NAS investigation (2026-10-23): repaired bounded Huya-only unsolicited gzip decoding and preferred advertised HLS after two independent rooms decoded HLS successfully while comparable FLV player requests failed403. Deployed subscription routes for Huya10188/321123 each decoded60 seconds (60/60 and52/60 distinct one-second samples). Huya10188 HLS further delivered10795 video packets over179.9 seconds, zero backward DTS, maximum DTS gap0.017s, exit0. Config and subscription remained unchanged. These are ffmpeg/ffprobe observations, NOT APTV acceptance. Douyu default and two advertised alternateCDNs decoded changing content in bounded samples; repeated-second APTV fault is not yet reproduced or fixed. See PROVIDER_RESEARCH.md.

Development container: cannot reach douyu.com or huya.com. Endpoints and signing follow the referenced upstream implementations (akiralereal/iptv, public recorder projects) as of October 2026. Real-room checks above were done by the owner on site; long playback and other players remain unverified.

## Owner APTV CDN comparison and production correction (2026-10-23)

The owner tested the diagnostic playlist in APTV and explicitly reported: baseline bad; hw and hs both good. This is target-player evidence for that same-room CDN comparison, not blanket acceptance of every room or long duration. Production now prefers advertised hw-h5 then hs-h5, verifies the selected CDN acknowledgement, and falls back to the original default only if preferred lines are absent or fail. Quality/config/subscription remain unchanged. Five new preference regressions bring the suite to103 passing tests. Fresh production-subscription acceptance after this change is still to be confirmed by the owner.

A separate pre-change default-line ffmpeg capture requested370 seconds but ended normally after about300 wall seconds with307 changing one-second samples, exit0. This suggests a bounded source connection in that sample, but does not prove why APTV repeats or establish an exact expiry contract; no expire-query workaround was deployed.

The diagnostic entry named baseline follows the normal production resolver. After the preference update it therefore exercises the new preferred production route, not a frozen copy of the old failing CDN.

## Opt-in Douyu comparison (2026-10-23)

98 offline Python tests cover the existing functionality and the token-scoped diagnostic playlist: current-channel/enabled checks, two fixed advertised CDN names, acknowledgement matching, shared concurrency limits, in-flight revocation, media validation, and unchanged production playlist/configuration. The deployed diagnostic playlist produced exactly three local routes. Wrong token, unsupported CDN, and unknown channel returned404 in live checks. Default/hw-h5/hs-h5 each followed302 and decoded30/30 distinct one-second samples. A separate run let ffmpeg follow the actual application302 directly: all three Douyu routes and Huya HLS decoded20/20 changing samples. Post-deployment Bilibili7734200 and Douyin147514260800 each decoded10 seconds successfully. These bounded checks still do not reproduce or validate APTV's behavior.

## Live anonymous provider checks

Run on the target NAS using independently staged Python modules (not a new persistent service):

- Douyin category discovery: 2 requested samples returned, no warnings; manual room resolution produced FULL_HD1 FLV. Eight-second FFmpeg decode exit0 with no error output.
- Bilibili area discovery: 2 requested samples returned, no warnings; manual resolution produced FLV, actual returned quality250 while requesting10000. Eight-second decode exit0 without errors. Anonymous quality is not advertised as original/highest quality.
- Host Python lacked str.removesuffix (old system Python); parser now uses compatible equivalent. Production Docker remains Python3.12.
- Mac Bilibili TLS certificate-chain verification failed; did not disable verification. NAS verified HTTPS succeeded. Live assertions are from NAS-origin API requests and local playback tests, not a claim the Mac API path works.

## Review follow-ups

Independent read-only review prompted fixes for logout/revocation UI, exact provider/schema limits, cold subscription responses, async polling, and configuration/resolve races. Remaining packaging follow-ups: browser-render acceptance, full Docker/APTV verification, and independent post-fix review. Logout and schema/cold-response tests now pass. DNS/header and inbound slow-I/O timeouts remain best-effort (not strict total wall-clock deadlines). Per-provider discovery has45s loop-budget checks but an in-progress request can exceed this budget. Do not publish as production-ready until these are addressed or clearly documented.

## Not yet verified

- Independent application's complete Docker deployment and APTV subscription acceptance.
- Bilibili authenticated original-quality streams; configured SESSDATA is not proof of validity.
- UI browser interaction: attempted isolated localhost19117 test with dummy credentials; browser-skill session failed IPC EOF before navigation. Dummy server stopped. HTTP/auth/assets are tested, visual/interaction acceptance is NOT complete. Do not substitute headless browser automation outside browser-skill.
- Long playback, room offline/reconnect transitions, platform throttling under sustained use.
- NAS-deployed full application acceptance remains pending. Generic image startup/persistence passed in GitHub CI, not on the user's NAS.

## Published repository

User confirmed public visibility. Published https://github.com/Pegasus02/live-direct and verified isPrivate=false, branch main. Both initial source commits and every tracked file were audited for known private addresses/identifiers/token patterns; no .env/data/private runtime files uploaded. GPL-3.0 full license and real-url conceptual acknowledgement plus actual upstream attribution included. Passing CI: https://github.com/Pegasus02/live-direct/actions/runs/39530356657 . This is initial open-source code, not a claim of completed NAS/APTV production acceptance.

Existing user's IPTV and previously deployed direct sidecar remain running and unmodified by independent-app development. No credentials or private room configuration are included in this repository.
