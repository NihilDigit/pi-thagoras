# Pi 两行 footer

此扩展源码尚未加入默认安装清单，额度接入路线仍在验证，不是 Windows 新机配置的前置条件。

## 范围与来源

入口：`extensions/pi-footer.ts`；辅助模块：`extensions/pi-footer/{core,layout,usage}.ts`。
针对安装版 Pi **1.3.0** 的 Extension API、FooterDataProvider 与 pi-tui 实现。
已完整阅读该版本 `docs/extensions.md`、`docs/tui.md`、`docs/packages.md`、
`examples/extensions/custom-footer.ts`、`examples/extensions/debug-provider.ts`，并核对相关公开类型和 OAuth 刷新实现。

布局灵感署名：**NihilDigit**，
[上游 pi-footer.ts](https://github.com/NihilDigit/pithagoras/blob/main/configs/pi/extensions/pi-footer.ts)。
核验的仓库 tree 为 `141f2eb1437a6d96ec739a19b2ac3236d0779fe6`，源码 blob 为
`9e270c6c32e0f601cdc851a6088378f41f6d1099`。
完整公开文件树未发现 LICENSE/COPYING/NOTICE，package.json 无 license 字段，README 无许可声明；
根目录 LICENSE 下载和 GitHub license API 未取得许可证。
**因此没有复制或改编上游代码，也不声称它是开放许可。** 本实现依据已确认的功能/布局独立编写。
参考文件仅留在忽略目录 `.pi-footer-reference/`，不应打包或提交。
没有安装或复制 `pi-codex-usage`，也没有修改模型、thinking、service tier 或缓存策略。

## 显示口径

宽终端示意（数据仅为示例）：

```text
π C:/Work/project (main) ~4 ?30 37.2%/272k                       gpt-5.4 high
wk 32% (+3pp) 󰥔 2d 6h 48.6 tok/s                                relay   local (1)
```

- 固定两行；字段只用空格分隔，Nerd Font 图标单色，没有 emoji、彩色圆点或中点。
- 第一行：路径、分支、Git 计数、上下文百分比/容量；右侧为实际模型 ID 和完整 thinking 等级。
  Git 使用清晰的 ASCII：`+N` staged、`~N` modified、`?N` untracked files、`!N` conflicts、
  `ahead:N` / `behind:N`；无变化为 `clean`。`?30` 是 30 个未跟踪文件，不是上下文百分比。
  一个文件可以同时 staged 和 modified，conflict 则单独计数；rename 只计一个变更，源路径记录不多计。
  Git 状态异步刷新（启动、分支变化、工具结束、shell 请求，以及最多约 15 秒一次的本地检查）。
  使用 `git status --porcelain=v1 --branch --untracked-files=all -z`，支持带换行的文件名及 rename；
  不再用默认的目录折叠计数，失败不伪造 clean。计数针对当前 Git 仓库，子模块变化按父仓库的记录计，
  不展开子模块仓库里的文件。已用真实工作区样本及独立 `git ls-files --others --exclude-standard -z` 交叉验证。
- 路径、Git、上下文、thinking、倒计时、TPS、连接详情用主题 `dim`；模型名与周额度保持默认前景。
  图标不使用品牌色，KV 仍为未着色文本。右侧模型/relay/local 位置不变，不改成全左布局。
- 上下文来自 `ctx.getContextUsage()`，容量缺失时显示 `?`，不以 0 代替未知值。
- 第二行额度优先；窄屏先省略 TPS、倒计时及连接详情，再缩短额度增量说明。
  第一行先缩短路径、省略 Git/分支，极窄时保留截断的模型。
  stale 数据在窄屏会优先退化为 `wk 32% stale` 或 `wk stale`，不把旧比例伪装成新比例。
  两行始终使用 Pi 的 `visibleWidth`、`truncateToWidth`、`sliceByColumn` 控制终端列宽。
- `footerData.getExtensionStatuses()` 在每次 render 时读取；不硬编码连接为在线，也不改 remote 逻辑。
  已核对 `upstream/remote_pi/pi-extension/src/ui/footer.ts`：
  - `remote-pi:relay`：`🟢 relay` → ` relay`；waiting for pairing 文案原样保留。
  - `remote-pi:session`：`📡 local (1)` → ` local (1)`；实际 session 名称、peer 数量原样保留。
  - `remote-pi:peer-active`：转换为 ` 设备名`，不会把机器曾配对推断为当前连接。
  - 其他扩展的状态文字继续显示；去掉其终端控制序列、emoji 和中点/圆点，不保留其颜色。
    宽度不够时仍可能截断，这不是删除原 status 数据。

模型名称均为纯文字，不添加 GPT/OpenAI/芯片图标；没有模型图标配置命令。

### 周额度与基线

**已确认修正的根因：**用户当前模型 provider 是 `openai`，而旧 footer 硬编码查询 `openai-codex`。
安装版 `ModelRegistry.getProviderAuth` → `ModelRuntime.getAuth` → 官方 OAuth resolver 的真实结构仍是
`{ auth: { apiKey: accessToken }, source: "OAuth" }`，不是字段嵌套错误。
`providers/openai.js` 与 `auth/oauth/openai-chatgpt.js` 明确提供 ChatGPT subscription OAuth，
`toAuth` 只返回 apiKey，不附 account header；其 direct token 用于 api.openai.com。
修复 provider 选择并不证明该 direct token 一定有 wham 权限或可用 account claim，后两项仍需真实诊断验证。

- GET 固定地址 `https://chatgpt.com/backend-api/wham/usage`，禁止跟随重定向。
- 使用 `ctx.modelRegistry.getProviderAuth(currentModel.provider)` 获取当前模型 provider 的官方 OAuth access token；
  只接受 `openai` / `openai-codex`，不向其他 provider 索取凭证，不静默跨 provider/account fallback。
  普通 OpenAI API key 的官方 source 为 stored credential 或环境变量名，明确拒绝当作订阅 token。
  Pi 负责检查有效期、锁定刷新及持久化；footer 不直接读写 auth.json，不实现另一套刷新。
  `ChatGPT-Account-Id` 优先使用解析结果 header，否则从 access token 的
  `payload["https://api.openai.com/auth"].chatgpt_account_id` JWT claim 取得；这是解析已获官方认证的 token，不是自行验证 JWT 身份。
  非 OAuth、缺 token/account、HTTP 失败、非法 payload 均作为 unavailable，不回退到其他凭证。
  provider 改变会取消旧查询并建立新 poller；旧账户数值在新 provider 校验前不显示，迟到结果不能覆盖新状态。
- 在 `rate_limit.primary_window` 与 `secondary_window` 中按
  `limit_window_seconds === 604800` 寻找周窗口，读取 `used_percent` 与 Unix 秒 `reset_at`。
  不假设周窗口一定在 secondary，也不以短窗口或 0 补缺。
- 启动查询、assistant `message_end` 触发；60 秒缓存，合并并发请求。
  reset 到点后使旧缓存失效并重新查，不自行归零。空闲时只更新倒计时，不每秒请求网络。
  失败后按 60/120/240/480/900 秒退避重试，恢复后重置退避。
- 整个查询等待上限 8 秒，使用 AbortController 取消 fetch 和本地等待。
  **Pi 已开始的锁内 OAuth 刷新不能由 footer 中断**，由 Pi 自己的 15 秒刷新超时收束，
  以免丢失已轮换 refresh token；footer 不等待其迟到结果，也不把结果写入已离开的会话。
- `wk 32% (+3pp)` 是**账户用量**。`+3pp` 为首次成功查询之后观察到的账户百分比变化，
  其他会话、设备或程序同期使用都会计入，不能解释成本会话独占消耗。
- 首次成功 sample 为基线，后续 sample/增量使用 `pi.appendEntry("pi-footer:quota-v1", ...)`
  存入非上下文 custom entry，不进入模型上下文。
  恢复时按 session ID 读取该 session 的全部 footer entry，不随对话分支回退：这是账户观察时间线，
  不是分支内的对话状态。fork 因 session ID 不同不会沿用旧会话基线。
- entry 仅包含 provider ID、account SHA-256 指纹、百分比、时间与观察增量，不包含 token 或原始 account ID。
  同账户在 provider 改变后重新验证可延续基线；account 切换会重建基线，避免把两个账户相减。
  旧版没有 provider 标记的 entry 会先重新查询，再按账户指纹决定是否复用基线。
- 跨 reset 将已观察的增量与新窗口当前比例相加；旧窗口最后一次查询至 reset 之间的用量、
  跳过的整个窗口不可观测。因此改为 `(~+5pp unobserved)`，表示不完整的近似观察量，
  不是准确总额。相同窗口内比例回落也保留此标记，不生成负消耗。
- 无数据先显示 `wk …`，失败显示 `wk unavailable`。
  有数据但失败、达到 reset 或 sample 超过缓存期则附 `stale`，继续保留旧数值。
  `󰥔 reset due` 表示需要重新查询而非已归零。

### 安全诊断（不请求网络）

加载新版后，在当前 TUI 输入 **`/pi-footer status`** 可查看已缓存的分类及 Git 口径。
该命令只读本地状态，不调用认证 API、不请求 wham、不触发模型、不执行 Git，不打印账户指纹。
分类为：

- `pending` / `ok`：尚未完成查询 / 已有成功记录。
- `auth-missing`：无当前支持的 provider、无解析结果或缺 access token；provider 行会单独显示 unsupported。
- `auth-non-oauth`：解析结果不是 OAuth，未发送普通 API key。
- `auth-error`：官方认证解析/刷新失败，只记录类别，不保留原错误文本。
- `account-missing`：OAuth token/header 没有可用 account ID，未发送额度请求。
- `http NNN`：只记录 HTTP 状态码，**不读取错误响应 body**。
- `network` / `timeout`：网络失败 / 超过查询上限。
- `payload-missing-weekly`：无法解析 JSON、缺合法周窗口或字段无效。
- `internal`：其他内部失败，只保留这个固定类别。

诊断不保存/输出 token、account ID、原始 payload、异常 cause 或任意服务端文案。
失败仍按原退避重试；status 命令本身不强制刷新。用户手测期间不自动部署或重启 Pi。

### TPS

- 仅在 assistant 响应结束且有正数 provider `usage.output` 和有效输出观察间隔时更新数值。
  分子是 provider output token 数（包含其已计入 output 的 reasoning，不重复相加）。
  不根据字符数、文本长度、context 或账单倒推 token。
- 分母为本次输出观察流中首次至末次 output 事件的单调时钟间隔：
  normalized `text_delta`、`thinking_delta`、`toolcall_delta`；
  OpenAI Responses 原始 text/reasoning/function-call delta 及 reasoning/function-call item 边界。
  后者用于捕捉没有可见 thinking delta 的隐藏 reasoning；普通 response.created/completed 不计入。
- 每次新请求重建统计并隐藏 KV，但同模型最近一次有效 TPS 在下次输出期间继续显示，
  不随请求开始或工具轮次闪烁。未取得新测量时保留上一次有效值；取得新测量后再替换。
  provider 或模型 ID 改变时清空 TPS 并重建统计，避免串模型；相同模型的重复选择不清空。
- 统计不计请求前 TTFT、工具执行时间及 output 结束后的 usage/完成尾巴。
  这是客户端观察到的最近完成响应吞吐率，不是实时速度或服务端精确生成时间。
- abort/error、只有一个事件、没有真实 output usage，或 usage 明确含 reasoning 但没有可观察的 reasoning
  事件时不产生新 TPS，避免虚构数字；已有最近有效值继续保留，没有历史有效值则不显示。
  非 OpenAI provider 只利用其可观察的 normalized deltas。

### KV 本地闲置提示

- 每个成功 assistant 响应（stop/length/toolUse）完成后起 30 分钟本地闲置计时。
  只在剩余时间 <=5 分钟时显示 `KV 4m 32s`；到期 `KV expired`。
  下一次模型请求开始隐藏；abort/error 不重新启动计时。
- KV 不着色、不弹窗、不发请求、不自动续缓存，也不改变 Pi 既有 cache-warming 设置。
  **这是本地提示阈值，不是服务端 TTL 保证**；服务端可以更早驱逐，也可以保留更久。
  计时不跨扩展 reload 恢复；reload 后等下一次响应建立新本地计时。

## 启用与停用（本次未执行）

无需新依赖或 package 配置修改。审验时可在新终端的一次性 Pi 进程加载：

```powershell
pi-thagoras --extension ./extensions/pi-footer.ts
```

这会在 TUI session_start 启用 footer 并开始真实额度查询，应由拥有凭证的用户/父会话明确执行。
不加载该参数即可停用。只允许一个 custom footer 生效；其他扩展之后调用 setFooter 会替换本扩展，
本扩展会停止自己的计时器、请求、Git 子进程和 branch 订阅。

当前仓库 package.json 的显式 extension 列表没有此入口，`pi -e .` 不会自动纳入它。
若确定永久启用，可由父会话另行批准将 `./extensions/pi-footer.ts` 加入 package.json 的 `pi.extensions`，
或在用户 `~/.pi/agent/settings.json` 的 extensions 中引用入口绝对路径，再由用户 reload。
本次没有修改这些配置。若选择复制到全局 extensions 目录，必须同时复制入口及同级 `pi-footer/` 辅助目录；
不应只复制入口文件，也不要复制 `.pi-footer-reference/`。

RPC/JSON/print 模式不设置 footer、不启动其查询或定时器。
启动 factory 只注册事件，真正资源均在 TUI session_start 创建。

## 验证

测试只使用 mock 认证/HTTP 和合成输出事件，**未用真实凭证请求额度接口**。
测试依赖真实安装版 pi-tui 的宽度实现；preload 仅为包名设置别名，不 mock 宽度算法，不安装依赖。

PowerShell：

```powershell
$profile = Get-Content "$env:USERPROFILE/.pi/agent/pi-thagoras.json" -Raw | ConvertFrom-Json
$env:PI_FOOTER_PI_ROOT = Split-Path (Split-Path (Split-Path $profile.piCli -Parent) -Parent) -Parent
bun test --preload ./tests/pi-footer.preload.ts tests/pi-footer.test.ts tests/pi-footer-review.test.ts
$env:JITI_FS_CACHE = '0'
node tests/pi-footer-loader-smoke.mjs
```

Git Bash：

```bash
PI_FOOTER_PI_ROOT="$PI_THAGORAS_PI_PACKAGE" bun test --preload ./tests/pi-footer.preload.ts tests/pi-footer.test.ts tests/pi-footer-review.test.ts
JITI_FS_CACHE=0 PI_FOOTER_PI_ROOT="$PI_THAGORAS_PI_PACKAGE" node tests/pi-footer-loader-smoke.mjs
```

2026-10-19 本机 Node 24.19.0 / Bun 1.4.2：

- 独立单元/生命周期及官方契约测试：26 pass、0 fail；覆盖 0–240 列、ANSI/中文/组合字符、固定两行、
  status 保留、缺周窗口、失败旧数据、缓存/退避/超时、reset 不归零、baseline JSON 恢复、
  account/fork 隔离、TPS 各类输出/abort、KV 边界/新请求隐藏、幂等清理/迟到结果隔离。
  新增 TPS 生命周期回归：同模型请求期间保留、无有效测量保留、新值替换、重复选择保持统计、
  provider/模型 ID 切换清空数值和观察间隔。
  新增实际安装 SDK 的 ModelRegistry + 官方 OAuth resolver + openai OAuth toAuth 契约回归，
  全部凭证仅是内存中构造的 synthetic 测试数据；官方刷新编排实际执行，token exchange 与
  CredentialStore 使用内存替身（不验证磁盘锁），不访问真实凭证存储或网络。
  另覆盖普通 API key 拒绝、跨 provider/account 隔离、安全诊断、
  status 命令无 I/O、纯文字模型名/ANSI dim 宽度及真实 Git untracked 文件计数交叉检查。
- Pi 1.3.0 实际 Node/Jiti loader smoke：10 event handlers、1 个 pi-footer command，未启动 session/auth/network。
  设置 JITI_FS_CACHE=0 防止测试在仓库外创建编译缓存。
- 开始尝试的 NODE_PATH 测试解析方式在 Bun test 中不可用；已改为显式 preload 的真实模块别名。
  首次测试还发现 Pi truncateToWidth 会附加 ANSI reset；断言已改为比较可见文字，宽度限制始终通过。

待用户/父会话真实审验：

1. 在实际 Nerd Font 终端中确认 regular/fullscreen、缩放、中文目录和主题切换的两行外观及图标字宽。
2. 现有 remote 的真实 relay 开/关、waiting、local peer 计数、手机连接状态，以及其他扩展的并存显示。
3. 当前 openai ChatGPT direct token 是否含 account claim、是否具备 wham 权限；用 `/pi-footer status`
   检查分类，不能把本次 provider 修正和内存契约测试宣称为真实额度成功。
   再检查官方 OAuth 自动刷新后的真实 wham 返回格式、权限/限流错误、周窗口 reset 和会话恢复。
4. Codex reasoning/tool-call、abort 与最终 usage 的实际事件链路；检查 TPS 观察值是否符合预期。
5. KV 在真实 25/30 分钟边界及新请求时的表现。单元测试不是这条交互链路的完成证据。

未做完整 TypeScript 静态类型检查（本项目没有配置/安装 TypeScript），也未执行无关 remote/android 构建。
