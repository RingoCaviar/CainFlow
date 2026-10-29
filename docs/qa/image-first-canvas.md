# 图片优先画布实施验收

原型设计依据为 `f8c2301`，正式实施基线为 `48f9e7f`，正式规格为本地 `image-first-canvas#005`，按 #006–#019 顺序交付。测试使用隔离工作流和媒体存储、真实应用、受控模型响应；没有调用计费模型。父规格和独立原型保持原样。

组件现统一称为“节点参数浮层”，普通与放大模式属于同一组件；以下历史验收记录中的“参数面板”“参数浮窗”“下方参数”等旧称均指该组件，原记录保留。

## 已交付切片

| 任务 | 交付与证据 |
| --- | --- |
| #006 | 生图参数使用原控件和节点数据，关闭面板、后台执行、保存重开一致。 |
| #007 | 图片主体卡片、选中浮标题、原控件下方面板、稳定预览区；已有尺寸和坐标保留。 |
| #008 | 生图通用输入解析到真实逻辑用途；容量、占位、运行锁及正反向拖线新建保持原子性。 |
| #009 | 紧凑参考管理保留全部来源、批次、缺失槽位、排序及原图身份；浏览索引不改变输出。 |
| #010 | 导入和预览迁移；URL 与上传草稿互不冒充，预览输出完整批次。 |
| #011 | 缩放和颜色节点保留原控件及专用交互；真实图片尺寸、编码和像素验收通过。 |
| #012 | 对比保留 B 必需、A 可选；真实交换、撤销与像素输出一致。修复后台绑定遗漏导致部分节点未准备的问题。 |
| #013 | 多图合一按数字输入槽位合并完整批次；移动保留连接 ID、扩展属性、批次与原图。 |
| #014 | 保存节点保留图片、视频独立输入输出及真实文件保存；修复 Blob 持久化和完整视频媒体引用。 |
| #015 | 保留原 Three.js 编辑器、五参数和两种视图；真实 WebGL 首图像素、相机文本请求、慢网与后台同 ID 隔离通过。 |
| #016 | 参数原表单放大、拖动、双向调整与还原；普通宽度偏好独立。参数和 Agent 保留草稿、原图附件、手动模型及进行中的请求，可交替置顶和找回。 |
| #017 | Agent 使用真实提示词来源及完整有序原图；隐藏参数能力、旧参考迁移顺序、连接身份和只读保护修复，应用/撤销/重试/重生成闭环通过。 |
| #018 | 本轮等待/重试清旧结果与错误、真实进度、原取消及完整错误详情；有效配置待生成摘要、后台同 ID 隔离、未知 JSON 与旧尺寸保护。 |

每个切片的实际命令、结果和边界记录在对应本地任务 Resolution。参数与媒体读取不依赖当前是否选中或控件是否在文档中；通用口仅为展示，保存图仍使用规范端口。

## 重开资源连接回归

视角保存重开验收揭示 Python 3.13 默认五个监听排队连接不足：真实浏览器一批 CSS、脚本和 API 请求收到 `ERR_CONNECTION_REFUSED`，导致连接投影无法恢复。真实服务 128 并发请求复现失败；将正式服务监听队列显式设为 128 后，全部请求成功，连续三次浏览器重开保留样式、可测端口和保存图。

回归入口为 `tests/startup-reload-app-browser.test.mjs`，每次导航只尝试一次，没有通过延时或重试隐藏资源错误。

## 浮窗、菜单和焦点

`tests/expanded-parameters-agent-app-browser.test.mjs` 在正式应用中覆盖原控件身份、跨节点编辑、宽度保存重开、原生拖动和双向调整、完全遮挡后的入口命中、真实请求进行时的草稿和附件保留、原生文字撤销、模态遮罩和分层 Escape，以及 360×420 窗口和 50% 画布缩放。普通面板保持节点下方锚点，仍由用户手动平移画布。

模型菜单继续使用共享菜单层，位于通知之上、真实模态之下。面板几何变化不触发窗口栈的全量扫描；参数、Agent 及置顶入口内的快捷键不误删或撤销画布节点。既有主面板两视口 42 对互斥组合、模态、裁剪与子菜单回归继续保留。思考设置的旧测试入口随正式控件迁入参数面板，实际对话与图片请求断言不变。

## Agent 输入与原子应用

`agent-image-first-workflow-app-browser` 的六项真实应用场景覆盖框内入口的原生命中、已有草稿和附件、明确 @ 目标后切换选择、参数未挂载、混合旧参考口和完整批次、应用/重复应用/单次撤销/仅恢复图的重做、失败重试、重新生成、保存重开和变化依赖拒绝。五个逻辑原图位置与三种相同像素传输去重分别核对；相同资产的不同来源位置仍能分别加入附件。

有有效上游 Text 时，空草稿同时明确引用生图目标和真实 Text 来源，预览显示真实修改对象；Camera、克隆或不支持编辑的来源保持只读。修改无效本地稿或暗中断开提示词输入会被拒绝。用户明确要求断开特定目标的提示词输入时，仍可在一个原子操作中改用本地稿，撤销恢复原边和本地稿，重做不执行。新增有效提示词元数据遵守已有分段文本读取上限。

参考图完整复述复用原连接 ID、逻辑端口、显式顺序、JSON 扩展和数组位置；漏列来源不授权清空。停用来源可原位保留，不能借此新增或重排停用输入。旧端口继续使用既有规范化和去重适配，但混合旧端口的显式顺序不再无谓重编号。

`agent-typed-media-plans-app-browser` 两项验证真实 B-only Compare 和 video-only Save。视频通过原生 VP8 编码和受控 Veo 进入正式媒体存储，检查实际导出文件哈希、播放器、任务身份及明确保存后的持久 owner。缺 B 或媒体输入的计划保持原图不变。恢复旧校验条件会在真实界面拒绝合法 B-only 方案，恢复修复后通过。

图片参考容量由实际声明协议决定，完整批次先收集再校验。`image-generation-reference-capacity` 在请求预览和公开 runner→真实 execution core→受控供应商两条入口验证容量 70 下完整有序的 65 张输入，容量 64 拒绝时不丢图；视频与文本对话继续保留原有聚合限制。没有沿用原型固定容量或截断批次。

## 媒体兼容边界

Preview 和 Merge 的历史文档分类与正式持久 owner 行为不完全一致。本轮遵守功能保留要求，继续保留正式恢复及所有权行为，不新增媒体 owner 类型。缺失原图不使用其他批次位置的图片替代。

页面重开、真实后端进程重启和桌面 GPU 性能分别验证、分别记录，不能互相替代。完整 A01–A36、七主题、性能、最终全套回归与双轴审查在 #019 汇总。

## 运行状态与待生成设置

真实生成验收覆盖新按钮、右键及顶部入口、必要上游、缓存、锁定输入来源编辑和原两秒取消。卡片短原因至多两行，详情与参数面板保留全文；没有真实进度时不伪造数字。完整成功确认实际输入配方后才解除待生成，部分成功、失败、取消及后台其他工作流不误清。协议模块加载恢复不会产生瞬态误标。

`image-generation-status-dirty-app-browser`、`image-generation-feedback-ui-app-browser`、`image-generation-description-dirty-app-browser` 通过正式请求检查参数、原图字节、描述与保存重开；revision公开执行与协议测试补足竞态和同ID协议覆盖边界。最终该组35项通过。

