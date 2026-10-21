# pi-thagoras

个人 Windows 端 Pi 运行环境与多模型协作配置。

## 安装

环境要求：PowerShell 7、Git、Node.js 24.19+（24.x）、Python 3.11+。

~~~powershell
git clone --recurse-submodules https://github.com/NihilDigit/pi-thagoras.git
cd pi-thagoras
.\setup.ps1 -Apply
~~~

脚本从锁定依赖与子模块构建运行环境，经一次 UAC 安装到 `%ProgramData%\PiThagoras`（管理员只读保护），配置后台无窗口运行的 `CLIProxyAPI` 计划任务，并合并 `~/.pi/agent` 用户配置。

安装后完成两次登录即可使用全部模型：

~~~powershell
# 1. Google 登录（供 Argon 与 Flash 使用）
pwsh -NoProfile -File "$HOME/apps/CLIProxyAPI/control.ps1" -Action Login

# 2. OpenAI 登录（供 Astra、Sol 与自动权限审查使用）
pi-thagoras /login openai
~~~

运行自检确认环境就绪：

~~~powershell
node scripts/doctor.mjs --full
~~~

## 角色与协作

主会话由 **Argon**（`gemini-4-argon-high`）驱动，按任务需要调用三个原生子代理：

- **Flash**（`gemini-3.8-flash-high`）：只读源码探索与事实定位。
- **Astra**（`gpt-6-astra`）：架构推演、边界检查与代码审查。
- **Sol**（`gpt-6.1-sol`）：按给定边界与类型签名编写代码并运行测试。

简单修改直接在主会话完成；子代理状态通过 `/subagents-fleet` 或输入框下方的 `FleetView` 查看与引导。

## 界面与工具

- **输入框顶栏与底栏**（`extensions/compact-warning.ts`、`extensions/pi-footer.ts`）：顶栏左侧显示 `π` 标识，右侧嵌入运行指示器、模型简称与思考等级；底栏左侧显示路径与 Git 状态，右侧显示 Google / OpenAI 周配额、输出速率与上下文进度条。
- **权限与自动审查**（`config/permissions.json`、`upstream/pi-packages`）：常规只读操作与工作区内编辑直接放行；跨目录写入与非常规命令由 `codex-auto-review` 结合当前上下文自动审核，敏感凭据路径硬性拒绝。
- **删除回收与 Git 备份**（`guards/`）：删除操作自动转入独立回收目录保留 7 天；`reset`、`clean`、`checkout` 等 Git 操作执行前自动快照备份保留 30 天。详见 [guards/README.md](guards/README.md)。
- **本机 Chrome**（`skills/local-chrome`）：通过 `@playwright/cli` 的 CDP 连接复用已登录的日常 Chrome。只读浏览直接执行，提交与删除需明确授权。

## 目录结构

| 目录 | 说明 |
| --- | --- |
| `agents/` | `flash`、`astra`、`sol` 子代理定义 |
| `extensions/` | 顶栏、底栏与恢复守卫扩展 |
| `guards/` | 文件回收与 Git 快照实现 |
| `skills/` | `local-chrome` 技能定义 |
| `config/` | 权限规则与默认配置 |
| `setup/`、`scripts/` | 运行时锁文件、构建安装脚本与 `doctor` |
| `upstream/` | `pi-packages`、`pi-permission-packages`、`pi-subagents` 子模块 |
| `tests/`、`docs/` | 测试与说明文档（[Windows 配置](docs/windows-setup.md)、[开发与验收](docs/validation.md)） |
