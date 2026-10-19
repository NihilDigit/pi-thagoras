# Windows 配置

## 两种电脑角色

普通工作电脑运行 Host，连接已有的 `wss://` relay；不用在每台电脑上运行同一个 Cloudflare Tunnel。承载公网入口的电脑另外运行本地 relay 和 Tunnel。

先安装 PowerShell 7、Git、Node.js 24.19+（24.x）和 Python 3.11+。使用 Git 递归克隆，不能用缺少子模块的源码 ZIP 替代。

~~~powershell
git clone --recurse-submodules https://github.com/NihilDigit/pi-thagoras.git
cd pi-thagoras
.\setup.ps1 -ProjectPath C:\Work\project -RelayUrl wss://relay.example.com
.\setup.ps1 -ProjectPath C:\Work\project -RelayUrl wss://relay.example.com -Apply
~~~

没有构建缓存时，第一条配置命令显示计划，`-Apply` 才下载固定依赖并构建。也可以先运行 `node scripts/build-windows.mjs`，检查构建结果后再执行安装。脚本使用锁文件中的 npm 包和当前 gitlink 固定的四个 fork；没有发布到 npm 的修复也会一同安装。

安装阶段通过 UAC 把代码放入 `C:\ProgramData\PiThagoras\<当前用户 SID>\releases\<清单摘要>`。用户只有读取和执行权限；安装器不执行候选代码、不读取登录凭据。当前用户配置随后由普通权限进程生成。

默认用户配置在 `~/.pi/agent`，Host 与恢复数据在其 `pi-thagoras-state` 目录。数据不依赖可能被应用虚拟化的 AppData 路径。可用 `-AgentRoot`、`-RuntimeRoot` 和 `-Port` 指定其他位置；数据目录必须在源码、项目及安装代码目录之外。

配置生成会合并已有偏好，保留无关 package 和模型定义。每次更新前备份会写入 Agent 目录内的 `.pi-thagoras-backups`，写入失败会恢复原文件。`auth.json` 不参与备份、生成或传输。已有其他来源的 `local-guards.ts`、不含当前 authorizer 的权限策略或同名外部任务，会在安装前报出冲突，需先检查迁移。

安装完成后，当前终端可直接运行：

~~~powershell
pi-thagoras /login openai
pi-thagoras
node scripts/doctor.mjs --full
~~~

其他尚未刷新 PATH 的终端可以使用 `~/.pi/agent/bin/pi-thagoras.cmd` 的完整路径。登录由 Pi 自己保存，首次缺少登录时 doctor 会报告 `needsLogin: true`；启动验证不会调用在线模型。

## Host 常驻

`setup.ps1 -Apply` 默认注册并启用 `PiThagoras-Host`，使用当前用户的交互登录令牌和普通权限，无需保存 Windows 密码。任务直接托管 Node，停止任务会结束对应 Host。安装和更新前先退出 Pi 及其子任务；已有 Host 管理的 RPC 会话也算运行中的 Pi。

电脑页默认是 `http://127.0.0.1:4317/`。手机先把 Relay URL 设置为安装时使用的同一个地址，再用网页生成的一次性配对链接添加电脑；身份和配对记录属于当前机器，不从别的电脑复制。

~~~powershell
Get-ScheduledTask -TaskName PiThagoras-Host
Stop-ScheduledTask -TaskName PiThagoras-Host
Start-ScheduledTask -TaskName PiThagoras-Host
~~~

Host 日志位于生成配置记录的 `runtimeRoot/pitato/host.log` 和 `host-error.log`。

## 公网入口电脑

需要 Rust/MSVC 工具链，固定 relay 版本与 cloudflared 版本见 `remote/versions.json`。relay 从 fork 编译并仅监听 `127.0.0.1:3000`；cloudflared 下载后核对固定官方 SHA-256。本机构建出的 relay 哈希保存在受保护安装清单中。

~~~powershell
node scripts/build-windows.mjs --relay-server
.\setup.ps1 -ProjectPath C:\Work\project -RelayUrl wss://relay.example.com -RelayServer -Apply
~~~

在 Cloudflare Dashboard 配好指向 `http://127.0.0.1:3000` 的 Tunnel 路由，并取得这台电脑可用的 connector token。下面的命令会在本机隐藏输入 token，不把它放进命令行或仓库：

~~~powershell
$profile = Get-Content "$env:USERPROFILE/.pi/agent/pi-thagoras.json" -Raw | ConvertFrom-Json
& "$($profile.releaseRoot)/app/remote/save-tunnel-token.ps1" -Run
& "$($profile.releaseRoot)/app/remote/enable-login-start.ps1" -Components Relay,Tunnel -Run -Enable
Start-ScheduledTask PiThagoras-Relay
Start-ScheduledTask PiThagoras-Tunnel
~~~

令牌、DNS、配对和登录是各机器自己的部署资料，安装包不携带这些内容。已有 token 文件不会被输入脚本覆盖。Tunnel 使用 `--token-file`、前台进程和固定的 loopback readiness 端口，不安装管理员服务。

## 更新与恢复

~~~powershell
git pull --ff-only
git submodule update --init --recursive
.\setup.ps1 -ProjectPath C:\Work\project -RelayUrl wss://relay.example.com -Apply
~~~

根提交变化时会重新构建；只更新源码但不运行安装，不会改变正在使用的受保护代码。修改未提交源码进行开发后，使用 `node scripts/build-windows.mjs` 显式重建。

旧代码 release 和配置备份会保留，不自动清理。需要恢复时，先停止本安装器管理的 Host 和 Pi，再按备份的 `manifest.json` 恢复列出的配置文件，保留后来新增的设置与登录；不要整目录覆盖 Agent 目录。恢复后可重新运行旧 checkout 的构建和安装入口，或指向保留的旧 release。