`node-persistence-extensions` 的7项纯合同及真实应用回归验证未知 JSON 的 own `__proto__`、假值、数组、节点/工作流/canvas扩展在后台保存、复制及撤销重做后保留。当前字段仍由正式writer负责，已清旧结果不回生，旧应用级模型/密钥不导出。旧手调260×220生图与280×210颜色卡片保持实际尺寸。

## #019 验收映射

下表是逐项证据索引，不表示运行了整个测试套件。`*-app-browser` 通过正式应用及隔离服务验证；特别标明的公开组件场景只证明该组件合同，纯模块测试补充请求解析、原子性及竞态边界。#010–#018 的已验收证据继续有效；本轮新增跨类型流程、七主题截图、真实后端进程重启及分环境性能的最终运行结果由 #019 收口时补录。

| 标准 | 已有具体入口及断言 | #019 补充与结论边界 |
| --- | --- | --- |
| A01 九类卡片与端口 | [导入/预览卡片](../../tests/image-import-preview-card-app-browser.test.mjs)、[缩放/颜色卡片](../../tests/processing-image-card-app-browser.test.mjs)、[对比卡片](../../tests/compare-image-card-app-browser.test.mjs)、[合并卡片](../../tests/merge-image-card-app-browser.test.mjs)、[保存卡片](../../tests/save-image-card-app-browser.test.mjs)、[视角卡片](../../tests/camera-image-card-app-browser.test.mjs)：真实原控件、单入口、独立输出与原几何。 | [跨类型流程](../../tests/image-first-integrated-app-browser.test.mjs) 同图核对九类与未迁移 Text/Video/CustomParams，最终两项通过。 |
| A02 完整图、占位及稳定批次 | [生图卡片](../../tests/image-assistant-app-browser.test.mjs) 的 content-first/result actions；[完整批次浏览](../../tests/image-preview-batch-app-browser.test.mjs) 第一项；[反馈操作命中](../../tests/image-generation-feedback-ui-app-browser.test.mjs) 第二项。 | 真实结果原图、索引及操作命中与几何均有断言；七主题35张最终状态截图已汇总。 |
| A03 图片与专用手势 | [卡片原生拖动/单击/双击](../../tests/image-first-canvas-gestures-app-browser.test.mjs)、[导入/预览手势](../../tests/image-import-preview-gestures-app-browser.test.mjs)、[处理吸管优先](../../tests/processing-image-card-app-browser.test.mjs) 第三项、[对比分界](../../tests/compare-image-card-app-browser.test.mjs) 第二项、[保存原生视频](../../tests/save-image-first-app-browser.test.mjs) 第三项。 | 各专用表面保留原行为，不由通用卡片点击替代。 |
| A04 单参数面与选择/导航 | [单参数面与同 ID 工作流](../../tests/image-first-canvas-app-browser.test.mjs) 两项；[放大后的画布导航](../../tests/expanded-parameters-agent-app-browser.test.mjs) 第一、四项。 | 断言原控件身份、选择切换、关闭、缩放及图几何；不以自动移动画布通过。 |
| A05 普通宽高、低缩放 | [普通面宽度与保存](../../tests/image-first-canvas-app-browser.test.mjs) 第一项；[窄低窗口与 50% 缩放](../../tests/expanded-parameters-agent-app-browser.test.mjs) 第四项；[窄面错误全文](../../tests/image-generation-feedback-ui-app-browser.test.mjs) 第一项。 | 普通锚点允许出视野，临时限宽不覆盖全局偏好。 |
| A06 放大、拖动、调整、还原 | [放大完整流程](../../tests/expanded-parameters-agent-app-browser.test.mjs) 第一项；[拖动/取消清理](../../tests/expanded-image-parameter-ui-app-browser.test.mjs) 三项。 | 包含原生移动及宽高改变；lostpointercapture 的补充是事件注入，未冒称 UA 自发事件。 |
| A07 Agent 共存与层级 | [重叠及挂起真实请求](../../tests/expanded-parameters-agent-app-browser.test.mjs) 第二项；第三项覆盖菜单、真实模态及 Escape；[原协调合同](../../tests/surface-coordinator-browser.test.mjs)。 | 两方草稿、原图附件、模型和请求保留；完全遮挡入口以 actual hit 验证。 |
| A08 框内优化与单组展开 | [原生框内优化](../../tests/agent-image-first-workflow-app-browser.test.mjs) 第二项；[参数/高级设置与重开](../../tests/image-assistant-app-browser.test.mjs) 前三项。 | 编辑不自动执行；旧布局断言已改为可见参数分组入口。 |
| A09 适用参数与未挂载读取 | [真实参数请求和重开](../../tests/image-assistant-app-browser.test.mjs) content-first/advanced；[真实处理参数](../../tests/processing-image-first-app-browser.test.mjs)；[未挂载尺寸请求](../../tests/image-generation-size.test.mjs) 最后一项；[思考设置真实请求](../../tests/thinking-controls-browser.test.mjs)；[协议待生成边界](../../tests/image-generation-revision-protocol.test.mjs)；[原生异步图片恢复](../../tests/image-async-resume-app-browser.test.mjs)。 | 异步恢复使用正式注册协议，创建/停止/保存重开后仅轮询原任务，校验真实 PNG 哈希和隐式第 0 项；不以一种模型的字段证明全部接口能力。 |
| A10 上游提示词与覆盖优先级 | [有效源与本地草稿](../../tests/image-assistant-app-browser.test.mjs) connected prompt；[真实 Text/派生 Camera 来源](../../tests/agent-image-first-workflow-app-browser.test.mjs) 第四项；[尺寸/参数请求构建](../../tests/image-generation-size.test.mjs)、[思考适配](../../tests/thinking-config.test.mjs) 为辅助合同。 | 保留既有请求构建顺序，无新的深合并权威。 |
| A11 自动逻辑用途与拒绝 | [通用输入路由](../../tests/universal-input-connection-app-browser.test.mjs)、[批量通用接线](../../tests/universal-input-batch-app-browser.test.mjs)、[保存双角色](../../tests/save-image-first-app-browser.test.mjs) 第一项；[策略完整类型](../../tests/universal-input-policy.test.mjs)。 | [跨类型流程](../../tests/image-first-integrated-app-browser.test.mjs) 继续核对实际 Text/Camera/Params 载荷。 |
| A12 对比 A/B 与交换 | [对比真实接线/交换/缺 B/后台](../../tests/compare-image-first-app-browser.test.mjs) 四项；[Agent B-only](../../tests/agent-typed-media-plans-app-browser.test.mjs) 第一项。 | 交换改真实端点、保连接身份并一步撤销；A 可空。 |
| A13 合并完整有序批次 | [稀疏数字输入、移动、替换、编辑历史及后台](../../tests/merge-image-first-app-browser.test.mjs) 四项；[浏览与重开](../../tests/merge-image-card-app-browser.test.mjs) 第二项。 | 完整来源批次不缩为所浏览图片；持久 owner 不改型。 |
| A14 主图消费与各自批次 | [缩放/颜色一次主图处理](../../tests/processing-image-first-app-browser.test.mjs) 第二项、[对比主图输出](../../tests/compare-image-first-app-browser.test.mjs)、[保存完整图片及视频](../../tests/save-image-first-app-browser.test.mjs) 第三项。 | [跨类型流程](../../tests/image-first-integrated-app-browser.test.mjs) 补同一真实图上的像素/批次检查。 |
| A15 新旧遮罩区别 | [新遮罩上游变多图、旧多图首图兼容](../../tests/universal-input-execution-app-browser.test.mjs) 第一、三项；[纯策略及保存资格](../../tests/universal-input-policy.test.mjs)。 | 原边和原批次保留，新连接不凭保存重开获得旧兼容资格。 |
| A16 完整容量与缺失原图 | [真实协议容量](../../tests/universal-input-execution-app-browser.test.mjs) 第二项；[65 图公开 runner 请求](../../tests/image-generation-reference-capacity.test.mjs)；[缺失首槽浏览](../../tests/image-preview-batch-app-browser.test.mjs) 第二项。 | 65 图测试是公开 runner→真实 core→受控请求辅助证据，不冒称 UI 拖入 65 图。 |
| A17 双向新建及真实输出 | [拖线新建](../../tests/connection-create-app-browser.test.mjs) 正向、反向、动态输出及成功撤销；[保存反向视频用途](../../tests/save-image-first-app-browser.test.mjs) 前两项；[视角新建](../../tests/camera-image-first-app-browser.test.mjs) 第一项。 | 创建与连接单次历史提交，redo 不执行。 |
| A18 提交前守卫与取消 | [新建失败/放弃/来源变动](../../tests/connection-create-app-browser.test.mjs)；[通用拒绝原图不变](../../tests/universal-input-connection-app-browser.test.mjs)；[策略循环/容量/运行锁](../../tests/universal-input-policy.test.mjs)。 | 纯策略补足难经 UI 穷举的拒绝组合。 |
| A19 明细、原位替换与图一致 | [明确替换](../../tests/universal-input-connection-app-browser.test.mjs) 第二项；[对比](../../tests/compare-image-first-app-browser.test.mjs) 第一项、[合并](../../tests/merge-image-first-app-browser.test.mjs) 第二项、[保存](../../tests/save-image-first-app-browser.test.mjs) 第一项；[参考顺序真实请求](../../tests/image-assistant-app-browser.test.mjs) reference source moves。 | 来源、规范角色、完整数量与保存图同时校验。 |
| A20 紧凑参考与管理 | [参考完整组/排序/定位/断开](../../tests/image-assistant-app-browser.test.mjs) reference overview/reference source moves/many reference sources/reordering legacy；[懒缩略图](../../tests/reference-gallery-lazy-app-browser.test.mjs)。 | 懒缩略图用例明确是正式浏览器中的公开组件合同。 |
| A21 停用、同像素身份与缺槽 | [停用有效编号](../../tests/image-assistant-app-browser.test.mjs) disabled reference sources；[相同像素不同槽](../../tests/agent-image-first-workflow-app-browser.test.mjs) 第一、三项；[缺失原图位置](../../tests/image-preview-batch-app-browser.test.mjs) 第二项。 | 像素传输可去重，来源/输出/位置身份分别保留。 |
| A22 浏览只改索引、保留未更新图 | [预览完整批次](../../tests/image-preview-batch-app-browser.test.mjs)、[断输入保留](../../tests/image-preview-retention-app-browser.test.mjs)、[合并浏览](../../tests/merge-image-card-app-browser.test.mjs) 第二项、[对比缺 B](../../tests/compare-image-first-app-browser.test.mjs) 第三项。 | 首次无结果不造图，已保留结果标为未更新。 |
| A23 优化只准备明确引用 | [原生框内准备与草稿保留](../../tests/agent-image-first-preparation-app-browser.test.mjs) 三项；[切换选择不改明确目标](../../tests/agent-image-first-workflow-app-browser.test.mjs) 第二项。 | 不自动发送、选模型、应用或接线。 |
| A24 优化真实上游来源 | [真实 Text 改写与 Camera 只读拒绝](../../tests/agent-image-first-workflow-app-browser.test.mjs) 第四项；[明确授权断开](../../tests/agent-image-first-workflow-app-browser.test.mjs) 第五项。 | 预览显示实际修改节点，不能修改无效本地稿冒充生效。 |
| A25 Agent 全流程参考与失效 | [混合旧口完整批次](../../tests/agent-image-first-workflow-app-browser.test.mjs) 第三项；[旧完整创作](../../tests/image-assistant-app-browser.test.mjs) selected-node optimization/partial Agent retries。 | 真实请求、保存图、原图身份、重试和依赖改变均核对。 |
| A26 Agent 原子保存/撤销/执行 | [现代方案完整流程](../../tests/agent-image-first-workflow-app-browser.test.mjs) 第三、五项；[有类型媒体计划](../../tests/agent-typed-media-plans-app-browser.test.mjs)；[失败回滚辅助合同](../../tests/prompt-agent-canvas-plan.test.mjs)。 | 仅应用、应用执行和执行范围分别断言，redo 只恢复图。 |
| A27 运行入口、缓存与取消 | [范围与真实入口](../../tests/image-assistant-app-browser.test.mjs) node run-to-here；[原生两秒取消](../../tests/image-generation-feedback-ui-app-browser.test.mjs) 第四项；[重试/顶部停止](../../tests/image-generation-status-dirty-app-browser.test.mjs) 第三项。 | 取消未落入 disabled 参数字段集；无卡片底部运行/日志恢复。 |
| A28 本轮状态、真实进度与错误全文 | [等待、自动重试及范围外错误](../../tests/image-generation-status-dirty-app-browser.test.mjs) 第一、三项；[短原因、完整错误与部分完成](../../tests/image-generation-feedback-ui-app-browser.test.mjs)；[API 脱敏保全文](../../tests/api-client-detail-sanitization.test.mjs)。 | 无真实进度时无数值；部分完成不冒充全部成功。 |
| A29 待生成与可信配置 | [真实设置/引用/后台配方](../../tests/image-generation-status-dirty-app-browser.test.mjs) 第二、四、五项；[描述改动真实请求](../../tests/image-generation-description-dirty-app-browser.test.mjs)；[配方生命周期](../../tests/image-generation-revision.test.mjs) 为辅助。 | 当前摘要标为当前设置，加载与纯展示不伪造历史配方。 |
| A30 旧状态、尺寸与打开不改写 | [未知 JSON/旧实物尺寸](../../tests/node-persistence-extensions-app-browser.test.mjs) 两项；[旧自动高度与编辑高度](../../tests/image-generate-restored-height-browser.test.mjs)、[克隆尺寸](../../tests/image-first-clone-app-browser.test.mjs)；[64 图仅打开](../../tests/image-merge-memory-app-browser.test.mjs) 第二项逐字核对原文件不改写。 | [跨类型流程](../../tests/image-first-integrated-app-browser.test.mjs) 补同图标题/启用/折叠/克隆/任务/草稿，跨类型两项通过。 |
| A31 旧逻辑口、顺序及扩展 | [混合旧参考口精确身份](../../tests/agent-image-first-workflow-app-browser.test.mjs) 第三项；[稀疏合并](../../tests/merge-image-first-app-browser.test.mjs)、[对比 A/B](../../tests/compare-image-first-app-browser.test.mjs)、[保存双角色](../../tests/save-image-first-app-browser.test.mjs)；[未知扩展](../../tests/node-persistence-extensions-app-browser.test.mjs)。 | 保存规范端点不写 auto；已有兼容迁移仍按原资格规则运行。 |
| A32 后台身份与未挂载参数 | [同 ID 参数面](../../tests/image-first-canvas-app-browser.test.mjs) 第二项；[后台处理](../../tests/processing-image-first-app-browser.test.mjs) 第四项、[后台保存](../../tests/save-image-first-app-browser.test.mjs) 第四项、[后台视角](../../tests/camera-image-first-app-browser.test.mjs) 第四项、[后台待生成](../../tests/image-generation-status-dirty-app-browser.test.mjs) 第五项。 | 各类型分别核对 A 的结果和 B 的字段，未依赖当前选中节点。 |
| A33 编辑历史、剪贴板与运行锁 | [真实画布编辑参考图](../../tests/canvas-edit-reference-app-browser.test.mjs) 含携外连、跨工作流同 ID、普通/保留删除、clone、完整批次、缓存清理及运行端点；[合并稀疏编辑](../../tests/merge-image-first-app-browser.test.mjs) 第三项。 | 保留原同工作流外连权限，不按相同 ID 跨图重绑。 |
| A34 媒体所有权及真实进程重启 | [所有权转换](../../tests/workflow-media-ownership-commit.test.mjs)、[会话撤销](../../tests/session-undo-media-ownership.test.mjs)、[独立剪贴板保护](../../tests/canvas-edit-reference-app-browser.test.mjs) clipboard originals 为辅助；[真实重启](../../tests/image-first-restart-app-browser.test.mjs) 使用同目录、同 origin、新服务 PID。 | 真实后端两次重启与后台媒体完成栅栏均通过；刷新、存储对象重建及进程重启分别记录，不承诺重启撤销栈。 |
| A35 七主题/窄低/焦点/模态 | [旧七主题键盘对比度](../../tests/image-assistant-app-browser.test.mjs) seven themes；[真实重叠/模态/低视口](../../tests/expanded-parameters-agent-app-browser.test.mjs)；[跨类型七主题截图](../../tests/image-first-integrated-app-browser.test.mjs)。 | 新7主题各状态已生成35张最终截图与清单；覆盖普通、放大、重叠、窄低窗口50%缩放，旧局部测试不替代该矩阵。 |
| A36 原性能合同与媒体预算 | [既有 200/400 正式应用样例](../../tests/image-assistant-performance-browser.test.mjs)；[Merge 释放/恢复预算](../../tests/image-merge-memory-budget.test.mjs)、[64 原图懒读与文件不改写](../../tests/image-merge-memory-app-browser.test.mjs)、[参考懒缩略图](../../tests/reference-gallery-lazy-app-browser.test.mjs)、[批次懒导航](../../tests/image-preview-batch-app-browser.test.mjs) 第三项。 | 原预算每次最多恢复 4 节点；桌面 WebView2/GPU 与无 GPU 同环境基线结果由主验收分别录入，不新增性能门槛。 |

