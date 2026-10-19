# pi-thagoras

Windows 上的 Pi 配置、自动审查和 pitato 远程工作流。Android 客户端包名为 `dev.nihildigit.pitato`。

## 在另一台 Windows 上安装

需要 PowerShell 7、Git、Node.js 24.19+（24.x）和 Python 3.11+。构建 relay 的电脑另外需要 Rust/MSVC 工具链；已验证 Windows x64，其他平台尚未验收。

~~~powershell
git clone --recurse-submodules https://github.com/NihilDigit/pi-thagoras.git
cd pi-thagoras
.\setup.ps1 -ProjectPath C:\Work\my-project -RelayUrl wss://relay.example.com -Apply
~~~

把项目目录和 relay 地址替换成自己的值。脚本从固定依赖和 fork 提交构建运行环境，通过一次 UAC 安装代码，合并当前用户的 Pi 配置，并注册、启用 Host 登录任务。省略 `-Apply` 只显示计划。已有非本安装器管理的保护入口或同名任务会阻止覆盖。

安装后在当前终端运行 `pi-thagoras /login openai`，按 Pi 的登录流程完成认证，再运行 `pi-thagoras`。电脑端在 `http://127.0.0.1:4317/`，手机从电脑端生成的配对链接添加这台机器。新机器使用自己的登录与身份。

~~~powershell
node scripts/doctor.mjs --full
~~~

doctor 检查安装文件、子代理保护和真实 Pi 启动，不发送模型提示。详细安装、更新和服务操作见 [Windows 配置](docs/windows-setup.md)。

## Pi 行为

主角色为 Astra，Sol 负责实现，Luna 只读探索；定义在 `APPEND_SYSTEM.md` 和 `agents/`。模型窗口是本地配置预算，服务端能力由所用账户和模型决定。

- `/fast` 默认关闭，支持 `on`、`off`、`status`。开启后 OpenAI 请求显式携带 `service_tier: "priority"`，新 OpenAI 子代理继承，派发时可用 `options.fast: true/false` 覆盖。
- `steer` 打断模型流或可取消工具，在同一子会话继续；显式 `follow_up` 排队。不可取消工具仍可能完成副作用。
- agent 面板的观察入口可使用本地只读浏览器页面；关闭观察页不停止任务。
- 常规浏览、搜索、非秘密文件读取和下载默认允许。删除、破坏性覆盖、上传、发布和外部消息检查具体授权；下载许可不自动授权执行远程脚本。凭据外泄和安全控制改写保留硬拒绝。
- 删除和危险 Git 操作沿用恢复保护，保留期限分别为 7 天和 30 天。恢复入口见 [guards/README.md](guards/README.md)。

## 仓库内容

| 目录 | 用途 |
| --- | --- |
| `setup/`、`scripts/` | 固定运行依赖、Windows 安装、配置生成与 doctor |
| `agents/`、`extensions/`、`config/` | 可分享的角色、扩展和默认配置 |
| `remote/` | Host、relay、Tunnel 的运行与登录任务入口 |
| `upstream/` | 四个可公开访问、由 gitlink 固定提交的 fork |
| `android/` | Kotlin、Compose 与 Material 3 Expressive 客户端 |
| `tests/`、`docs/` | 验证代码和使用说明 |

`.build/` 只保存可重新生成的构建结果；本机覆盖、登录、会话、数据库和安装回执不进入 Git。安装不依赖原电脑的 npm 目录或维护回执。

源码、构建与验证入口见 [开发与验收](docs/validation.md)。
