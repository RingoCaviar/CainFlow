# 电商套图折叠图位的生成入口

2026-11-18，以下根因与建议依据修复前源码调研。实现已将场景操作行移至编辑区后的同级位置，并调整焦点恢复；未修改节点执行、方案或公共画布能力。

## 结论与影响范围

问题来自自定义场景图位的 DOM 层级：其「生成方案」和「确认并生图／生成图片」位于 `.commerce-image-set-shot-editor` 内；折叠直接设置 editor.hidden，所以两个入口一同消失。普通预设图位使用摘要区内的图标按钮，已有折叠入口。[图位模板](../../js/nodes/commerce-image-set-view.js#L305)、[折叠逻辑](../../js/nodes/commerce-image-set-view.js#L403)

| 图位类型 | 现有折叠行为 | 本次建议 |
| --- | --- | --- |
| 主副图内的生成型预设图位 | 摘要区保留重新规划、生成／重试图标 | 保留行为，加入回归断言 |
| 详情图内的预设图位，如详情首屏、核心卖点说明 | 与主副图共用模板，已有图标入口 | 同上 |
| 主副图或详情图内新增的自定义场景 | 删除、取消属于摘要区；规划、生图属于编辑区，折叠后隐藏 | 把既有操作行移出折叠编辑区 |
| 沿用第一张参考图的预设主图 | 不显示规划、生图按钮 | 保留原图语义 |

类型和分组由方案层定义；`gallery` 与 `detail` 均支持自定义场景，共用 `makeShotRow`，无需为详情图写另一套组件。[预设与详情图](../../js/features/ecommerce-image-set/commerce-image-set-plan.js#L40)、[自定义场景](../../js/features/ecommerce-image-set/commerce-image-set-plan.js#L171)、[分组渲染](../../js/nodes/commerce-image-set-view.js#L442)

这里的卡片实际位于电商套图的节点参数浮层。画布节点本体由 `renderCommerceImageSetBody` 输出；浮层调用 `createCommerceImageSetView`。[节点本体入口](../../js/nodes/node-view-factory.js#L1267)、[浮层入口](../../js/features/ui/image-first-canvas.js#L1108)。术语按 [CONTEXT.md](../../CONTEXT.md) 的「节点参数浮层」「电商套图方案」。

## 推荐最小修改

1. 将 `.commerce-image-set-scene-actions` 整段移至 editor 外、与 editor 同级，建议位于摘要和编辑区之间。保持每个图位仅一组实际按钮，保留 `data-commerce-action` 和现有行级按钮引用。这样不必维护两套同步状态或改动执行入口。[现有模板和引用](../../js/nodes/commerce-image-set-view.js#L339)
2. 沿用现有状态逻辑：未规划时仅提供生成方案；有方案后显示确认并生图；确认后显示生成图片或重新生成图片。运行、定稿、参考图不就绪等状态继续沿用 disabled 条件。用户需求理解为折叠不隐藏本来可见的操作，不应绕过确认或让无方案生图可执行。[状态和文案](../../js/nodes/commerce-image-set-view.js#L550)、[显式确认后运行](../../js/nodes/commerce-image-set-view.js#L960)
3. 移除取消结束后恢复焦点分支中 `(!shot.customScene || !row.editor.hidden)` 的旧布局假设，改为依据实际按钮可用性；否则折叠自定义图位仍会把焦点交还展开按钮。[焦点恢复](../../js/nodes/commerce-image-set-view.js#L583)
4. 保留按钮点击不折叠卡片的事件过滤；移位后按钮仍有 `data-commerce-action`，可复用行点击过滤和统一事件委托。[点击排除](../../js/nodes/commerce-image-set-view.js#L390)、[执行委托](../../js/nodes/commerce-image-set-view.js#L1155)
5. 现有 scene-actions 已支持换行，窄容器内按钮伸缩；优先复用，仅在视觉验证发现间距问题时改 CSS，避免扩大共享样式的测试范围。[操作行样式](../../css/features/image-first-canvas.css#L956)

这是界面入口布局修正，未新增画布读写或运行能力，也未更改字段、校验或执行逻辑，依据 [ADR-0025](../adr/0025-scoped-canvas-automation.md) 无需为此新增 Agent/MCP 工具；如实现扩大到运行语义则必须重新核对两端。

## 已有覆盖与缺口

- 普通图位已有折叠与单卡展开、操作不改变折叠状态的浏览器覆盖，尤其已完成的详情图在折叠后重新生成。[初始折叠](../../tests/ecommerce-image-set-app-browser.test.mjs#L500)、[折叠详情图重新生成](../../tests/ecommerce-image-set-app-browser.test.mjs#L740)
- 自定义场景用例同时覆盖主副图、详情图及取消、确认、生成、删除，但辅助函数会主动展开卡片后操作，不能发现折叠时入口丢失。[场景用例](../../tests/ecommerce-image-set-app-browser.test.mjs#L1370)、[主动展开](../../tests/ecommerce-image-set-app-browser.test.mjs#L1449)
- 推荐扩充同一文件的自定义场景用例：分别折叠 gallery/detail 新场景，验证生成方案可见且可点击；规划返回后保持折叠并验证确认并生图；点击后验证只触发该图位请求且不展开；运行时按钮禁用、取消可用，取消后焦点恢复到对应操作；完成后重新生成仍可用；保留定稿禁用。覆盖 390px 窄窗避免操作行溢出。[已有窄窗截图入口](../../tests/ecommerce-image-set-app-browser.test.mjs#L1527)
- 该浏览器测试已登记并直接关联 view 和相关 CSS，无需为扩充现有用例新增清单项。[测试登记](../../scripts/test-groups.json#L373)

按 [测试范围规范](../testing.md)，实现后先以本次全部改动路径执行 `scripts/check-daily.ps1 -ChangedPath ... -DryRun`，再运行选择的测试。当前工作树有其他任务修改，必须使用显式范围；本次研究未运行行为测试，也未读取或改动本地 issue。
