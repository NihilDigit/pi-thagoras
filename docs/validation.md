# 开发与验收

安装不依赖本机维护回执。运行依赖锁在 `setup/runtime/package-lock.json`；四个 fork 的精确源码提交由 gitlink 固定。

## Windows 整链验证

~~~powershell
node --test tests/portable-profile.test.mjs
node scripts/build-windows.mjs --relay-server
node scripts/portable-smoke.mjs
$build = Get-Content .build/windows-current.json -Raw | ConvertFrom-Json
./scripts/service-smoke.ps1 -ReleaseRoot $build.stage
~~~

配置测试覆盖合并已有设置、保留认证文件、重装幂等、外部保护入口冲突、TLS、写入失败回滚和数据目录隔离。

portable smoke 创建随机空白配置和项目，以实际构建产物运行 Pi 1.3.0。它验证父子 priority 请求与单次覆盖、模型流和可取消工具的打断、指导恰好消费一次、审查允许／拒绝／脱敏三条 SDK 链路，以及所有 runner 必须加载恢复、permission 和 reviewer。Host 在无 relay 身份的隔离环境中创建、读取并停止真实 Pi RPC 会话。Windows keyring 使用随机合成记录完成写入、读取和删除；relay 使用独立数据库及随机 loopback 端口。全程不调用外部模型。

service smoke 仅注册随机独立任务，检查 InteractiveToken、LeastPrivilege、直接托管 Node，并在交互式 Windows 登录中实测 Host 启动。结束后保存任务 XML 并移除本次测试任务。Session 0 的 CI 环境只验证定义，不把无交互令牌的启动跳过记为运行成功。

受保护安装可在 Windows 管理员会话中单独验证：

~~~powershell
$build = Get-Content .build/windows-current.json -Raw | ConvertFrom-Json
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
./scripts/install-windows.ps1 -BundleRoot $build.stage -ExpectedManifestHash $build.manifestHash -UserSid $sid
~~~

该步骤只安装新的代码 release，不修改用户配置、登录、配对或生产任务。`setup.ps1` 在普通用户阶段生成配置并注册 Host。

## Fork 检查

~~~powershell
npm --prefix upstream/pi-packages/packages/pi-auto-review run check
npm --prefix upstream/pi-packages/packages/pi-auto-review test
pnpm -C upstream/pi-permission-packages install --frozen-lockfile
pnpm -C upstream/pi-permission-packages --filter @gotgenes/pi-permission-system exec vitest run test/native-tool-action.test.ts
pnpm -C upstream/pi-permission-packages --filter @gotgenes/pi-permission-system run check
npm --prefix upstream/pi-subagents run typecheck
pnpm -C upstream/remote_pi/pi-extension typecheck
cargo test --manifest-path upstream/remote_pi/relay/Cargo.toml --release --locked
~~~

各 fork 的开发测试需要安装其自己的锁定开发依赖；Windows 构建脚本只安装构建所需的开发依赖与完整运行依赖。

当前已验证：自动审查 352 项测试和类型检查；permission 的 11 项完整 action 回归和类型检查；Host 795 项 Vitest、37 项 Node 测试及类型检查；relay 现有测试通过。pi-subagents 的完整 Windows 套件有 3963 项通过、81 项既有 skip 和 3 项在原始 v0.79.0 上同样复现的环境失败，类型检查与构建通过。不能把这些既有失败写成全量通过。

自动审查在线验证使用 `remote/review-model-smoke.mjs` 和对应合成 case JSON。只有操作者已有登录并显式运行它时才调用审查模型；它不执行被审工具或发送真实会话历史。CI 使用本地确定性 provider，不需要 API 凭据。

## Android

在全新 runner 上安装 JDK 17、SDK 36 与 Build Tools 35.0.0，运行构建、lint 和单元测试。已有 Android 17 x86_64 模拟器验收覆盖了真实 relay/RPC、原生审批取消、流式 Markdown、图片预览、历史 attach 和断线恢复。仪器测试在 `android/app/src/androidTest/`；隔离联调入口在 remote_pi 子模块的 `pi-extension/scripts/android-smoke.mjs`。

正式签名、ARM64 真机、Windows ARM64 及整机注销／重启后的最终演练尚未验收。
