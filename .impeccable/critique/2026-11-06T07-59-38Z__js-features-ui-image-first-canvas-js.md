---
target: 更多设置
total_score: 31
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
target_identity: "file:D:\\mygithub\\CainFlow\\js\\features\\ui\\image-first-canvas.js"
target_fingerprint: "sha256:64f03b6d684781e263295f3a4cac3dc9e5f88b26a555340e033dd6640f567725"
target_path: "D:\\mygithub\\CainFlow\\js\\features\\ui\\image-first-canvas.js"
timestamp: 2026-11-06T07-59-38Z
slug: js-features-ui-image-first-canvas-js
---
Method: dual-agent (A: /root/more_settings_critique_a · B: /root/more_settings_audit_b)

目标：节点参数浮层的“更多设置”。模式：Operate。评审针对最终渲染与交互，不以测试通过替代设计判断。

已按确认方案完成：400px 上限并贴近 More 入口；参考图去掉两层容器边框，每个来源的缩略图、名称和排序横排，单来源隐藏排序，长名称仅截断名称并保留数量；质量、背景、审核同排等宽；模型不支持的控件隐藏后其余控件平分空间。系统提示词保留弱边框和12px分组间距，默认两行、随输入增长至六行，删短后回缩；思考设置支持时在底部原位展开。

设计特定性判断：布局围绕参考来源、生成参数和提示词组织，适合 CainFlow 的创作任务。没有重新引入分类跳转；底栏五项仍是一行。

| Nielsen 启发式 | 分数 | 结论 |
|---|---:|---|
| 系统状态可见 | 3 | 图片序号和来源数量明确，排序即时更新 |
| 贴近用户语言 | 3 | “默认/自动”仍有学习成本 |
| 用户控制与退出 | 3 | Esc关闭并回焦，原图预览可返回 |
| 一致性与标准 | 4 | 短设置等高对齐，思考选择器补齐34px |
| 预防错误 | 3 | 原有运行锁及能力显隐保留 |
| 识别优于记忆 | 3 | 入口职责明确，长来源保留数量 |
| 灵活性与效率 | 3 | 单击切换、键盘、来源排序有效 |
| 审美与简洁 | 4 | 去嵌套边框，短字段一行，分组有间距 |
| 错误恢复 | 3 | 缺图与来源变化提示保留；本轮未注入损坏媒体 |
| 帮助说明 | 2 | 继承上级与接口默认仍需领域理解 |
| 合计 | 31/40 | Good |

认知负荷低。质量菜单有5个实际选项，超过严格“四选项”启发式，但不值得增加一次分类操作。多张参考图按来源分组。熟练用户的直接操作路径与键盘用户的回焦均已验证；新用户对少数协议术语仍有轻微学习成本。

优点：参考图关系直接且排序功能保留；三项短设置与全宽文本层级清楚；窄屏保留原有任务路径。情绪体验由原来拥挤且不均衡，变为轻而直接；排序即时反馈帮助确认结果。

评审发现并已修复：长来源吞掉数量；思考控件21px/说明10px与周边不一致；搜索关闭态轨道不明显；隐藏原生select仍进入读屏树；placeholder对比不足；移出节点后的思考控件查找与模型/供应商事件更新路径。最终实测覆盖范围内无残留P0/P1/P2优先问题。

CLI detector 对最新 image-first-canvas.js、image-reference-overview.js、node-dom-bindings.js 均返回 []，exit 0。自动扫描并未作为视觉通过依据。

Audit：实现完整性通过，17/20（Good）。

| 维度 | 分数 | 证据或限制 |
|---|---:|---|
| 无障碍 | 3 | 命名按钮、AX树、Tab、Esc回焦与排序通过；未宣称全面WCAG认证 |
| 性能 | 3 | 缩略图lazy/async/IntersectionObserver，定位rAF合并；未做大图压力剖析 |
| 主题 | 4 | 七主题placeholder对比均≥4.5:1 |
| 响应式 | 3 | 280–1280px及640×480布局通过；紧凑目标24–34px，非44px舒适触控尺寸 |
| 实现完整性 | 4 | 原控件/节点状态复用、入口独立、图像身份顺序保留 |

原生Chrome fresh tab中成功注入并执行detect.js；console为“4 anti-patterns found”，结构化结果为4对象、6条finding：ai-color-palette×2、low-contrast×1、flat-type-hierarchy×1、skipped-heading×1、nested-cards×1。低对比是有效发现，已经修复并逐主题复验；图片类型端口颜色、次数步进器边界为误报，全页字号及隐藏启动失败标题不属于More目标。修复后未重新启动overlay进行第二次可视扫描。

风险边界：合成触控点击后移按钮有效，未使用实体触屏；未对大图压力、损坏媒体或完整产品运行全量回归。未将这些未测项描述为通过。

实际验证：单/多来源、空状态、长标题；280/320/390/1280px窗口；排序、原图预览、Esc回焦、输入增长回缩、思考折叠及键盘选择；OpenAI→显式google-image能力→OpenAI模型切换；七主题。placeholder最终对比：paper5.33、light6.35、dark6.85、pro8.50、pink6.82、glass-light6.23、glass-dark8.82。

专项测试记录（未做全量）：
- 参数主流程、紧凑布局、溢出、参考图：首轮20/20。
- image-assistant 与 reference-gallery-lazy：首轮31/32；唯一失败为旧“双来源共行”布局断言，更新为每来源横排并保留限高/完整预览断言后，定向复测1/1。
- 最后 compact5 与 thinking-controls4 均通过；新增模型切换用例的受控供应商夹具起初漏配thinking profile，导致等待超时；补齐真实能力配置后，overflow最终2/2通过（包含三列、间距、输入增长、思考34px和切换显隐）。
- 最新 compact-reference2/2通过；JS语法及git diff --check通过。未把原始失败覆盖或描述成一次全绿。

截图：.scratch/parameter-ui/more-single-1280-paper.png、more-multi-280-paper.png、a-final-thinking-paper-off.png、a-final-thinking-paper-280.png。截图来自真实浏览器运行本地源码与隔离数据；未触发用户真实生成请求。

Questions skipped: 最终优先问题0项，少于3项；本轮已完成授权范围内的修正。
