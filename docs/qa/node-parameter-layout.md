# 节点参数浮层排版优化验收

日期：2026-11-05。依据：用户确认的 shape 简报；Operate 模式；范围为九类既有图片节点共用浮层，文本及视频的内嵌参数入口保留。

## 实现

- 独立节点名称标题行与统一 SVG 工具；中段滚动，次数和执行动作固定在右下底栏。
- 模型入口全宽，提示词正文 14px；普通自动高度 5–8 行、放大 8–14 行，低于等于 540px 的视口使用 3–4 行。手动保存高度继续优先。
- 优化提示词为独立次级操作行，随内容自然滚动；长内容不被操作条覆盖。
- 全部既有浮层共享字号、间距及控件边界；窄内容区字段改单列。缩放模式和滑轨改用当前主题语义角色。
- 工具栏收起时回收高度；指针位于可见参数浮层内时不触发工具栏 peek。显式显示工具栏仍避让。生图较高浮层可在节点下方限高滚动；处理节点保留视口内可用空间。
- 复用原控件与来源规则，保留图几何、批次、草稿、手动尺寸、Agent 共存与真实运行反馈。

## 视觉证据

真实隔离应用捕获七主题、九类节点、模型与高级设置、放大模式、360×420 和 640×480。证据在本地 `.scratch/parameter-ui/review/`，最终裁切预览在 `.scratch/parameter-ui/final/desktop.png`。临时浏览器与后端由既有测试助手回收，不调用付费模型。

独立 impeccable finish reviewer 首轮指出底栏居中、低窗口编辑区过小、缩放旧配色三项问题；修正后逐项判定 resolved，最终视觉 disposition 为 ship。此结论不代表全量测试通过。组件规范已同步 `DESIGN.md` 和 `.impeccable/design.json`。

## 自动验证

全量入口：`node scripts/run-tests.mjs --mode full`，未指定基线，检查当时的工作树。完整初轮记录：`.scratch/parameter-ui/full-tests.log`。

- fast：1203 项通过；integration：5 项通过；Python：294 项通过。
- browser：第一批 497 项中 485 通过、10 失败、2 跳过；第二批 122 项全部通过。首轮命令退出非零，原始失败未删除或用复测覆盖。
- 失败涉及上游提示词优化入口、后台相机执行、放大及锚定、七主题综合链路、旧版紧凑布局、滚动与处理节点。已修正实际布局问题；旧布局断言按确认简报改为固定头尾、右侧操作和更大的编辑区。保持控件身份、真实请求、批次和图数据断言。原来按隐藏工具栏完整高度避让的断言改为可见工具栏；另保留真实显示工具栏的独立测试。
- 原生鼠标操作在目标进入可视区后验证命中；短窗口计数操作等待启动 toast 自然结束；锚点稳定允许 0.5px 子像素排版误差。未增加重试、延长超时或跳过失败。
- 对初轮全部失败所属文件和新增布局检查，以最终源码统一复测；最终结果另见下节。没有把本轮记录表述为全量绿灯。

最终静态检查：`git diff --check`、两个修改 JS 的 `node --check`、YAML/JSON 解析通过。设计 hook 对修改的 CSS 无确定性问题。

## 最终影响范围复测

命令采用 `node --test --test-concurrency=2`，文件列表为：

- `agent-image-first-preparation-app-browser.test.mjs`
- `camera-image-first-app-browser.test.mjs`
- `expanded-image-parameter-ui-app-browser.test.mjs`
- `expanded-parameters-agent-app-browser.test.mjs`
- `image-first-canvas-app-browser.test.mjs`
- `image-first-integrated-app-browser.test.mjs`
- `image-parameter-compact-app-browser.test.mjs`
- `image-parameter-overflow-app-browser.test.mjs`
- `processing-image-card-app-browser.test.mjs`

完整结果：`.scratch/parameter-ui/final-affected-tests.log`。最终 26 项全部通过，0 失败、0 跳过，耗时约 174 秒，命令退出码 0。该复测覆盖首轮全部 10 项失败所属文件及新增布局检查；最终树没有再次运行整套全量，因此不宣称最终全量通过。