## #019 桥接与媒体预算审计

已迁移类型通过原控件及对应节点状态读取参数：生图 `readImageGenerationSettings`、缩放 `readImageResizeSettings`、颜色 `readColorResetConfig`、保存 `readImageSaveFilename` 均有执行和序列化消费者。节点内控件查询与 `parameterRoot` 查询仍服务于同一原 DOM 的挂载/停放，不是一套独立表单或另一份权威图。后台执行的 detached document 适配仍有实际消费者。未迁移 Text、Video 和 CustomParams 的读取继续保留。全局 `closeModal` 与 `showLogDetail` 仍由真实错误模态按钮及日志条目使用，不能当作无消费者桥接删除。本次只清理显示内存管理器中无消费者的旧 imports，没有扩大迁移范围。

Merge 原先在执行完成后受到结果保护，却未进入显示内存管理器；64 图公开浏览器合同实际读了整批原图，真实工作流的全局刷新还在没有下游消费者时无谓读取完整输出。本轮将 Merge 接入既有离屏释放与每次最多 4 节点恢复预算；普通卡片只保当前一张临时预览，离屏清除该缓存与 DOM，当前缺失槽位不取后图替代。节点持久完整 `mediaAssetKeys`、顺序、数量及所有权保持，公开完整输出/明确整批原图操作仍读取完整批次。真实正式应用另以 64 个独立 PNG 资产验证只打开文件只读取选中资产，原工作流文件逐字不变。

