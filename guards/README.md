# Recovery guard

恢复核心随仓库完整保存，不依赖另一台电脑的 CodexSetup 安装目录。`SOURCE.json` 保留原始输入哈希与适配说明。

Windows 安装生成独立的 `local-guards.ts` 入口，通过 `createRecoveryHost` 在 permission reviewer 前注册恢复保护，并要求所有 native child runner 加载恢复、permission-system 和 reviewer。缺少必需入口或启动注册失败时阻止工具。不要再独立加载一份恢复 adapter，以免重复备份或改变处理顺序。

安装器为各 profile 配置专用 `PI_THAGORAS_RECOVERY_STATE`。默认位于生成的 runtime 目录下 `recovery`，不读取、迁移或清理旧 CodexSetup 数据。若独立使用 adapter，保留其显式 opt-in 和顺序要求；环境变量本身不构成工具授权。

已识别的字面量删除会改写为回收命令；危险 Git 操作先保存 staged/worktree diff、index、相关未跟踪文件和 refs。备份失败会阻止操作。它是恢复层，不是 OS sandbox；任意程序、未识别别名和动态解释器代码无法全面覆盖，用户 shell escape 也不属于 Pi tool_call 的覆盖范围。

删除回收与 Git 备份分别按 7 天和 30 天期限管理。没有隐式定时清理；显式清理只处理自身命名空间内已过期并通过身份校验的条目。恢复不会覆盖已有文件。

~~~powershell
python -B guards/manage.py --state C:/private/recovery restore-trash C:/private/recovery/trash/ENTRY
python -B guards/manage.py --state C:/private/recovery cleanup --confirm-expired-pi-thagoras-only
python -B -m unittest discover -s tests -p 'test_recovery*.py' -v
~~~

Git 恢复包保留 manifest、index、二进制补丁、untracked archive 与保护 refs。先在独立 worktree 中检查恢复结果，再决定如何合并；没有自动覆盖工作区的恢复操作。

测试只使用随机临时仓库和合成文件，不读取或清理真实备份。真实 SDK 的必需 child 注册和启动验证也由 `scripts/portable-smoke.mjs` 覆盖。
