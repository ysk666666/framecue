# 帧刻 FrameCue

帧刻是一款面向视频审阅的 Chrome/Firefox 扩展。它为白名单网站提供逐帧前进、逐帧后退、实测帧率和 HLS 页面识别，适合检查运动模糊、字幕跳动、渲染瑕疵和单帧异常。

FrameCue is a Chrome/Firefox extension for frame-accurate video review on sites you explicitly allow.

## 特性

- `,` / `.` 精确后退或前进一帧，播放中按键会先暂停
- 按住 `.` 按网页播放器当前速率播放，音量跟随页面；读取不到速率时回落到 1×；松开后暂停在落点帧
- 页面上没有视频时不拦截任何按键，不占用浏览器自带快捷键
- 自动模式优先使用播放中的实际呈现帧测量帧率
- 支持 HLS/MSE 播放器检测
- 白名单、黑名单与逐站权限
- 动态单页路由切换后自动重新检查站点规则
- 总开关关闭后，不再拦截页面快捷键
- 帧号浮层可自由拖动，位置会保存；自动模式仅在扩展操作时显示，3 秒后隐藏；长按 `.` 期间持续显示并实时刷新帧号与音量
- 正常播放视频不会显示或刷新帧号浮层
- 浮层齿轮按钮可直接打开设置
- 在弹窗中授权站点后，自动加入白名单并立即生效
- 站点白名单持久化保存；移出白名单或加入黑名单时同步撤销对应站点权限

## 本地安装

Chrome 与 Firefox 各自加载一份本地构建，两者功能一致，只是入口和最低版本要求不同。

### Chrome

最低版本 **Chrome 102**。

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目根目录。

也可以先执行 `npm run build:chromium`，再加载生成的 `dist/chromium/` 目录。

### Firefox

最低版本 **Firefox 116**。

先生成 Firefox 专用构建：

```bash
npm run build:firefox
```

生成结果：

- `dist/firefox/`：已解压目录，用于本地载入
- `dist/framecue-Firefox-v<version>.zip`：对应的发布包

再载入扩展：

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 点击“临时载入附加组件”。
3. 选择 `dist/firefox/manifest.json`。

临时附加组件在关闭 Firefox 后会被移除，重新打开需要再次载入；也可以用 `web-ext` 启动：

```bash
npx web-ext run --source-dir dist/firefox
```

构建会写入附加组件 ID，默认值为 `framecue@framecue.local`；如果要发布到 AMO，请覆盖成自己的 ID：

```bash
FRAMECUE_FIREFOX_ID=you@example.com npm run build:firefox
```

### 发布包

运行 `npm run build` 一次生成两个商店发布包和对应的本地测试目录：

| 文件                                    | 说明                                      |
| --------------------------------------- | ----------------------------------------- |
| `dist/chromium/`                        | 已解压 Chromium 目录，用于本地载入        |
| `dist/firefox/`                         | 已解压 Firefox 目录，用于本地载入         |
| `dist/framecue-Firefox-v<version>.zip`  | Firefox 发布包，用于 Firefox Add-ons 商店 |
| `dist/framecue-Chromium-v<version>.zip` | Chromium 发布包，用于 Chrome 应用商店     |

本项目不再生成自签名 `.crx`、私钥或自托管更新清单。商店负责签名和后续更新，本机验证请加载 `dist/chromium/` 或
`dist/firefox/`。

也可以单独构建某一端：`npm run build:firefox` 或 `npm run build:chromium`。

所有 ZIP 的根目录都是 `manifest.json`，没有额外的顶层文件夹；只包含运行时需要的文件，`package.json`、测试和文档不会进入安装包。
浏览器不能直接加载 ZIP。要验证发布包，请先把 ZIP 解压到任意临时目录，再按上面的步骤加载解压后的根目录。

## 发布新版本

推送到 `v*` 形式的标签会触发 [`.github/workflows/release.yml`](.github/workflows/release.yml)，自动完成：

