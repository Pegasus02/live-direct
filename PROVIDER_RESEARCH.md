# Provider debugging notes (2026-10-23)

## Reference and licensing boundary

Reviewed [liuchuancong/pure_live](https://github.com/liuchuancong/pure_live), master snapshot fetched 2026-10-23: Douyu/Huya site implementations and playback audit documents. That project is AGPLv3, whereas Live Direct is GPLv3. No source, translated implementation, relay, or tests from it were incorporated. It informed protocol questions and diagnostic comparisons only. Any future reuse must preserve applicable licensing; do not label AGPL source GPL-only.

Useful principles: distinguish discovery, URL resolution, HTTP media readability, decoding, and target-player acceptance; compare advertised CDNs at the same delivered quality; do not confuse a healthy transport with recovery metadata; do not apply historical periodic reconnect workarounds as current protocol facts.

## Confirmed corrections

* Douyin old ended broadcast shares could overwrite a live broadcast identity for the same anchor. Cache renewal now follows live-status and metadata checks. Existing share links and configuration are preserved.
* Huya intermittently responds with gzip even when identity encoding was requested. Huya-only streaming gzip decoding is now bounded separately by compressed and decoded response limits; corruption, truncation, trailing data, and unsupported encodings are rejected. Other providers' encoding behavior remains unchanged.
* In two live Huya rooms, web FLV yielded readable prefixes to one HTTP client but 403 to ffmpeg, whereas advertised HLS decoded moving content. Redirect resolution now prefers separately signed advertised HLS, retaining trusted FLV if HLS metadata is unavailable. This is not automatic CDN health detection.

## Evidence and limitations

On NAS production after HLS preference deployment, original subscription routes for rooms 10188 and 321123 returned HLS. Each decoded for 60 seconds: respectively 60/60 and 52/60 distinct one-second thumbnail samples. Both exited 0 with no observed403. Repeated frames in a low-motion scene are not by themselves playback loops. User config and subscription hashes were unchanged. Actual APTV playback remains unverified.

Douyu APTV failure remains open: user reports repeated-second behavior across devices with hardware decoding disabled. Default sampled streams decoded40 distinct one-second frames in40 seconds; advertised hw-h5 and hs-h5 each decoded30/30 at delivered rate4 for requested rate0. Monotonic DTS and changing content in ffmpeg do not establish APTV compatibility. No default CDN, expiry query, timestamp rewrite, proxy, or remux change is justified yet.

Huya request/header probes produced inconsistent200/403 outcomes across request order and connection implementations. Do not conclude IP binding, User-Agent rejection, Range requirement, or a universal signing failure from these samples. HLS decoder success narrows a practical transport alternative but does not establish the FLV root cause.

## Operational boundaries

Preserve working Bilibili/Douyin config and existing subscription. Before each deployment back up source/config/data and tag the prior image; restore source/image on startup failure without rolling back user data. Never print credentials, subscription tokens, signed media URLs, or unsanitized media diagnostics. Fixed allowlists and bounded HTTP deadlines remain in force.
