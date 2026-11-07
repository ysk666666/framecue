# Privacy Policy / 隐私政策

Effective date: 2026-11-05

FrameCue runs entirely in your browser.

## What FrameCue stores

- **Site rules** (allowlisted and blocked hostnames) and **preferences** (frame-rate mode, HUD mode and position).
- These are stored with `chrome.storage.sync`. If Chrome sync is turned on, Google syncs them to the other browsers signed in to your Google account, under Google's privacy policy. FrameCue itself never receives them.
- A short-lived record of the site you are currently granting access to is kept in `chrome.storage.session` and is cleared after the grant completes or after 10 minutes.

## What FrameCue does not do

- No analytics, telemetry, or remote code.
- FrameCue makes no network requests of its own and does not upload, read, or record video content.
- No account is required. FrameCue does not sell or share user data.

## Site access

- No website is accessible by default.
- FrameCue only runs on a site after you add it to the allowlist **and** grant Chrome's site-access permission for it.
- Removing a site from the allowlist, or blocking it, revokes that site permission.

## Contact

Open an issue in the project repository.

---

帧刻 FrameCue 完全在浏览器本地运行：只保存站点规则和偏好设置（通过 `chrome.storage.sync`，开启 Chrome 同步时会随 Google 账号同步）；不收集统计数据，不发起任何网络请求，不读取或上传视频内容；只有加入白名单并授予站点权限的网站才会加载扩展，移出白名单时会同时撤销权限。