1. 运行单元测试，校验标签版本号
2. 用标签版本覆盖 `manifest.json` / `package.json` 的版本号
3. 构建 Firefox 和 Chromium 商店 ZIP
4. 创建同名 GitHub Release 并上传两个 ZIP

发布前需要在 GitHub 仓库配置：

- 可选 Variable `FRAMECUE_FIREFOX_ID`：Firefox 附加组件 ID，默认 `framecue@framecue.local`

发布流程：

```bash
npm run version:set 1.2.0   # 同步 manifest.json / package.json 版本号
git commit -am "chore: release v1.2.0"
git tag v1.2.0
git push origin main --tags
```

推送 `v*` 标签才会触发打包。普通推送到 `main` 或提交 PR 只运行 CI 测试，不会生成发布包。

工作流会创建 GitHub Release 并附加两个 ZIP。Chrome Web Store 和 Firefox Add-ons 的上传仍需在各自开发者后台完成；
当前仓库没有配置商店发布 API。发布页中的 “Source code (zip)” 和 “Source code (tar.gz)” 由 GitHub 根据标签指向的
提交自动生成，不需要 CI 上传，也不包含 `dist/` 构建产物。

## 使用方法

**没有任何网站默认生效。** 打开目标视频网站后，点击工具栏中的帧刻图标，再点击“在此网站启用”并确认浏览器的站点访问授权即可。授权成功后，扩展会自动把该域名加入白名单并立即注入页面脚本，不需要再去设置页添加一次。

启用后：

- 页面上存在视频时，只有 `,` 和 `.` 开始生效；没有视频时不拦截任何按键。
- 帧号浮层显示当前帧、帧率和音量，可拖动位置；点击浮层齿轮按钮或在设置页修改白名单、黑名单、帧率与总开关。
- 在弹窗中再次点击可移出白名单，或把站点加入黑名单，两种操作都会同步撤销该站点的访问权限。

名单外网站：

- 不会获得站点权限
- 不会注入内容脚本
- 不会拦截页面快捷键

## 工作原理

- **按站点启用。** 安装时不请求任何站点权限，白名单为空。只有用户在弹窗中点击“在此网站启用”并确认后，扩展才获得该站点的访问权限，把域名写入白名单并注入内容脚本。
- **只接管视频页面。** 内容脚本只在白名单站点、且页面存在 `<video>` 时生效并接管按键；否则完全放行，不影响浏览器自带快捷键。
- **逐帧跳转。** 按下 `,` / `.` 时无需预先暂停，扩展会先暂停视频，再按帧时长设置媒体元素的 `currentTime` 后退或前进一帧。帧时长来自自动测量的实际呈现帧、视频元数据，或用户指定的固定帧率。
- **帧率测量。** 自动模式在播放时统计实际呈现帧得到帧率；固定帧率模式始终以设定值为准，适合已知帧率的审片任务。
- **HLS 检测。** 通过 Resource Timing 观察页面加载的 `.m3u8` 请求并检查媒体元素 `src`，不改写页面的 `fetch` / `XMLHttpRequest`，只做识别与标注。
- **权限跟随名单。** 移出白名单或加入黑名单时，扩展同步撤销对应站点的访问权限；关闭总开关后不再接管按键。

## 快捷键

| 操作                                      | 快捷键     |
| ----------------------------------------- | ---------- |
| 停止并后退 / 前进一帧                     | `,` / `.`  |
| 按页面速率播放并跟随页面音量；松开后暂停在落点帧 | 按住 `.`   |

快捷键只在白名单站点、且页面上存在视频时生效；输入框内不会拦截。除 `,` 和 `.` 外，其他按键全部交给页面和浏览器。

## 按帧精度

“自动”模式会优先根据实际呈现的视频帧测量帧率；完成测量前尝试读取视频元数据，再回退到固定帧率。固定帧率模式始终优先，适合已知帧率的审片任务。

可以用 `ffprobe` 核对本地媒体的真实帧数：