## Live 追加：生成结果去白边

2026-11-05：用户在 Live 指定“图片周围不要有白色描边”，并反馈预览没有实际效果。原因是运行时生成的图片节点不在静态 HTML 内，预览未正确挂载。已删除本轮临时变体，直接修正正式组件样式并刷新当前页面确认。

作用范围仅为带有可见结果原图的 ImageGenerate 卡片：去除图片外侧内边距及卡片底色，未选中时边框透明；图片保持原始比例、原图及轻圆角。空状态、其他类型节点、主题选择边框和键盘焦点行为保留。未重写用户工作流内容，未发起生成。

实际页面证据：`.scratch/parameter-ui/live-borderless.png`。专项命令：`node --test --test-concurrency=2 tests/image-preview-batch-app-browser.test.mjs tests/image-first-integrated-app-browser.test.mjs`，5 项全部通过、0 失败/跳过，约 79 秒。结果：`.scratch/parameter-ui/live-borderless-tests.log`。本次没有重新全量。

## Live 追加：视角节点只保留缩略图

2026-11-05：按用户指定，CameraControl 的角度与输入摘要迁入其参数浮层；画布上的原“编辑视角”按钮隐藏，由浮层底部的既有入口继续委托原编辑器。卡片只展示快照（无快照时保留必要空状态），移除外侧留白、背景与未选中边框。保留端口、选择提示、原编辑器、克隆只读权限、参数持久化和后台执行身份。

当前页面已刷新并点击缩略图确认参数浮层可达，证据：`.scratch/parameter-ui/live-camera-thumbnail.png`。动态节点的静态变体预览不能安全挂载，本轮已明确重置该预览并直接修改正式组件；未留下临时变体或复制的用户媒体。

`camera-image-card-app-browser`、`camera-image-first-app-browser`、`image-parameter-compact-app-browser` 三文件共 10 项通过，0 失败/跳过。记录：`.scratch/parameter-ui/live-camera-thumbnail-tests.log`。另在相机卡片原测试中追加缩略图无按钮、卡片无参数摘要、摘要确实位于参数浮层的断言；结果见 `.scratch/parameter-ui/live-camera-thumbnail-regression.log`。本次未重新全量。

## Live 追加：图片导入节点只保留缩略图

2026-11-05：用户对图片导入节点要求“如法炮制”。已把原始选择文件按钮和原始尺寸控件迁入其参数浮层，保留文件输入、拖放及 URL 预览身份；缩略图移除框体底色、留白与未选中边框。上传模式显示文件操作，URL 模式显示原链接字段；不新增图片副本或改写源图片。

真实页面点击缩略图已核验，证据：`.scratch/parameter-ui/live-import-thumbnail.png`。`image-import-preview-card-app-browser`、`image-import-preview-gestures-app-browser`、`image-parameter-compact-app-browser`、`image-first-integrated-app-browser` 共 9 项通过，0 失败/跳过，约 79 秒。结果：`.scratch/parameter-ui/live-import-thumbnail-tests.log`。新增相机缩略图断言复测 3/3 通过：`.scratch/parameter-ui/live-camera-thumbnail-regression.log`。本次未重新全量。

### Live：背景与浮层锚定最终规则

- 所有节点移除装饰边框；图片节点保留主题底色，空白区域不透出画布网格。此前透明背景方案已撤回。
- 图片导入浮层省略标题条，保留关闭按钮；上传 / URL 切换居中。
- 普通参数浮层按实际渲染宽度对齐节点中心，只有视口边缘触发水平限制。始终向节点下方锚定，底部触边后停止下移，不再自动翻到节点上方；展开窗口仍可独立拖动。
- `live-below-anchor-tests.log`：4 个文件，12 / 12 通过，覆盖居中、底部钳制、滚动、展开与导入原控件复用。
- 全量回归 `live-all-borderless-full.log` 的 fast、integration、Python 已通过；浏览器存在失败，原始记录保留，修正后的定向复查另记，不能将本轮全量标记为全绿。
- Live 开发脚本仅在 8767 页面加载，避免覆盖隔离浏览器测试；退出 Live 时须移除此临时注入。

