---
name: local-chrome
description: 使用 Playwright CLI 通过 CDP 复用本机已登录 Chrome，调研网页、读取登录后内容、操作网站或验证 Web UI。
---
# 本机 Chrome（Playwright CLI + CDP）

通过 Microsoft 官方 `@playwright/cli`（`playwright-cli`，纯 Node.js 实现，同时支持 Windows x64 与 aarch64）经由 CDP 直接连接正在运行的已登录 Chrome，无需重启浏览器或安装浏览器扩展。

## 前置条件（首次连接）

1. 在正在使用的 Chrome 中打开 `chrome://inspect/#remote-debugging`，勾选 **Allow remote debugging for this browser instance**。
2. 首次执行 `attach` 时，Chrome 窗口会弹出远程调试确认框，点击 **Allow（允许）** 即可建立持久会话。

## 常用命令流程

统一使用命名会话（如 `-s=pi`）：

```bash
# 1. 连接到正在运行的已登录 Chrome
playwright-cli -s=pi attach --cdp=chrome

# 2. 新建标签页打开目标网址（默认新建标签，不覆盖用户原有页面）
playwright-cli -s=pi tab-new "https://example.com"

# 3. 页面内跳转或获取精简无障碍快照（快照保存在 .playwright-cli/*.yml，用 read/rg 按需读取）
playwright-cli -s=pi goto "https://example.com/detail"
playwright-cli -s=pi snapshot

# 4. 基于当前快照的编号执行交互
playwright-cli -s=pi click e15
playwright-cli -s=pi fill e12 "搜索词"
playwright-cli -s=pi press Enter

# 5. 标签页管理与断开（detach 只断开连接，不会关闭用户的 Chrome）
playwright-cli -s=pi tab-list
playwright-cli -s=pi tab-select 2
playwright-cli -s=pi tab-close
playwright-cli -s=pi detach
```

## 操作原则

- **只读与可逆操作直接执行**：连接、新建本会话标签页、打开网页、`snapshot` 读取内容、页面滚动、切换标签、展开折叠项、站内搜索、填写未提交的表单草稿、关闭本会话自己新建的临时标签页，均可直接执行。
- **提交与破坏性操作需明确授权**：提交表单（Submit / Send / Post）、发布内容、删除或移除（Delete / Remove）、修改远端设置、付款、关闭用户原有的标签页，必须先向用户说明目标页面与具体操作，获得授权后再执行。
- **凭据保护**：只通过常规页面 UI 复用登录态，不读取或导出 cookies、tokens、storage 或密码。
