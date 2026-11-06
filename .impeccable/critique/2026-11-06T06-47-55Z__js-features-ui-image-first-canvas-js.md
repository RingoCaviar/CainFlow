---
target: 参数面板单行底栏与输入边框
total_score: 30
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
target_identity: "file:D:\\mygithub\\CainFlow\\js\\features\\ui\\image-first-canvas.js"
target_fingerprint: "sha256:8a5b9c37d0c76e484908a2e42bbb2337c6bd93fc21f0679983627175728959ef"
target_path: "D:\\mygithub\\CainFlow\\js\\features\\ui\\image-first-canvas.js"
timestamp: 2026-11-06T06-47-55Z
slug: js-features-ui-image-first-canvas-js
---
Method: dual-agent (A: single_row_critique_a · B: single_row_audit_b)

# 节点参数浮层：单行底栏与输入边框复查

用户约束：设置控件只使用最下面一行，窄屏也不换行；文本输入框边框可弱化但不能消失。目标 js/features/ui/image-first-canvas.js，关联 css/features/image-first-canvas.css。

完成：取消窄屏底栏换行规则；依据控件容器宽度收起长摘要，显示“参数”“模型”，完整值保留在title、ARIA及选单内。主操作与次数持续可见。提示词恢复主题输入底色和1px弱边框，6px 8px内距。底栏高度仍统一34px、同类设置等宽、间距8px。

## Critique：30/40

| 启发式 | 分数/4 | 证据 |
|---|---:|---|
| 状态可见 | 3 | 宽屏摘要和生成次数可见，窄屏摘要收起 |
| 用户语言 | 3 | 中文入口清楚，宽屏自动摘要仍依赖上下文 |
| 用户控制 | 3 | Esc关闭并返回入口，保留原生文本编辑 |
| 一致性 | 4 | 底栏统一34px高度和上下边缘 |
| 错误预防 | 3 | 次数与生成×N一致，配置和执行分开 |
| 识别优于记忆 | 2 | 窄屏完整设置需展开；评审发现的尺寸命名已改为参数 |
| 效率与灵活性 | 3 | 高频操作直达，键盘路径保留 |
| 简洁美观 | 4 | 提示词到单行底栏，层次清楚 |
| 错误恢复 | 3 | 源码保留错误详情与取消，未触发真实生成失败 |
| 帮助说明 | 2 | 完整值依赖title/ARIA/菜单，未新增说明行 |
| 合计 | 30/40 | 聚焦本轮参数浮层 |

设计特征：适配CainFlow画布创作的Operate界面。输入与执行两层明确，通过紧凑入口维持单行，不缩小文字或隐藏次数和生成。主题输入边框给出编辑范围，整体平静。

认知负担：底栏四个操作组，菜单三个分组，负担低。窄屏收起摘要带来一次展开成本。情绪路径：输入边界和焦点提供确定感，菜单位置稳定且Esc可退，生成×N有助于执行前确认；未评价真实完成和失败反馈。

Persona：熟练创作者可直接调整次数和模型；首次用户的窄屏入口已由尺寸改为参数，以涵盖参考图与高级设置；键盘与窄窗口用户在320px和手动280px仍可达全部控件。

## Audit：17/20

| 维度 | 分数/4 | 证据与限制 |
|---|---:|---|
| 无障碍 | 3 | Enter入菜单、Esc回焦、2px焦点轮廓；未运行读屏软件 |
| 性能 | 4 | 本轮CSS和标签变化未增加资源加载或发现卡顿；未做性能基准 |
| 主题 | 3 | 浅色与玻璃深色截图边框可辨；非全部主题对比度认证 |
| 响应式 | 3 | 320/390/1280同排无溢出；未测物理触屏和200%文字 |
| 实现完整性 | 4 | 单行、输入边框和同类尺寸均符合明确约束 |

唯一剩余优先问题：P2，34px高与次数24×32px加减目标低于44px舒适触控建议；满足24px最低目标尺寸，不能直接认定WCAG AA失败。可后续用impeccable adapt研究coarse pointer命中区，不改变用户指定单行布局。本轮没有P0/P1；命名P3已修复。

实测：宽屏面板560px、设置入口174px；390视口面板366px、入口77px；320视口面板296px、入口42px。四控件均34px且同top。通过实际宽度手柄Home缩至280px，两个入口各34px仍可读无重叠。长模型名宽屏截断且完整ARIA保留；长提示词六行后框内滚动。提示词计算边框1px solid，亮色alpha约0.181且截图可辨。命名最后改为参数后，父代理重新截图并确认1280/390布局未变化。

检测器：CLI exit0，结果[]；真实Chrome新tab完成脚本注入并显示overlay。Console汇总4 anti-patterns，明细6条/5类，不视为六个独立缺陷：全局版本号small.logo-version的2.7:1为范围外低对比候选；端口紫色/type accent不属本轮；全局字号层级不能判定此表单失败；启动失败隐藏模板heading不属当前页面；次数stepper是复合控件，不是嵌套内容卡片。

验证：node --test --test-concurrency=2 tests/image-parameter-compact-app-browser.test.mjs tests/image-parameter-overflow-app-browser.test.mjs tests/image-first-canvas-app-browser.test.mjs tests/image-first-canvas-gestures-app-browser.test.mjs，19/19通过，新增320/390/1280同排、等高、无重叠/溢出、可见输入边框断言。JS语法和git diff --check通过。用户要求不执行全量，已遵循；未生成、未修改真实用户数据。