### Live：统一无标题布局

用户进一步要求所有图片参数浮层不显示标题栏、右上角放大和关闭按钮。生图提示词置顶，模型入口、设置与展开明细集中下方；原表单、语义名称与底部执行控件保留。此规则覆盖此前标题固定可达和模型入口在前的视觉断言。截图：`.scratch/parameter-ui/live-titleless-bottom-settings.png`。

定向复查 `live-final-followups.log` 为 11 项中 10 项通过；有效设置持久化与窄屏缩放菜单已通过，另有运行中节点取消按钮命中超时尚未通过，不能宣称全部回归完成。

- 最新无标题布局定向检查 `live-titleless-final-tests.log`：6 / 6 通过（共享定位、窄屏滚动、九类表单及草稿保留）；图片导入专用的居中和控件复用检查在 `live-titleless-settings-tests.log` 中通过。旧布局中标题可见、右上角按钮可达的断言已按用户最新要求更新。

### Live：文本节点无边框

文本节点取消输入内框、装饰阴影和双层内距，保留主题不透明底色与原生编辑控件。选中标题浮于卡片上方；正文 14px/1.65，12px 内距。截图 `.scratch/parameter-ui/live-text-borderless-final.png`。

- 文本表面与共享控件定向检查 `live-text-borderless-tests.log`：2 / 2 通过。
- 底部限制后先按 Esc 收起浮层、再操作节点取消按钮；出错后重新打开参数查看完整错误。`live-cancel-boundary-final.log`：1 / 1 通过，覆盖原生短按保护、长按取消、失败详情与原输出清理。
- 最终全量检查已启动，记录为 `live-final-full.log`，结果以该日志为准。

- 结果卡片工具栏也可能被底部限制的浮层覆盖；通过 Esc 收起后进行原生点击。`live-result-slots-dismiss.log`：1 / 1 通过，验证相同原图的不同槽位分别加入与同槽位幂等。

### 文本节点高度反馈修复

复现：选中文本节点，重复按下缩放手柄、触发零距离移动并松开。旧实现高度序列为 550、842、1134…3762px。浮动标题与铺满节点的绝对定位端口被误算为堆叠内容；最小尺寸测量现在排除脱离文档流的标题、端口，不改变正文或已保存尺寸。

`text-height-fixed.log` 复现回归通过；`text-height-regression.log` 7 / 7；`text-height-resize-tests.log` 15 / 15。覆盖节点最小尺寸、文本高度反馈、边缘缩放、生成进度与原表单保存。已变长且保存的用户尺寸不会被自动猜测和覆盖。

### 提交检查记录（parameter-ui#001）

文本节点单击选择、拖动移动、双击编辑，Enter/F2 进入编辑、Esc/失焦退出；规范已同步。原生交互及共享表单回归 `text-selection-regression.log`：4/4。高度反馈与缩放定向共 22 项通过。

最近已结束全量 `text-height-full-check.log`：fast、integration、Python 通过；浏览器第一批 485 通过、14 失败、2 跳过，第二批 122/122。失败包含已取消的放大/标题入口断言，以及图片原生操作可达性和预览缩放检查；尚未全部处理。该全量早于最后的选择编辑修复，不能视为最终版本全绿。关联本地 Issue 保持 open。

### 生图参数集中到底部单行（2026-11-06）

主视图移除提示词标题和“让助手优化”入口，保留可访问名称。底栏仅保留参数入口、紧凑模型选择和生成；参考图、尺寸、高级参数与次数复用原控件进入二级选单。使用原生 popover 并接入 surface coordinator，Esc 先关选单。新检查覆盖底栏顺序、参数修改保留、切换节点与 360px 窄窗口边界：`footer-submenu-tests.log` 1/1；导入复用回归 `footer-import-regression.log` 4/4。全量记录 `footer-full-check.log`，尚未完成，不宣称全绿。此前针对已移除的助手按钮及旧参数行的断言需随新规范调整。