本片定向结果：Merge 新预算/懒读 5 项、原 Merge 媒体状态 7 项和处理参数 8 项通过；Merge 正式流程 6 项、Preview 保留 2 项及参考懒缩略图 1 项共 9 项通过；批次导航 3 项通过；所有权、会话撤销、持久展示、生成缓存及 lifecycle 62 项通过。恢复预算还覆盖没有冗余 `imageCount` 的旧引用列表。软释放保留当前预览和导航事件，真正离屏释放才清除它们；该区别有公开浏览器红绿回归，受影响 clone/粘贴/保留删除场景也单独复验通过。原生异步图片恢复 1 项通过，使用原恢复按钮及受控创建/轮询响应，没有创建替代任务。这些是定向回归记录，不是最终全套结论。

## #019 跨流程与真实重启结果

`image-first-integrated-app-browser` 的两项正式应用验收已通过：九种图片节点与Text、Video、CustomParams在同一工作流中执行；受控PNG与原生VP8经过真实请求、处理、对比、稀疏槽位合并、预览和保存，完整五图批次及视频原图身份、连接JSON扩展与顺序、原控件和卡片几何在重开后保持。七套主题逐一覆盖选择/键盘焦点、运行、失败、禁用来源、普通参考、放大、Agent重叠及360×420低窗口50%画布缩放，最终35张状态截图及manifest保存在本地任务verification/themes目录。窄卡待生成标记曾被挤为五行，实际浏览器复现后以不可收缩单行标记修复，错误摘要仍保留两行和完整详情。

`image-first-restart-app-browser` 通过真实进程退出与两次重新启动验证相同origin、data/workflows目录。末次后端PID为34196→9776→14272：后台A的四个归档PNG文件全部完成且SHA256一致，同ID工作流B的草稿及空结果未串写；A的完整批次、Compare角色、合并数字顺序、扩展JSON、持久owner、注解、几何和预览索引保持。第二次启动前移除首张原图后，缺失槽位仍为0，后图不移位、不请求供应商、不重建缺失文件。该流程发现并修复Gen恢复时无视显式浏览索引的问题；未提供索引的旧文件仍沿用末张默认值。

`image-async-resume-app-browser` 通过已注册newapi-image-async协议执行原右键运行、任务创建和挂起poll、原生顶部停止、保存重开（无自动请求）、原恢复按钮继续poll相同taskId，最终持久原图PNG哈希、任务状态、协议参数和浏览索引重开一致。恢复不创建替代任务。

## 性能记录与最终门禁状态

沿用既有200节点/400连线和连续10秒四种交互样例，未改变负载或阈值。无GPU Chrome156同条件旧基线40.5FPS、新界面40.6FPS，p95均50.00ms；该对照仅证明此环境下本次样例未见整体回退，不能代替桌面16.7ms合同。

