# Validation status

## Automated

2026-10-21: 34 tests passed (providers10, configuration10, engine/session11, real HTTP auth/CSRF/assets/subscription3). GitHub Actions run39530356657 at commit73f71f6 passed Python3.12 and3.13, JS syntax, Docker build, real non-root readonly startup, health, config0600 persistence and restart reload. First CI exposed fresh-system monotonic<120sec cold-refresh bug; fixed with explicit uninitialized detection and regression test. Exact provider/schema boundaries, positive room IDs, logout/session revocation, and cold-loading subscription Retry-After are covered. Added deterministic stale-discovery and in-flight-resolution revocation tests after independent security review. Management refresh now runs asynchronously; cold enabled subscriptions return retryable503 instead of empty-success while loading. JavaScript syntax check passed. Offline tests do not prove current platform compatibility.

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
