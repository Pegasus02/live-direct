# Third-party acknowledgements and licensing

## akiralereal/iptv

Project: https://github.com/akiralereal/iptv
License: GNU GPL version 3 (see LICENSE).

Douyin public-page Flight-data parsing and stream selection, Bilibili public API provider behavior, Douyu category/room data, and Huya page parsing, bitrate selection and anti-code signing were adapted with reference to this project's extractor implementation. Original authors retain copyright in their contributions. Provider files retain source notices; this derivative application is distributed under GPL-3.0. Changes include independent Python implementation, standalone configuration and browser administration, bounded HTTP/concurrency, tokenized M3U, and FLV CDN 302-direct delivery without the original service as a runtime dependency. Douyu signing uses the web player's websec key exchange instead of executing the upstream page script; Huya FLV lines are signed for direct redirect instead of the upstream HLS relay.

This project is not endorsed by the upstream authors.

## wbt5/real-url — special thanks

Project: https://github.com/wbt5/real-url
License of that separate project: GNU GPL version 2.

Special thanks for the idea and educational demonstration of resolving live-room playback URLs for external players. No real-url source code is incorporated in this application. The acknowledgement is conceptual and is not a claim that GPL-2.0-only code is relicensed under GPL-3.0. If source from it is ever incorporated, compatibility and obligations must be reviewed first.

## Simple Icons — platform marks

Project: https://github.com/simple-icons/simple-icons (package 16.35.0)
License of the icon data: CC0-1.0.

The Douyin (TikTok musical-note mark, shared by Douyin) and Bilibili badge paths in `live_direct/web/index.html` come from Simple Icons. CC0 covers the vector data only; the marks themselves remain trademarks of their owners and are used solely to identify each platform in the admin interface. No suitably licensed vector was found for Douyu or Huya. `live_direct/web/logo-douyu.png` and `logo-huya.png` are downscaled copies of the platforms' own logo artwork, supplied by the repository owner; they are not covered by this project's GPL-3.0 licence, remain the property of their owners, and are used only to identify each platform.

## Platforms and trademarks

Douyin/抖音, Bilibili/哔哩哔哩, Douyu/斗鱼 and Huya/虎牙 belong to their respective owners. This is an unofficial, independent tool. Users must comply with platform terms, applicable law and rights of creators; no access-control/DRM circumvention, paid-content entitlement bypass or redistribution permission is provided.