真实桌面通过正式`backend.desktop.run_desktop`、隔离目录及原开发性能控件启动，WebView2/Edge156的WebGL renderer为ANGLE/NVIDIA GeForce RTX4080SUPER Direct3D11，未禁用GPU。固定窗口位置，停止其他浏览器工作，采样期间不截图、不轮询Python/JS桥接。修复后末次正式对照：旧基线73.2FPS、p95 48.80ms；当前79.4FPS、p95 42.10ms。初次当前平均41.9FPS的回退已定位为新增卡片observer受无变化class写触发，修复并补公开回归。最终p95仍未达到桌面≤16.7ms合同，A36不得标记通过。完整原始报告与诊断边界保留在本地任务verification/performance目录；没有证据把剩余失败归因于OS、GPU或虚拟显示器。

首次完整Node门禁于2026-10-29完成：1692项，1680通过、10失败、2项沿用原有跳过。失败涉及旧控件查询、旧容量/高度假设、投影契约及两项界面流程，逐项修复后需再验证；脚本在Node失败后停止，尚未执行其后的完整Python、媒体安全及源码smoke门禁。Windows完整显式文件列表超过命令行上限的问题已改用仓库内相对路径解决，没有减少发现的测试文件。

独立Standards/Spec双轴审查已完成，具体修复如下。#019保持进行中，父规格不修改或关闭。

## 最终审查修复

独立Standards审查确认一项状态决策重复造成的功能偏差，Spec审查确认提示词授权和异步身份两项遗漏，均补充公开回归后修复。正文“清除水印描述/替换为蓝色背景”不会授权断开提示词来源；明确关系变更仍可应用、一次撤销、重做不执行。新授权携带校验版本，无法核验的旧授权标记要求重新生成方案。明确指定的新提示词来源也可在单一目标范围内替换，不授权其他目标。

Preview与Save的已有结果投影不再被当作新输入。共享状态模块保持无输入、未更新、当前及单媒体更新的精确信息，保留原图、缺失槽位、索引和所有权，不在展示投影时重复持久化媒体。新增两项真实应用以原图与VP8验证部分更新，56项相关纯回归与原公开复现均通过。

异步尺寸读取在两个等待点核对当前节点、最新尺寸编辑和真实来源身份；替换连接、切同ID工作流或替换原图资产后，旧回调不再回写尺寸或保存。保存节点键盘浏览的慢原图读取同样绑定原节点，不能把A结果写入B。新增五项公开factory事件回归覆盖这几种竞态，相关处理参数与保存回归通过。

性能诊断证实每帧插入高亮清理的空class写，会触发所有图片卡片的摘要与输入刷新。正式修复保留真实高亮切换和真实状态更新，仅跳过无变化通知；坐标/尺寸变化只定位当前面板，同值文字不替换DOM。40项连接纯回归、13项正式/公开组件浏览器回归通过，固定窗口无trace对照恢复至78.2FPS（旧基线73.2），p95 48.60ms（旧基线48.80）。早期语义完整的视口变量隔离实验未改善p95，因此当时未加入正式代码；后续已验证并纳入的grid/zoom隔离见下文。后续同值视口DOM写也有独立回归修复；加入同值SVG保护后的末次正式结果为79.4FPS/p95 42.10ms，原绝对合同仍未通过，不以平均帧率改善冒充p95通过。

最终style invalidation追踪记录确认，离屏路径每帧反复写入相同的空`d`，以及共享SVG层反复写相同transform；这些是记录的写入栈，不是由flush调用位置推断。修复仅跳过同值写，完整400路径、真实离屏清空/回屏恢复和真实视口变换均保持。公开renderer回归先红804次重复写，修复后为零；相关79项纯回归通过。追踪计数不代表耗时占比，473MB追踪与追踪期开销没有作为正式性能数据；末次无trace原生样例保持相同固定窗口/GPU/负载，79.4FPS、p95 42.10ms、22个长帧，仍未通过16.7ms合同。

320×240窗口实际命中检查发现置顶切换入口遮挡顶部“更多”，已将其层级改为工具栏下方、参数/助手modeless窗口上方。七主题工具栏及两项批量输入共3项通过，窄低窗口/50%缩放1项通过。批量模式测试明确检查Esc先收起当前参数面，再退出批量模式，单次图撤销/重做断言保留。

容量用例改为正式旧工作流文件加载（会话缓存按合同剥离内嵌原图，不作为旧文件迁移入口），四图恢复及A/B实际上传后，发现保留连线删除漏校验通用输入容量。现仅在删除的投影预检启用统一输入策略：协议上限5张时，4+1+1展开为6张会整次拒绝，真实toast及全部节点/连接/扩展JSON完全不变。复制、克隆和旧关系恢复保留默认兼容行为，不被新模型约束强行拒绝。32项相关纯测试及4项真实保留删除/多桥/撤销重做通过。

## #019 续做：历史竞态与回归证据

上次第二轮完整回归被用户中断，进程已退出，spec reporter没有输出最终错误栈；该轮不计通过。现在使用TAP即时保留错误详情，并记录有界Network.loadingFailed与隔离服务PID/退出状态，未增加重试或放宽断言。

历史原图handoff自然复现5条仅4条，实际history POST返回500/FOREIGN KEY constraint failed。缩略图原先上传后无owner，在history提交前可能被另一批次清理删除；现上传与既有history-thumbnail owner原子建立。真实应用在首history POST前执行正式清理，修复前确定红、修复后保留5条历史及原图/草稿/明确插入/确认后连线全部断言。更新历史缩略图也使用相同保护，上传容量失败继续保留原图历史。

Standards审查补足已提交但响应丢失、并发一次成功一次失败的补偿边界：后端同锁与BEGIN IMMEDIATE内，仅当对应history ID不再引用该asset时释放owner，既有正式引用不被失败调用删除。受控丢弃已提交HTTP响应与并发更新均先红后绿；另验证不同history ID共享asset及批量释放。最终Node owner/视频回归24项、原五条history UI1项、Python storage/routes128项通过。未新增owner种类或改变GC权威。

原复制回归在整文件、重复与有限原图/历史延迟验证中未再现产品故障。永久阻塞原图会按合同阻塞撤销完成反馈；结果计数也在运行结束后才可见，两项候选均被证伪，没有凭猜测修改执行锁、预算或等待时间。两项原回归所在完整文件最终67/67通过；该证据不等于确认旧复制失败根因已修。

隔离服务端口先探测再绑定存在TOCTOU，已改内核分配端口；当前与旧基线均用相同公开initialize_runtime/create_server工厂启动，绑定后宣布实际端口，真重启沿用同origin。另以真实release CLI验证--port0公告修复红→绿。当前/旧基线HTTP与重启适配均200；同目录真实重启、128请求突发和三次刷新4项通过。主checkout原有staged删除未改动。

本轮增量双轴复核发现的owner补偿与旧基线启动兼容问题均已修复，未解决Standards问题为0；完整最终门禁及A36绝对性能仍待验证。性能工作继续使用完整200/400、原交互负载及16.7ms门槛。

## #019 样式瓶颈修复与无界面对照

最终树的分阶段原生诊断把持续慢段定位在pan/zoom样式计算，平均约37ms，Layout不足1ms、Paint约0.4ms；settings初始化和虚拟化的时间不足以解释持续成本。该轮带trace且前台/显示环境与旧样本不同，只用于定位，不计桌面验收。

