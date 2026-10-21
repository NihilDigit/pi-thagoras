# Windows 配置

## 环境要求与安装

先安装 PowerShell 7、Git、Node.js 24.19+（24.x）和 Python 3.11+。使用 Git 递归克隆，不能用缺少子模块的源码 ZIP 替代：

~~~powershell
git clone --recurse-submodules https://github.com/NihilDigit/pi-thagoras.git
cd pi-thagoras
.\setup.ps1
.\setup.ps1 -Apply
~~~

没有构建缓存时，第一条命令显示计划，`-Apply` 才下载固定依赖并构建。也可以先运行 `node scripts/build-windows.mjs`，检查构建结果后再执行安装。脚本使用锁文件中的 npm 包和当前 gitlink 固定的三个子模块。

安装阶段通过 UAC 把代码放入 `C:\ProgramData\PiThagoras\<当前用户 SID>\releases\<清单摘要>`。普通用户只有读取和执行权限；安装器不执行候选代码、不读取登录凭据。当前用户配置随后由普通权限进程生成。

默认用户配置在 `~/.pi/agent`，恢复数据在其 `pi-thagoras-state` 目录。可用 `-AgentRoot` 和 `-RuntimeRoot` 指定其他位置；数据目录必须在源码及安装代码目录之外。

配置生成会合并已有偏好，保留无关 package 和模型定义。每次更新前备份会写入 Agent 目录内的 `.pi-thagoras-backups`，写入失败会自动回滚。`auth.json` 不参与备份、生成或传输。

安装完成后，只需执行两次登录即可完整启用全部四个代理与自动审查：

~~~powershell
# 1. Google Antigravity OAuth 登录（供主代理 Argon 与探路代理 Flash 使用）
pwsh -NoProfile -File "$HOME/apps/CLIProxyAPI/control.ps1" -Action Login

# 2. OpenAI OAuth 登录（供架构/审查代理 Astra、实现代理 Sol 与自动权限审查使用）
pi-thagoras /login openai

# 3. 运行自检与启动
node scripts/doctor.mjs --full
pi-thagoras
~~~

## 更新与恢复

~~~powershell
git pull --ff-only
git submodule update --init --recursive
.\setup.ps1 -Apply
~~~

根提交变化时会重新构建；修改未提交源码进行开发后，使用 `node scripts/build-windows.mjs` 显式重建。

旧代码 release 和配置备份会保留，不自动清理。需要恢复时，按 `.pi-thagoras-backups` 下的 `manifest.json` 恢复列出的配置文件，保留后来新增的设置与登录；不要整目录覆盖 Agent 目录。
