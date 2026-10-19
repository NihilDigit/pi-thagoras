# pitato MVP

Android 包名 `dev.nihildigit.pitato`，使用 Kotlin、Compose 和 Material 3 Expressive。Windows 配置统一通过 [setup.ps1](../setup.ps1)，步骤见 [Windows 配置](../docs/windows-setup.md)。

## 使用

电脑端打开 `http://127.0.0.1:4317/` 生成配对链接。Android 添加电脑时，填入与 Host 配置相同的 relay 地址并粘贴链接；配对 URI 本身不携带 relay 地址。新电脑拥有自己的 Windows 身份和配对数据。

手机可选择电脑、项目和历史，新建独立会话或 attach 该 Host 管理的会话。聊天支持流式 Markdown、表格、代码、图片与项目文件预览。权限请求通过原生 Pi UI 契约响应，断线或过期后失效。

Host 使用真实 Pi RPC readiness、精确历史路径、有界事件 ring、cursor 和 gap 恢复。权限响应绑定会话、连接 epoch 与请求；同一 operation ID 不创建重复 writer。项目预览校验真实路径和文件身份，读取上限 2 MB。

Windows 身份使用 Credential Manager，Android seed 使用 Keystore 中的密钥加密保存。relay 通信有 TLS，没有端到端加密。Host 不接管任意外部交互 Pi 终端的 stdin。

## Android 构建

需要 JDK 17、Android SDK 36 和 Build Tools 35.0.0。

~~~powershell
cd android
./gradlew.bat :app:assembleDebug :app:assembleRelease :app:lintDebug
~~~

APK 在 `android/app/build/outputs/apk/`。生产 release 使用 R8 和 resource shrink，默认产物未签名；正式分发使用自己的签名。`smoke` 是供模拟器验收的调试签名压缩变体，允许本地明文测试 relay，生产 release 只允许 TLS。

验证范围与可运行入口见 [开发与验收](../docs/validation.md)。
