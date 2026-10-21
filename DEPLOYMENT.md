# Isolated deployment and rollback plan

## Before installation

- Never reuse existing IPTV/direct-sidecar directories, ports, container names or compose projects.
- Proposed new service port1907; confirm free immediately before installation.
- Build a source-only archive; exclude .git, .env, data, bytecode, private configs and signatures. Verify hashes after upload to a new staging directory.
- Use the existing authorized NAS SSH account; do not change sudoers, helper allowlists, Docker daemon, kernel, firewall or router.
- Record existing IPTV/direct containers StartedAt and RestartCount read-only; compare after installation. Do not stop either one during acceptance.

## New-service installation

1. Refuse any existing/symlink install directory. Proposed dedicated path `/volume1/docker/live-direct` (not embedded into source defaults).
2. Copy source, Dockerfile, compose.yml only. Generate independent admin/subscription secrets on the NAS; .env0600. Never print secrets or put them in process arguments/logs.
3. Create dedicated `data` owned10001:10001 mode0700 (check exact resolved path before chown; never recursive against computed/empty path).
4. Set PUBLIC_BASE and BIND_IP to verified LAN values; keep port1907. `docker compose config --quiet`, build, start only the new compose project.
5. Health check, UID/read-only/memory/capabilities inspection. No CPU-quota promise on kernels lacking CFS.
6. Open admin page and test login/logout/save/refresh/subscription UI. Initial config disabled/empty; no automatic secret import.
7. User may configure anonymous manual rooms/categories first. Migration of existing login credentials, if requested, must happen privately in memory/0600 files and never enter Git.

## Acceptance

- Anonymous independent Douyin/Bili discovery and resolution: already verified at provider level; recheck through deployed HTTP subscription.
- Cold enabled subscription should respond503 Retry-After while loading, not return a misleading empty success. Later request should provide metadata and tokenized new-service URLs.
- For each platform check302 host is official CDN; decode samples and have user validate APTV. Headers required by CDN may not survive302; no blanket compatibility claims.
- Verify old container timestamps/restarts unchanged, no runtime calls from new app to old IPTV.
- Deliver admin and subscription privately; never print platform cookies or signed URLs in chat. Management/stream capability tokens are secrets too.

## Rollback

If new service fails, leave existing IPTV/direct sidecar unchanged and use their existing subscriptions. With user authorization, stop only the named new compose service; retain its directory and data for investigation. Do not use compose down against ambiguous project/directory, delete config, prune images, or tear down other containers. Stopping old services requires separate explicit confirmation after independent-app acceptance.

## Publication

Wait for human confirmation of GitHub repository name and visibility. Authenticated account has been checked, but no repository has been created/pushed. Review staged files and initial commit only for source and generic examples; scan for secrets/private addresses and confirm GPL-3.0 source notices + real-url conceptual acknowledgement. Do not publish this NAS-specific installation plan with private values injected; this document uses only generic/proposed paths, no credentials.
