# Teager DSH Launcher

Windows / macOS 上的 DeepSeek Harness（dsh）桌面启动器。用来检测或安装本机的 dsh，在窗口里打开它的 Web 界面，并提供托盘、控制台、插件安装和版本管理。

当前版本：1.1.0。

## 能做什么

- 启动时查找本机已有的 dsh。找不到时停在安装页，等用户选择目录并点击「开始安装」，不会自动开始安装。
- 把 dsh 的 Web 界面嵌在「界面」页里。默认端口是 3080，设置里留空即使用该端口，填 `0` 则由系统分配。
- 顶栏「安装插件」可安装 npm 包、本机插件目录、`.tgz` / `.tar.gz` 压缩包或 Git 仓库。安装到当前 Profile（默认 `web`），完成后需要重启 DSH 才生效。
- 启动前可检查 DSH Plugin Hub（插件市场）。未安装时自动安装；这个开关只影响市场，不决定顶栏「安装插件」是否出现。
- 设置里可以更新或回退 dsh 版本、切换 npm 源、指定 Node.js / pnpm / dsh 路径。
- 关闭窗口时可以每次询问、最小化到托盘，或直接退出。也可以开机后只驻留托盘并预启动 dsh。

## 给使用者

分发包有两种：

| 文件 | 用法 |
| --- | --- |
| `Teager-DSH-Launcher-<版本>-Portable.exe` | 免安装。双击哪个文件，运行的就是那个文件里的版本。 |
| `Teager-DSH-Launcher-<版本>-Setup.exe` | 安装版。可选择安装目录，并创建桌面和开始菜单快捷方式。 |

免安装包每次启动都会解压到临时目录，退出时删掉这份临时文件。先打开 1.0.0 再关掉，然后打开 1.0.1，看到的是 1.0.1。如果快捷方式仍指向旧的 exe，打开的就还是旧版本。设置、已安装的 dsh 和插件保存在用户目录，换启动器版本不会清掉。

首次打开且本机没有 dsh 时，需要自己选安装目录并点击「开始安装」。默认会把 Node.js 运行时、dsh、npm / pnpm 缓存和 DSH 数据放在所选目录下。Windows 上未指定时，默认根目录是 `%LOCALAPPDATA%\DeepSeekHarness`。

启动器自己的设置在：

- Windows：`%APPDATA%\Teager DSH Launcher\settings.json`（以实际 userData 目录为准）
- 日志在同一目录下的 `logs`

## 从源码运行

需要已安装 Node.js。

```bash
npm install
npm start
```

## 打包

```bash
npm run dist
```

Windows 产物在 `dist`：

- `Teager-DSH-Launcher-<版本>-Setup.exe`
- `Teager-DSH-Launcher-<版本>-Portable.exe`

macOS：

```bash
npm run dist:mac
```

只生成未打包的目录、不做出安装包：

```bash
npm run pack
```