单变量grid对照把三个动态dot变量从画布祖先迁到独立无子DOM的装饰层：pan Style总耗时2117.11→43.866ms，>30ms事件31→0，zoom仍约2117ms。七主题280组计算值、RGBA像素及公开viewport行为全同，另7组真实节点场景和点击命中一致。正式层使用限定class，不占用新的全局ID，旧节点ID canvas-grid继续保留；画布自己的背景cover、网格opacity、保护模式位置、端口/路径/坐标均不变。离屏镜像和旧元素包兼容保持，17项正式定向回归通过。

随后只收窄zoom变量到当前selected/batch/insert/shake消费者：zoom Style2118.661→178.037ms，>16.7ms事件34→0，最大72.074→10.027ms；pan Style40.289→44.834ms，未增加长style。选中环、标签、glow和端口反馈保持每次缩放与类激活立即更新，没有延迟到settle。原/C两侧7主题×5zoom×7state各245组视觉与坐标全同；正式回归还移除注册规则模拟旧浏览器的原继承fallback，245组均保持。相关10文件121项及新回归1项通过。

这些对照都保留200节点/400连线、原完整10秒交互预热与采样，以及每帧node/connection双投影。headless B/C整体47.4FPS/p95 66.7ms→58.9FPS/p95 16.8ms，仅作为同环境因果对照，不能替代WebView2/GPU≤16.7ms合同。固定副本、源码SHA和分段事件证据在本地verification/performance目录。

## 本地HTTP连接与退出边界

诊断捕获一次采样前ERR_NO_BUFFER_SPACE模块请求失败。本次已确定并修复的机制是静态资源连接churn：真实keepalive客户端连续24个CSS/module请求，旧HTTP1.0使用24条TCP连接，修复后HTTP1.1使用1条，字节、UTF8、MIME、CORS及cache保护全部保留。空响应补齐定界，API、代理和普通/分段下载仍显式关闭，受控上游验证先收到64KiB再完成，原流式行为保持。没有调整OS端口池或增加请求重试，也不把该证据倒推为旧复制失败的确定根因。

CLI显式退出统一既有desktop及stdlib ThreadingHTTPServer的daemon handler策略，避免空闲keepalive使server_close等待300秒。该入口退出不再等待活动handler；既有桌面策略、存储事务和恢复规则不变。空闲连接关停先红后绿；HTTP与backend定向Node6项、Python75项通过。

用户已选择先完成代码与无界面验证、稍后原生再测。前台校验未满足的原生尝试均作废，没有计入通过。本轮最终完整门禁尚待冻结后的单次执行；#019及A36继续保持未完成，父规格原文与状态不变。

## 冻结源码无GPU最终对照

正式产品源码8c5ce30与旧基线48f9e7f以同一隔离公开服务工厂、隐藏Chrome及viewport进行原200/400、原样10秒完整预热与10秒采样，采样中不轮询/截图/额外RAF。旧基线40.2FPS/p95 50.00ms、11个>50ms帧；当前58.8FPS/p95 16.80ms、0个>50ms帧。前后节点/连接计数均200/400，记录UA、viewport、DPR和源码HEAD，原始结果位于verification/performance/headless-final-source-20261029-01。该同环境无GPU结果仍不替代原生GPU合同。

## Agent撤销验收的真实完成点

首次8c5ce30完整TAP捕获Agent撤销后过早重做：session内容已还原，但异步undo-session媒体释放还在进行，正确的historyTransition互斥合并了早到请求。原样隔离确定红，公开HTTP释放屏障确认生命周期；仅移动焦点仍红，排除焦点与toast漏报。现只在原撤销按钮之后等公开Agent完成状态，再执行原断言及Ctrl+Y；未改产品互斥、timeout、焦点、重试或休眠。所有图/连接/草稿/Agent原图/执行次数与保存重开断言保留，实际完整6项通过，增量Standards与Spec均认可。

发现这一已确证等待点后，协调者终止了旧的已失败完整运行，并留下cancelled marker；该轮未计完整通过。最终将从头执行修正后的完整无界面门禁，原生验收仍按用户选择暂缓。

## 保存下游结果与会话提交的完成边界

48072fe完整Node回归共1705项，1702通过、1失败、2项原有可选跳过；包装门禁退出1，未进入后续Python、媒体安全及source smoke。唯一失败为保存流程读取session时，下游ImagePreview引用尚未出现在持久快照；保存节点自身与7个真实导出文件的批次、哈希已通过。日志为verification/final-headless-regression-48072fe.tap.log。

公开session PUT屏障稳定复现原精确断言的undefined对3keys：界面预览已解码、显示1/3且completed，视频下游显示2条，3次Preview owner请求均已200，停止按钮已禁用；只有最终session PUT被阻塞，GET仍返回旧快照。释放后原全部哈希、批次、视频播放、owner和保存重开断言通过。负对照阻塞Preview owner请求时，即使7文件已写、保存节点session已3图/2视频，预览仍running且停止按钮仍可用；释放引用后才完成，排除执行漏await。

正式测试仅在读取graph前增加一次公开session下游3keys与2videos就绪等待，原精确身份和内容断言、timeout、helper及产品行为均不变。完整保存流程4/4通过（29.04秒），单变量红绿与owner负对照记录为verification/save-forward-{put-red,put-barrier,owner-barrier}-48072fe.tap.log。最终完整门禁仍需在这一同步修正后重新执行；本轮不计通过，A36原生验收仍暂缓。

正式一行同步修正经独立Standards与Spec审查，均无待处理问题。后段预检已确认Python全套281/281通过（49.48秒）、媒体资产安全门禁退出0、source smoke通过且未打开可见浏览器；这些分段证据不冒充完整包装门禁通过。产品源码仍与8c5ce30一致，本次只改测试同步及验收记录。

## 最终无界面门禁结果（2026-10-29）

冻结测试HEAD为1638725，运行`scripts/run-local-regression.ps1 -NoPause`，北京时间12:23:35开始、12:47:05结束，整体退出0。完整日志为verification/final-headless-regression-1638725.tap.log。

| 阶段 | 实际结果 |
| --- | --- |
| 前端语法、后端编译及既有版本说明校验 | 通过。 |
| 完整Node回归 | 共1705项，1703通过、0失败、2项原有可选跳过；1311.07秒。 |
| 完整Python回归 | 281/281通过；49.50秒。 |
| 桌面安全与SQLite初始化 | 153/153通过；22.29秒。 |
| 媒体资产安全门禁 | 23组执行证据退出码均0，普通及property不变量违规均0。 |
| 源码启动smoke | 通过；仅隐藏后端，未启动可见浏览器或原生性能采样。 |
| 通用脚本的工作流样例目录校验 | 按既有逻辑跳过：workflows/regression不存在；基线48f9e7f亦无此目录，不能将脚本汇总的passed解读为实际校验过该目录。 |

两项Node跳过保持原有opt-in边界：`browser: sending without configuration gives a visible setup next step`和`browser: configured chat model completes a real conversation request`，本次未设置CAINFLOW_BROWSER_SMOKE/CAINFLOW_BROWSER_LIVE_SEND。正式图片节点、旧工作流真加载、控制响应、后台任务、跨节点完整批次及真实进程重启由本次已通过的真实应用用例覆盖，不依赖缺失的可选目录。