### 二级选单逻辑修复（2026-11-06）

- 原生鼠标点击模型/供应商下拉会关闭外层菜单：node-select 现在声明所属参数选单为 parent，保留嵌套菜单生命周期。
- 模型页面关闭再打开为空：选单入口改为选择页面，不把重复打开解释为取消页面。
- 选单打开时缩小窗口越界：定位逻辑与外层浮层统一调度，先更新可用宽高，再读取尺寸并限制位置。

三条故障分别先跑失败回归，再修改到通过。`submenu-fixes-final.log` 8/8（真实点击、重开、缩窗、参数保存与浮层行为）；`submenu-coordination-regression.log` 8/8（共享协调与导入）。原有单行布局检查也改为真实鼠标点击入口，避免程序化 click 与尚未完成的选择动画帧竞争。独立 Standards/Spec 复审未发现新的阻塞问题。全量 `submenu-fixes-full.log` 已启动，尚未结束，不表示全绿。

### 底栏入口反馈（2026-11-06）

模型入口支持再次点击关闭；入口重开仍保留模型字段。尺寸入口从“参数”改为当前比例 · 分辨率，空值/auto 为“自动”，自定义显示宽 × 高。popover 改由 coordinator 统一关闭，避免原生自动关闭先于 click 导致菜单重新开启。新增真实点击与摘要变化检查先失败后通过；独立复审确认，模型/供应商、重开、摘要相关 3 项独立重跑通过。页面截图 footer-size-summary.png。

### 尺寸摘要入口直达尺寸设置

按用户反馈，底栏比例与分辨率入口每次打开固定进入 size 页面；即使此前浏览参考图，关闭重开仍显示尺寸设置。保留再次点击关闭、模型入口及选单内页面切换。真实鼠标检查先红后绿，覆盖首次打开与从参考页重开，页面截图 size-entry-direct.png。

### 共用下拉菜单裁切修复

原节点下拉列表在参数选单滚动区内绝对定位，会被 overflow 裁切。共用 node-select 现在保留原 DOM 与主题继承，用 manual popover 顶层显示并按视口空间选择向上/下展开；限制列表高度并允许内部滚动，关闭时清理窗口和滚动监听。覆盖比例、分辨率，模型与供应商亦复用同机制。真实鼠标回归验证末项可点击及嵌套菜单，独立复审与两项独立重跑通过。截图 dropdown-unclipped.png。

### 移除助手按钮后的测试迁移

回归不再查找已删除的 image-node-assistant 或 image-prompt-actions。旧按钮专属自动带入、重复点击幂等用例替换为：按钮不存在、编辑不自动打开 Agent/发送请求、独立 Agent 草稿和附件保持不变。仍有效的多来源参考图、Text 来源修改、Camera 只读保护、明确目标授权、显式断开、撤销重做测试从顶部 Agent 入口进入，并通过真实 @ 候选列表选择节点，保留原有业务断言。

`agent-entry-migration-final.log`：两个文件，7/7 通过，无跳过。独立复审确认未丢失上述业务语义覆盖。全量需以迁移后的新运行结果为准。

### 提示词 2–6 行自动高度

移除设置待生成的展示行，保留 generationRevision 业务状态。提示词按 scrollHeight 在 2–6 行之间伸缩，超过六行只在框内滚动；禁用手动拖高，旧保存高度不绕过上限。用 height:0 测量内容，避免 textarea rows 固有高度阻止缩回两行。新增测试验证旧400px高度、短文、四行、12/20行上限及删短后缩回，先失败再通过。

`prompt-rows-final.log`：11/11；`prompt-status-regression.log`：1/1，确认参数修订保存与重载语义不受展示行删除影响。页面截图 prompt-two-six-lines.png。


### 全量旧测试迁移与独立问题排查（2026-11-06）