```bash
ffprobe -v error -select_streams v:0 -count_frames \
  -show_entries stream=r_frame_rate,avg_frame_rate,nb_frames,nb_read_frames \
  -of default=noprint_wrappers=1 video.mp4
```

`nb_read_frames` 是实际解码计数，`nb_frames` 是容器声明值。两者一致时最可靠。

## HLS 与 MSE

HLS 检测通过 Resource Timing（`PerformanceObserver`）观察页面加载的 `.m3u8` 请求，并检查媒体元素的 `src`，不会改写页面的 `fetch`/`XMLHttpRequest` 等全局对象。HLS/MSE 播放器通常只向网页暴露当前缓冲窗口。扩展可以识别 HLS 页面、逐帧跳转，并在界面中标注“缓冲时长”；但浏览器端不保证能拿到完整分片清单的精确总帧数。

如果站点把视频放在跨域 iframe、Canvas、Closed Shadow DOM 或私有播放内核中，扩展可能无法访问其 `<video>`；这属于浏览器隔离限制。

## 权限说明

- `storage`：保存白名单、黑名单和播放偏好
- `activeTab`：点击工具栏图标时读取当前标签页的域名，用于“在此网站启用”
- `scripting`：在用户授权的白名单站点注入内容脚本
- `optional_host_permissions`：只有用户逐站授权后才获得对应站点访问权限；移出白名单时自动撤销

安装时不会请求任何站点权限，也不会出现“读取浏览记录”提示。扩展不读取、上传或保存视频内容。

设置保存在浏览器同步存储 `chrome.storage.sync` 中，会随登录的浏览器账号同步；站点权限不会同步。在新设备上，白名单站点需要在弹窗中点击“授权此网站”，或在设置页点击“授权白名单站点”。

## 开发

要求 Node.js 22+。

```bash
npm install
npx playwright install chromium
npm test
npm run test:e2e
```

测试视频 `test/fixture-30fps-audio.mp4` 已随仓库提供，可以用下面的命令重新生成：

```bash
ffmpeg -y -f lavfi -i 'testsrc2=size=640x360:rate=30' \
  -f lavfi -i 'anullsrc=r=48000:cl=mono' -t 3 \
  -c:v libx264 -pix_fmt yuv420p -g 15 -keyint_min 15 -sc_threshold 0 \
  -c:a aac -b:a 32k -movflags +faststart test/fixture-30fps-audio.mp4
```

端到端测试默认在 `http://localhost:47831` 启动测试页，可用 `FRAMECUE_ORIGIN` 覆盖。

端到端测试会启动 Chromium、加载扩展，验证白名单外不注入、授权后自动入白名单、精确落帧、HLS 检测以及弹窗和设置页布局。

Firefox 端到端测试通过 WebDriver BiDi 启动真实的无头 Firefox，临时载入 Firefox 构建，验证白名单页面注入内容脚本以及
`.` 精确前进一帧：

```bash
npm run test:e2e:firefox
```

该测试需要 Firefox 116+ 与 Node.js 22+（内置 WebSocket 客户端）；缺少任一条件时会自动跳过。Firefox 不在默认路径时，
用 `FRAMECUE_FIREFOX` 指向可执行文件。

生成全部发布产物：

```bash
npm run build
```

只构建某一端：

```bash
npm run build:firefox
npm run build:chromium
```

## 项目结构

```text
manifest.json         扩展清单
src/background.js     按白名单注入与站点路由
src/browser-api.js    chrome.* 回调 API 到 Promise 的桥接
src/content.js        播放器控制、帧计算、浮层
src/frame-math.js     帧时间与帧率算法
src/site-rules.js     域名与白名单规则
src/permissions.js    可选站点权限与白名单同步
_locales/             扩展名称与描述（en / zh_CN）
popup.html/js        工具栏弹窗
options.html/js      站点规则页
scripts/              打包脚本（build-firefox.sh / build-chromium.sh / build-release.sh / set-version.sh）
test/                 单元测试与端到端测试
```

## 许可证

[MIT](LICENSE)
