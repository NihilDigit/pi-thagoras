# 远程入口

Windows 的首次安装、Host 登录任务、relay/Tunnel 部署和更新入口统一见 [Windows 配置](../docs/windows-setup.md)。

普通工作电脑只需要 Host；公网入口电脑再构建并启用 Relay 与 Tunnel。地址、软件路径和状态目录由各机器的 Pi 配置目录内 `pi-thagoras.json` 记录，不从另一台电脑复制绝对路径或凭据。

交互 Pi 的手机入口仅在普通终端会话加载。print、JSON、RPC 和非终端进程不会加载该交互入口；pitato Host 通过独立的真实 Pi RPC 管理会话。

Host 复用 remote_pi 的 Supervisor、SessionManager、relay 认证和配对存储。历史按精确文件恢复，新建会话不使用 `--continue`；同一 operation ID 不创建第二个 writer。它管理自己启动的 RPC 子进程，不接管任意外部 Pi 终端的 stdin。

权限提示通过原生 Pi UI 契约转发，绑定会话、连接 epoch 与有效期，一次消费。重连后获取新的审批连接，旧审批不能重放。项目文件预览限制在已配置的项目目录中，校验真实路径、身份和大小。

机器身份在 Windows 上使用 Credential Manager；Android 的本机 seed 使用 Keystore 加密保存。沿用 relay 的 TLS 信任边界，Cloudflare TLS 终点和本地 relay 都在此边界内，当前通信没有端到端加密。

`enable-login-start.ps1` 默认只显示计划，`-Run` 才注册任务，可用 `-Components Host` 或 `Relay,Tunnel` 选择角色，`-Enable` 启用登录运行。任务使用当前用户令牌、LeastPrivilege 和 IgnoreNew，不保存密码或使用 SYSTEM。

当前仓库的源码 fork 与版本由 `.gitmodules`、gitlink 和 `setup/runtime/package-lock.json` 固定。构建目录、机器覆盖文件和旧维护回执均不属于安装输入。