1638725相对8c5ce30仅有两处测试完成点同步及本文记录变化，产品源码相同，先前无GPU同环境40.2→58.8FPS、p95 50.00→16.80ms对照继续对应当前产品。独立Standards无待处理问题；Spec未发现新增实现偏差。此轮无界面门禁结束时，A36原生验收尚未进行，#019当时保持open；后续原生结果及关闭结论见下节。父#005原文及状态保持不变。

## 原生GPU验收与#019关闭（2026-10-29）

采用首轮已有有效结果，不再操作用户界面或重复测试。采样源码为a8b9b1c，与冻结1638725的产品及测试源码一致，仅此前验收文档不同，沿用上节完整门禁。通过正式backend.desktop.run_desktop启动隔离工作流与媒体目录，使用原200节点/400连线、完整10秒四种交互预热及原10秒采样；测量期间未截图、桥接轮询或追踪。

| 项目 | 已有证据 |
| --- | --- |
| 原生环境 | WebView2/Edge156，ANGLE/NVIDIA RTX4080 SUPER Direct3D11，GPU未禁用；2560×1440、100Hz。 |
| 窗口与有效性 | 固定外窗位置100/100；WebView视口1424×861、DPR1；预热前后均200节点/400连线，预热及测量前后均为本窗口前台、focused且visible。 |
| 正式面板报告 | 99.7FPS，p95 10.10ms，>50ms长帧0个。 |
| 累计投影耗时 | render-projection 116.4ms，connection-full-refresh 1300.6ms。 |
| 原合同结论 | 满足p95≤16.7ms通过线。100Hz的≤10.0ms是目标，本轮10.10ms尚未达到该目标，不将其写为达标。 |

原始证据保留在本地tracker的verification/performance：native-current-final-a8b9b1c-20261029-01.txt、同名.json和.log；该同名目录中的interaction-prelude.json、prelude-preflight.json、prelude-postflight.json及measurement-postflight.json；显示器记录native-final-display-20261029.json。数值按已有正式面板精度记录，未补造未采集的逐帧原始数据或新旧原生提升倍率。后续两个基线准备尝试均未采样，已停止并标记not-sampled，不计验收证据。

用户明确要求采用首轮结果完成记录并关闭#019；独立Spec只读复核确认该结果满足原通过线。A01–A36现有证据汇总完整，#019剩余两条验收已勾选并关闭，任务图同步为#006–#019全部closed。100Hz目标差距如实保留；父#005不修改、不关闭。本次只更新记录及任务状态，没有产品代码变更、电脑控制或重复测试。

## 节点参数浮层紧凑UI轻量验证（image-first-canvas#021，2026-10-29）

按用户确认的紧凑方案直接调整九类图片节点的正式UI：普通角落工具不占独立行，字段同行排列；生图模型与尺寸显示当前值，次数使用原控件并留在原参数表单内、靠近生成。提示词自动约3至6行并尊重手调，有效上游优先、本地原草稿折叠保留；来源替换与断开收进常显“更多”，保留原回调、用途与顺序、权限及撤销语义。未改执行或连接解析模块。

按用户要求仅作简单检查，没有控制桌面、执行全量回归或重新采样原生性能。`image-first-canvas-app-browser.test.mjs`与新增`image-parameter-compact-app-browser.test.mjs`合计3/3通过（9.50秒）：覆盖浮层切换和保存重开、九类表单打开与横向边界、原次数控件、本地草稿和有效上游切换、断开提示词不影响参考图、自动/手调高度，以及放大后主操作可达。手调高度用DOM样式变化验证，不冒充原生拖动测试。

原通用输入测试移除已取消的“次数”详情入口点击，直接使用现已常显的原控件，原连接身份/顺序及保存重开断言保持；只执行对应1项用例，1/1通过（6.46秒）。相关JavaScript语法和`git diff --check`通过。日志为本地verification/021-simple-ui-final.log和021-count-control-compat.log。

独立Standards与Spec静态审查无阻塞问题。Standards留有一项非阻塞维护建议：两处“更多”开关协调存在重复，可在以后扩展时统一，本次不扩大重构。以上为本轮轻量验证范围；前文全量与GPU结果属于之前#019的冻结版本，不作为本次紧凑UI的新性能测量。

## 六处卡片批注调整（image-first-canvas#022，2026-10-29）

导入来源摘要、保存媒体统计和原图片/视频切换控件移到节点参数浮层；保存播放器与完整图片/视频列表不变。生图横向预留从76px减为8px，完整端口名称外置，图片继续contain。删除外置状态条，将原状态、进度、失败摘要与详情控件移入节点参数浮层；原长按取消入口留在节点，仅运行时显示。共享控件查询补充参数浮层查找，保留错误清除和原执行数据规则。

仅进行相关轻量验证：首轮5项中4项通过，发现取消结束后按钮缺少display收起规则，补齐后单项通过；同轮的原公开view变更预算测试通过。保存混合媒体用例仅调整新位置选择器并明确打开节点参数浮层后通过，原完整批次、视频播放位置与DOM身份、真实文件保存、保存重开断言未删。最终共7项不同用例通过，日志见verification/022-card-ui-smoke.log、022-targeted-final.log和022-save-media-final.log；前两份日志保留修正前失败，不能称其整体通过。未重跑全量或原生性能验收。

独立静态审查指出当前选中运行节点的长按取消可能被浮层盖住，已将可见取消按钮纳入浮层避让，运行时结果操作也避开取消。只重跑对应取消用例：先选中实际运行节点，验证按钮中心真实命中原按钮，再长按取消，1/1通过（5.57秒）；日志为verification/022-selected-cancel-final.log。

## 媒体原比例预览（image-first-canvas#023，2026-10-29）

用户新批注明确替代此前固定预览高度和旧手调高度保留规则。图片/视频预览依据当前已解码媒体自然尺寸设定比例，保留节点宽度和坐标，控件另计高度；批次切换、保存媒体类型切换和手调宽度后重新适配。对比以B为主，视角节点在有实际预览图时适配，无图仍占位；视频生成节点只适配既有播放器，不新增播放器。只读DOM已有自然尺寸，不读取原图、不改变输出批次。事件及待执行帧在节点清理时移除，异工作流同ID回调校验原节点身份。

实际发现并修正旧手调节点的内联min-height阻止收高，以及320px容器仍使用66px横向留白两项布局问题。原比例仅改变预览和节点高度，原媒体与工作流扩展字段不迁移、不清空。

轻量验证：新真实应用用例1/1通过（7.07秒），涵盖八类实际图片卡片、相机无图占位、横/竖两张完整批次、窄边距、节点边界、真实拖动横向/纵向边缘及保存重开，逐项检查自然尺寸比、固定宽度与坐标、原连线；原保存混合媒体用例补充图片/视频比例检查后1/1通过（9.81秒），原完整批次、视频播放位置与DOM、真实保存文件及恢复断言保留；布局单元11/11通过（0.13秒）。最终日志为verification/023-natural-media-final.log、023-save-video-aspect.log和023-layout-unit.log；此前诊断失败日志保留。未跑全量、未操作用户桌面、未重测GPU。

两轴审查指出的边界已修正：左右手柄仅响应横向位移；对比仅允许有效B图决定比例，B失效时不回退A。原smoke补充“右手柄垂直移动不改大小”及“保留已解码A、破坏B后退出比例布局”断言，1/1通过（7.54秒）；本轮最终增量日志为verification/023-aspect-boundaries-final.log。