迁移旧助手按钮、不可见的放大面板入口、手动提示词高度和待生成展示行断言，保留参数持久化、真实请求、原图身份、连接顺序、撤销重做与独立 Agent 草稿/附件检查。Agent 通过顶部入口和真实 @ 候选授权；dirty 状态直接检查持久化数据，不依赖已删除的展示标签。底栏模型入口为左对齐标签，预览字形居中检查只针对相应操作按钮。

原生文本撤销及画布历史隔离独立通过。参考图预览关闭后，等模态层解除再恢复参考页和原缩略图焦点，并在执行前后检查工作流与节点身份。测试等待实际焦点恢复，覆盖第 16 项和重排后的焦点。

另修复运行锁误禁用纯页面切换按钮的问题：页签仍可浏览，参数与连接编辑继续锁定。七主题真实运行保持、焦点、参考图滚动和 Agent 共存链路通过。已展开 node-select 的窗口变化定位安排在父浮层重排之后，关闭时取消待执行帧；展开宽高比/分辨率后缩小窗口的真实点击检查通过。

最终全量日志：`.scratch/parameter-ui/complete-full-regression.log`。结果以该轮结束后的汇总为准。


全量曾额外揭示两类测试问题，均单独处理：未生成/无历史配方的旧节点应精确断言 generationRevision 缺失，不能混同生成成功后的 dirty:false；两个主题辅助函数在 Windows 上可能因 Chrome 子进程仍占用临时 profile 而以 EPERM 清理失败。异步清理现在只对临时文件占用有限重试，最终仍报错。原始失败保存在 complete-full-regression.log；最终提交依据使用后续冻结代码的新全量记录。


引用语义测试在每次显式生成前等待自动保存完成，避免将保存时序与引用语义混在同一用例中；此调整不宣称修复产品并发保存。实际观察到的立即再次生成 409 与本地请求超时另记 `parameter-ui#002` 待分诊。搜索图 fixture 改为 MutationObserver 等待真实图片状态变化，保留缩略图失败回退、原图预览和导入断言；连续 5 次独立通过。


### 测试本地连接隔离

多轮完整计划中观察到不同用例的本地 API 连接超时，单独整组复跑均通过；单并发仍出现，不能仅归因于并发。保留原始 TAP 诊断（full-tap-regression.log），不重试业务请求、不放宽超时或断言。测试 Chrome 显式使用 --no-proxy-server，临时后端经已有 factory 绑定 127.0.0.1，子进程的 NO_PROXY/no_proxy 追加回环地址。产品默认绑定、外部代理配置与父进程环境不变。最终验证以隔离后的完整计划为准。


### 本轮交付状态：未提交，等待完整全绿（2026-11-06）

已完成规范迁移及参考图焦点修复，补充了参考菜单展开与定位完成的等待；保留所有引用批次、编号、撤销重做和真实生成断言。Agent 顺序整组 7/7、Camera 两文件整组 8/8、状态及主题组合 28/28 均有独立通过记录。规范与需求复核未发现阻塞代码问题。

最终完整通过条件仍未满足，不能将独立重跑合并成全量通过。完整计划的失败原始记录保留于 frozen-full-regression.log、full-tap-regression.log、isolated-full-regression.log、verified-full-regression.log。最新 reference-popup-layout-ready.log 中，菜单跨列布局与通用输入检查通过，但另一个用例的本地 media-assets POST 报 net::ERR_NO_BUFFER_SPACE（无 HTTP 响应），使自动保存等待失败；先前亦多次记录本地连接超时。测试 Chrome 代理和回环绑定隔离后仍发生，不能宣称代理为根因。提交保持待定，需要恢复稳定测试环境后，按 docs/testing.md 对最终工作树重新完成一次全量。没有跳过用例、重试业务请求或用独立重跑替换全量失败。


### 用户明确要求提交当前版本（2026-11-06）

在告知全量尚未通过、本地 API 存在 ERR_NO_BUFFER_SPACE 与连接超时后，用户明确要求“提交”。本次按该指令提交当前改动，保留以上失败记录，不标记全量通过或发布就绪。parameter-ui#001 的最终全量验收仍未完成，Issue 保持 open；保存竞态另见 parameter-ui#002。
