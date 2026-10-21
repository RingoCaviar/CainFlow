# 删除节点后的媒体缓存回归

删除节点只在工作流文件及正式媒体引用提交成功后解除该节点的引用。会话自动保存不替代显式工作流保存。媒体文件仍由共享引用和现有安全回收规则管理；其他工作流、Agent 消息及归档、历史记录继续引用的图片必须可读，总量不要求归零。

旧版保存及复制流程会重复登记 `workflow:node` 引用，而正式节点引用使用独立的 owner identity。新保存流程不再添加重复引用：先写工作流，再提交正式引用，最后释放迁移临时保护。内部工作流复制建立独立正式引用，不继承或释放来源节点的临时写入保护；外部 JSON 导出沿用原有独立引用规则。

已有残留只在能证明对应节点已经提交删除时解除。尚未正式登记的旧节点也必须进入保存时的旧引用清单，随后走正常删除提交。引用身份含有无法唯一拆分的分隔符、尚未完成的引用交接或待恢复节点继续保留；不按画布快照或图片 ID 批量删除引用。

## 自动回归

```powershell
node --test tests/workflow-deleted-node-media.test.mjs tests/legacy-media-migration.test.mjs tests/workflow-media-ownership-commit.test.mjs tests/prompt-agent-workflow-persistence.test.mjs
python -m unittest tests.test_deleted_node_media tests.test_runtime_cache tests.test_storage_service tests.test_prompt_agent_media tests.test_media_safety_gate
```

- 普通生成节点与导入节点：保存、删除、再次保存、清理后，无用引用和可回收文件消失。
- 已经提交删除的旧节点：再保存时即使跳过已有 tombstone，清理仍修复旧别名残留。
- 首次正式保存前删除旧节点：旧引用进入正常删除提交，不永久遗漏。
- 读取旧存档后、保存前删除迁移节点：不重新登记该节点的图片引用。
- 同一图片被另一工作流、Agent 当前消息、Agent 归档或历史记录共享：清理前后及重建 StorageService 后，原图均可读。
- 文件保存失败、正式引用提交失败及提交中断：不提前释放仍需要的保护；重试或恢复后可正常清理。
- 节点删除后的晚到旧格式写入被拒绝；其他工作流仍可正常写入。
- 内部工作流复制只建立自身正式引用，来源工作流的临时操作引用不被副本释放。
- 使用临时数据目录启动真实应用服务，连接生产 DiskStorage 和 WorkflowManager：保存、复制、删除双方节点、清理后，无用图片返回 404，双方 Agent 归档图片仍返回完整原始内容。

## 手动核验

1. 在 A 中导入或生成多张图片并保存，将一张加入 Agent 历史，再复制为 B。
2. 删除 A 的全部节点并保存；清理无引用缓存，确认 B 图片和 A 的 Agent 图片仍能预览。
3. 删除 B 的节点并保存；清理后仅无人使用的图片应被回收，Agent 图片仍在。
4. 重启并重新打开两份工作流，确认历史图片、消息与归档未受影响。
5. 缓存面板分类可重叠；处于完整性检查或安全回收暂停时，应显示真实保留状态，不能为了让数字归零而跳过保护。

## 数据库自动整理回归

关联 `cache-cleanup#004`。数据库整理在缓存清理事务结束后执行，只回收 SQLite 空闲页。测试使用独立临时数据库及应用服务，不整理开发者真实数据库。

```powershell
python -m unittest tests.test_database_compaction tests.test_deleted_node_media tests.test_runtime_cache tests.test_storage_routes -q
node --test tests/database-compaction-http.test.mjs tests/workflow-deleted-node-media.test.mjs
```

- 清空大体积历史元数据后，确认 `cainflow.db` 实际文件变小，不能只检查记录数量或接口成功。
- 图片缓存、临时缓存、历史记录三个真实 HTTP 清理入口均返回整理结果；其他工作流和 Agent 归档图片仍返回完整原图。
- 整理前后逐表比较全部逻辑记录；工作流 JSON 不变，Agent 当前与归档记录、正式媒体 owner 保持不变。重启后会话和原图仍可读取，外键及完整性检查通过。
- 后台维护仅在达到空间与比例阈值时整理；未达到阈值及无空闲页时跳过。显式清理因忙碌或磁盘不足延后后，下一轮维护会重试。
- 外部读事务、写事务和同进程另一整理动作均不会互相覆盖数据；在整理窗口开始后的写入会等待窗口结束并保存成功。
- 受控磁盘不足与 SQLite 写入失败不影响缓存清理的既有结果；实际中断 VACUUM 后全部逻辑记录不变，锁释放，后续写入和整理可成功。
- 持久安全状态暂停、后台扫描、有效扫描租约、未完成检查点或不兼容 schema 时延后；原有游标与数据保留。