## 图片端口去除常显文字（image-first-canvas#024，2026-10-29）

按用户新批注替代端口完整名称常显约定：图片卡片端口只显示原圆点，名称DOM保留并用于原生悬停提示及aria-label，通用输入同样隐藏文字。现有执行错误提示不覆盖，清除后下一次悬停恢复名称；其他节点不受影响。端口容器、圆点、类型、真实连接及保存节点的图片/视频独立输出均保留。

仅执行原通用输入浏览器用例1项，补充隐藏名称、圆点与提示可用、错误提示清除后恢复名称、文本标签保持的断言；原六类真实用途、完整批次、连接身份/顺序和保存重开断言不减，1/1通过（6.43秒），日志为verification/024-port-labels.log。语法与diff检查通过，未跑全量或性能测试。

## 去掉生图重复放大按钮（image-first-canvas#025，2026-10-29）

仅在图片节点结果操作中隐藏放大按钮，并收起未选中的空操作框；共享操作执行器、Agent及历史不改。原图片手势用例增加选中/未选中按钮不可见及参考操作可见断言，保留真实拖动、返回原位拖动、单击参数、双击原图断言，1/1通过（3.59秒）。日志verification/025-preview-button.log，diff检查通过；未追加测试文件、未跑全量或性能。

## 导入浮层紧凑同行（image-first-canvas#026，2026-10-29）

只调整导入节点的浮层：切换按钮按内容定宽，去掉模式区的旧下边距，来源说明与模式、角落工具同行；URL字段在下一行完整展开。原宽度偏好、放大及控件不变。原九类浮层smoke补充上传态低于64px及URL字段切换可见性断言后1/1通过（3.91秒），其他原断言保持，日志verification/026-import-compact.log。diff检查通过，未全量或性能重测。

## 导入窄幅与按钮居中（image-first-canvas#027，2026-10-30）

按继续批注将普通导入浮层默认收至280px，并独立记住手调宽度，原其他节点宽度偏好不改。三列对称布局使上传/URL居中，来源在左、工具在右，URL字段下一行，放大规则保持。指针手调、键盘调宽及取消使用对应宽度偏好。原九类smoke补充宽度不超过300px、模式按钮与浮层中心偏移不超过1px断言，1/1通过（3.86秒），原URL模式和其他断言保持；语法与diff检查通过，日志verification/027-center-import.log。未跑全量或性能。

## 去除重复来源说明（image-first-canvas#028，2026-10-30）

按用户批注仅隐藏导入浮层的本地素材/URL来源摘要，保留居中按钮、URL字段及其他节点摘要。原九类smoke补充两种模式下摘要不可见断言后1/1通过（3.89秒），原中心、宽度、切换和其他功能断言保留。日志verification/028-import-caption.log，diff检查通过；未全量或性能重测。


## 导入浮层取消放大（image-first-canvas#029，2026-10-30）

导入节点隐藏并禁用放大入口，切换到导入节点恢复普通模式；其他类型仍支持放大。原紧凑浮层浏览器用例补充导入入口不可见、无法触发放大，以及已放大生图切换导入后恢复、再切回生图仍可放大的检查，1/1通过（3.69秒），原上传/URL及九类表单检查保留。diff检查通过，未做全量或性能测试。


## 上传浮层按内容收宽（image-first-canvas#030，2026-10-30）

上传模式以原模式按钮实际宽度加必要的对称关闭间距决定浮层宽度，不显示调宽手柄；URL模式继续使用独立宽度偏好及原输入控件。原紧凑浮层浏览器用例收紧上传宽度到不超过200px并保留居中断言，补充URL切换后恢复至少280px，1/1通过（3.97秒）。原导入模式、关闭、其他九类表单功能不改；diff检查通过，未做全量或性能测试。


## 生图摘要移入节点参数浮层（image-first-canvas#031，2026-10-30）

将生图原设置摘要、参考数量按钮及待生成标记整体移入原参数表单，卡片不再留摘要行，原刷新和参考管理入口不变。原紧凑浮层用例新增卡片无摘要、浮层含当前模型/参考数量/待生成标记断言，1/1通过（3.73秒），原提示词草稿、参考连线、九类表单检查仍通过。diff检查通过；未全量或性能测试。


## 单张结果隐藏翻页（image-first-canvas#032，2026-10-30）

生成结果仅在批次数量大于1时挂载原翻页栏，单张不占位。原批次浏览器测试3/3通过（13.38秒），包含新增单张到双张重跑后的导航恢复、翻页且完整输出仍为双张；原整批导航和缺失原图检查继续通过。diff检查通过，未做全量或性能测试。


## 移除节点折叠（image-first-canvas#033，2026-10-30）

移除所有节点折叠按钮、标题双击事件、批量折叠逻辑、折叠端口隐藏、尺寸分支和样式；序列化不再写折叠状态。恢复时剥离旧折叠字段，使用原展开高度或重新计算内容高度，文件夹及设置折叠不受影响。现有紧凑浮层用例改为九类旧折叠图片节点与旧折叠文本节点，检查展开、标题双击无折叠及保存移除字段，同时保留原参考连接/顺序与表单断言；连同原生命周期尺寸测试12/12通过（3.89秒）。语法和diff检查通过，未做全量或性能测试。


## 删除备份常驻通知（image-first-canvas#034，2026-10-30）

删除启动时注册工作流备份通知的函数、调用及专用样式，保留共享通知服务和其他通知。原通知策略浏览器检查1/1通过（0.49秒），启动模块语法和diff检查通过；未追加测试或进行全量测试。


## 生图浮层移除输入菜单（image-first-canvas#035，2026-10-30）

去掉生图设置栏输入按钮，原输入明细改随更多参数展开，其他节点设置不改。原紧凑浮层浏览器用例改从更多参数访问输入操作，补充无输入按钮断言，1/1通过（3.85秒），原提示词断开不影响参考图、原表单与顺序检查保持。diff检查通过；未做全量或性能测试。


## 生图更多参数移除连接列表（image-first-canvas#036，2026-10-30）

生图节点不再创建输入来源列表，更多参数只保留原生成设置；不修改图连接或其他节点输入管理。原紧凑浮层检查补充无输入列表、生成高级设置可见、打开前后两条连接身份保持；通过画布删除提示词来源验证本地草稿恢复且参考连接完整，相关检查1/1通过（3.78秒）。diff检查通过，未做全量或性能测试。


## 生图操作居中（image-first-canvas#037，2026-10-30）

仅为生图浮层设置底栏居中并清除次数控件的自动左外边距。原紧凑浮层检查补充次数与生成整组中心相对浮层偏差小于1px，1/1通过（3.80秒）；原次数修改、九类表单等检查保留。diff检查通过，未做全量或性能测试。


## 生图浮层去掉运行状态文字（image-first-canvas#038，2026-10-30）

仅隐藏运行状态文字并消除空反馈区占位，保留原运行状态DOM与执行更新逻辑；存在真实进度或错误时仍展示对应反馈。原紧凑浮层浏览器检查补充待运行文字不可见、无空反馈区、详情出现时反馈区可见，1/1通过（3.74秒）。diff检查通过，未做全量或性能测试。
