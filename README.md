# pi-thagoras

Windows 上的本机 Pi 配置、自动权限审查、删除/Git 恢复守卫与多模型子代理工作流。

## 在另一台 Windows 上安装

需要 PowerShell 7、Git、Node.js 24.19+（24.x）和 Python 3.11+。

~~~powershell
git clone --recurse-submodules https://github.com/NihilDigit/pi-thagoras.git
cd pi-thagoras
.\setup.ps1 -Apply
~~~

脚本从固定依赖和三个子模块（`pi-packages`、`pi-permission-packages`、`pi-subagents`）构建运行环境，通过一次 UAC 将代码安装到受管理员 ACL 保护的 `%ProgramData%\PiThagoras`，自动配置并启动无窗口后台 `CLIProxyAPI` 守护任务，并合并当前用户的 `~/.pi/agent` 配置（自动生成并配对本机 `cliproxyapi.json` 密钥）。省略 `-Apply` 只显示计划。

安装后在当前终端完成两次登录认证（Google 供 Argon/Flash 使用，OpenAI 供 Astra/Sol/Review 使用），即可完整复刻整套体验：

~~~powershell
pwsh -NoProfile -File "$HOME/apps/CLIProxyAPI/control.ps1" -Action Login
pi-thagoras /login openai
node scripts/doctor.mjs --full
~~~

doctor 检查安装文件、子代理保护链和真实 Pi RPC 启动，不发送在线模型提示。详细安装与恢复说明见 [Windows 配置](docs/windows-setup.md)。

## 四代理分工与行为

主代理为 **Argon**（`cliproxyapi/gemini-4-argon-high`），配合 **Flash**（`cliproxyapi/gemini-3.8-flash-high`，只读源码探索）、**Astra**（`openai/gpt-6-astra`，架构推演与代码审查）和 **Sol**（`openai/gpt-6.1-sol`，实现与测试）；定义在 `APPEND_SYSTEM.md` 和 `agents/`。

- **顶栏与底栏（`compact-warning.ts` + `pi-footer.ts`）**：顶栏左端显示 `π` 标识，右端嵌入旋转状态指示器与精简模型/Thinking 徽章；底栏左端显示目录路径与彩色 Git 分支/状态图标，右端分组显示双配额池（Google / OpenAI 周配额、增量与重置小时数）、端到端输出速率 `tok/s` 及 8 格 `Context` 进度条。
- **子代理观察（`/subagents-fleet`）**：直接使用 `pi-subagents` 内置的 `FleetView` 与 `/subagents-fleet` 交互面板查看、引导或停止子代理。
- **本机 Chrome 协作（`skills/local-chrome`）**：通过 `@playwright/cli` 的 CDP 连接复用正在运行的已登录 Chrome；只读与可逆浏览直接执行，提交与破坏性操作需明确授权。
- **恢复守卫（`guards/`）**：删除操作自动转入独立回收目录保留 7 天，危险 Git 操作执行前自动快照备份保留 30 天。详见 [guards/README.md](guards/README.md)。

## 仓库内容

| 目录 | 用途 |
| --- | --- |
| `setup/`、`scripts/` | 固定运行依赖、Windows 构建安装、配置合并与 doctor |
| `agents/`、`extensions/`、`skills/`、`config/` | 四个代理角色、顶栏/底栏扩展、本机 Chrome 技能与默认权限配置 |
| `guards/` | 删除回收与 Git 备份恢复实现 |
| `upstream/` | 三个由 gitlink 固定提交的子模块 |
| `tests/`、`docs/` | 单元测试、冒烟测试与说明文档 |

`.build/` 只保存可重新生成的构建结果；本机凭据、会话与安装回执不进入 Git。源码、构建与验证入口见 [开发与验收](docs/validation.md)。
