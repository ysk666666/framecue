# 帧刻 FrameCue

帧刻是一款面向视频审阅的 Chrome 扩展。它为白名单网站提供逐帧前进、逐帧后退、实测帧率和 HLS 页面识别，适合检查运动模糊、字幕跳动、渲染瑕疵和单帧异常。

FrameCue is a Chrome extension for frame-accurate video review on sites you explicitly allow.

## 特性

- `←` / `→` 精确前进或后退一帧，播放中按键会先暂停
- `Space` 播放 / 暂停，片头 / 片尾、调速和全屏快捷键（macOS 与 Windows/Linux 分别适配，见下表）
- 页面上没有视频时不拦截任何按键，不占用浏览器自带快捷键
- 自动模式优先使用播放中的实际呈现帧测量帧率
- 支持 HLS/MSE 播放器检测
- 白名单、黑名单与逐站权限
- 动态单页路由切换后自动重新检查站点规则
- 总开关关闭后，不再拦截页面快捷键
- 帧号浮层可自由拖动，位置会保存；自动模式仅在扩展操作时显示，3 秒后隐藏；长按 `→` 期间持续显示并实时刷新帧号与音量
- 正常播放视频不会显示或刷新帧号浮层
- 浮层齿轮按钮可直接打开设置
- 在弹窗中授权站点后，自动加入白名单并立即生效
- 站点白名单持久化保存；移出白名单或加入黑名单时同步撤销对应站点权限

## 重要：按站点启用

**没有任何网站默认生效。** 打开目标网站后，点击工具栏中的帧刻图标，再点击“在此网站启用”并确认 Chrome 的站点访问授权即可。授权成功后，扩展会自动把该域名加入白名单并立即注入页面脚本，不需要再去设置页添加一次。

名单外网站：

- 不会获得站点权限
- 不会注入内容脚本
- 不会拦截空格或方向键

## 安装

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目根目录。
5. 打开视频站点页面，点击工具栏中的帧刻图标。
6. 点击“在此网站启用”并确认站点访问授权。

运行 `npm run build` 生成的发布包 `dist/framecue-v<version>.zip` 的根目录就是 `manifest.json`，没有额外的顶层文件夹。ZIP 只包含 Chrome
运行时需要的文件；`package.json`、测试和文档不会进入安装包。

浏览器不能直接加载 ZIP。要在本地调试，请直接加载项目根目录；要验证发布包，请先把 ZIP 解压到任意临时目录，
再加载解压后的根目录。

## 快捷键

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 播放 / 暂停 | `Space` | `Space` |
| 停止播放并后退一帧 | `←` | `←` |
| 停止播放并前进一帧 | `→` | `→` |
| 1× 播放，音量跟随页面；松开暂停 | 按住 `→` | 按住 `→` |
| 跳到片头 | `Option+←` 或 `Home` | `Home` |
| 跳到片尾 | `Option+→` 或 `End` | `End` |
| 降低播放速度 | `Command+←` | `Ctrl+←` |
| 提高播放速度 | `Command+→` | `Ctrl+→` |
| 播放器全屏 / 退出全屏 | `F` | `F` |

快捷键只在白名单站点、且页面上存在视频时生效；输入框内不会拦截。`Command/Ctrl+F` 页内查找与 `Alt+←/→` 前进后退保持浏览器默认行为。

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

设置保存在 `chrome.storage.sync` 中，会随 Chrome 账号同步；站点权限不会同步。在新设备上，白名单站点需要在弹窗中点击“授权此网站”，或在设置页点击“授权白名单站点”。

## 开发

要求 Node.js 20+。

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

生成发布包：

```bash
npm run build
```

## 项目结构

```text
manifest.json         扩展清单
src/background.js     按白名单注入与站点路由
src/content.js        播放器控制、帧计算、浮层
src/frame-math.js     帧时间与帧率算法
src/site-rules.js     域名与白名单规则
src/permissions.js    可选站点权限与白名单同步
_locales/             扩展名称与描述（en / zh_CN）
popup.html/js        工具栏弹窗
options.html/js      站点规则页
test/                 单元测试与端到端测试
```

## 许可证

[MIT](LICENSE)
