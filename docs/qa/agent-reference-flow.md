# Agent 参考图全流程验收

本次对应 `image-assistant-prototype#018`，在 #015—#017 的基础上复核数据、原图身份与图操作边界。浏览器测试使用完整应用、真实隔离工作流/媒体存储，外部聊天与生图响应受控，不调用真实收费模型。

## 流程与判定

| 环节 | 验证内容 | 测试证据 |
| --- | --- | --- |
| @节点 / 仅选中节点 | 读取耐久原图；连接order与源批次顺序一致；普通追问优先上次唯一目标，明确命名的新目标优先 | model selected generation context；node-adapter selected node context；browser selected-node optimization |
| 重复像素 | 不同来源/批次位置保留独立imageId及sourceImageIndex；相同像素只复用传输附件 | node-adapter selected node context；browser same-pixel references（5位置、1像素附件、真实生图5输入） |
| 禁用来源 | 连线保留，不参与当前图片输入；全部禁用时也可执行；启用来源缺原图仍失败 | reference-inputs disabled sources；browser selected-node mixed-disabled及every reference source disabled |
| 方案预览/仅应用 | 默认保留来源及顺序；仅应用不调用生图；未经允许的断开、部分替换和逆序受守卫拦截 | canvas-plan/reference-inputs及browser selected-node optimization |
| 连续重新生成 | 同一方案连续执行两次、保存重开后再执行，5张原图SHA及顺序一致 | browser selected-node optimization |
| 多轮优化 | 从保存的manifest或完整基线投影恢复全部来源和批次，覆盖connections=[]的隐式保留输入 | model prompt-only followups；browser prompt-only followup（压缩后仍保留5张） |
| 多目标/待生成上游 | 旧式扁平方案遇到目标不明确或未来上游应澄清；现代方案以完整逐目标recipe校验，不能混图或用旧输出替代待生成步骤 | model prompt-only followup never mixes及modern prompt-only recipe |
| 原图/顺序变化 | 新旧方案都不能将旧参考快照静默绑定到新图；过期方案和刷新检查均校验参考recipe | canvas-plan snapshot cannot be silently rebound；reference-retry refreshing validation；browser stale-plan |
| 部分失败重试 | 只跳过已成功步骤；记录其完整资产身份；上游另行重跑改图后拒绝部分重试，完整重新生成可明确刷新上游 | reference-retry tests；browser partial Agent retries |
| 缓存来源 | execute=false的已有来源作为固定外部输入，其资产不从baseline/manifest中豁免 | reference-retry cached source |
| 缺失图片 | 当前明确使用的原图缺失应失败；历史不可读素材标不可用，不能阻塞明确无参考新任务或清空坏来源 | model unrelated new text-only及explicitly clearing broken references |
| 保存/压缩 | 旧式方案保留assetKey、来源批次位置与runId，避免持久化后丢失原图身份；不保存内联图片 | conversation-store compression preserves latest draft |

## 已修复的断点

1. selected fallback 没有复用连接排序、未排除禁用来源；资产数组和像素字典还会压缩重复位置。
2. 多轮旧方案只取每个来源的首张，且漏掉隐式保留的输入；缺少按目标隔离及未执行上游判定。
3. 仅改提示词恢复的旧资产可能在转换时被当前新资产替代；现代新目标方案也可能漏列素材。
4. 内部已完成上游的资产未进入重试检查；execute=false缓存来源又被误当成未知未来输出。
5. Agent选中范围的外部输入捕获把禁用来源误判缺图；历史缺图还可能阻塞无关新任务。
6. 提示词指令仍曾要求漏列imageRoles就移除旧输入，已与程序的默认保留契约统一。

## 验证记录

定向纯模块回归、完整Node套件和独立Standards/Spec复核结果在本地 tracker 的 `verification/018-flow-audit/` 留存。完整套件初次运行发现一个新增字段的旧严格断言以及一个浏览器启动动态导入临时失败；断言按新增来源名称字段更新，相关场景在后续完整回归复核。


## 最终结果

- 完整Node回归：1324项，1322通过、0失败、2项原有可选测试跳过；最终日志 `verification/018-flow-audit/full-node.log`。
- 修复相关纯模块复核：124项全部通过；日志 `verification/018-flow-audit/unit.log`。
- 真实应用新增场景通过：选中节点无@取图、仅应用、连续两次生成、保存重开再生成、手动改序后拒绝旧方案、5个同像素输入、压缩后的多轮仅改提示词、全部来源禁用、部分失败后保留成功上游重试、手动更换上游后阻止旧重试、完整重新生成使用新上游。
- 新旧prompt-only方案都校验参考recipe；原图变化、目标混合或未执行上游被旧输出替代时不会提交错误方案。历史不可读引用只在要求沿用时阻止，不影响明确的新文生图。
- Standards与Spec独立审查发现的问题已逐项复现、修复并复核。原图资产、来源位置和实际连接顺序均有公开边界测试，未使用产品测试专用接口。
