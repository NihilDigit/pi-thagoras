# 开发与验收

运行依赖锁在 `setup/runtime/package-lock.json`；三个子模块（`pi-packages`、`pi-permission-packages`、`pi-subagents`）由 gitlink 固定。

## 本机验证命令

~~~powershell
# 1. 配置文件生成与回滚测试
node --test tests/portable-profile.test.mjs

# 2. 底栏与顶栏扩展单元测试
$env:PI_FOOTER_PI_ROOT = "C:/Users/marvin/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent"
bun test --preload ./tests/pi-footer.preload.ts tests/pi-footer.test.ts tests/pi-footer-review.test.ts

# 3. 恢复守卫（7 天回收站 + 30 天 Git 备份）测试
python -m unittest discover -s tests -p "test_recovery_*.py"

# 4. 自动审查策略测试
node --test upstream/pi-packages/packages/pi-auto-review/test/policy.test.ts

# 5. 完整构建与隔离冒烟测试
node scripts/build-windows.mjs
node scripts/portable-smoke.mjs
~~~

## 受保护安装验证

可在管理员会话中单独验证受保护目录安装：

~~~powershell
$build = Get-Content .build/windows-current.json -Raw | ConvertFrom-Json
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
./scripts/install-windows.ps1 -BundleRoot $build.stage -ExpectedManifestHash $build.manifestHash -UserSid $sid
~~~
