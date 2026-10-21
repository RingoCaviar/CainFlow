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
