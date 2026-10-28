# 图片优先画布实施验收

实施基点为 `f8c2301`，正式规格为本地 `image-first-canvas#005`，按 #006–#019 顺序交付。测试使用隔离工作流和媒体存储、真实应用、受控模型响应；没有调用计费模型。父规格和独立原型保持原样。

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

`agent-image-first-workflow-app-browser` 的五项真实应用场景覆盖框内入口的原生命中、已有草稿和附件、明确 @ 目标后切换选择、参数未挂载、混合旧参考口和完整批次、应用/重复应用/单次撤销/仅恢复图的重做、失败重试、重新生成、保存重开和变化依赖拒绝。五个逻辑原图位置与三种相同像素传输去重分别核对；相同资产的不同来源位置仍能分别加入附件。

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

性能诊断证实每帧插入高亮清理的空class写，会触发所有图片卡片的摘要与输入刷新。正式修复保留真实高亮切换和真实状态更新，仅跳过无变化通知；坐标/尺寸变化只定位当前面板，同值文字不替换DOM。40项连接纯回归、13项正式/公开组件浏览器回归通过，固定窗口无trace对照恢复至78.2FPS（旧基线73.2），p95 48.60ms（旧基线48.80）。语义完整的视口变量隔离实验未改善p95，因此未加入正式代码。后续同值视口DOM写也有独立回归修复；加入同值SVG保护后的末次正式结果为79.4FPS/p95 42.10ms，原绝对合同仍未通过，不以平均帧率改善冒充p95通过。

最终style invalidation追踪记录确认，离屏路径每帧反复写入相同的空`d`，以及共享SVG层反复写相同transform；这些是记录的写入栈，不是由flush调用位置推断。修复仅跳过同值写，完整400路径、真实离屏清空/回屏恢复和真实视口变换均保持。公开renderer回归先红804次重复写，修复后为零；相关79项纯回归通过。追踪计数不代表耗时占比，473MB追踪与追踪期开销没有作为正式性能数据；末次无trace原生样例保持相同固定窗口/GPU/负载，79.4FPS、p95 42.10ms、22个长帧，仍未通过16.7ms合同。

320×240窗口实际命中检查发现置顶切换入口遮挡顶部“更多”，已将其层级改为工具栏下方、参数/助手modeless窗口上方。七主题工具栏及两项批量输入共3项通过，窄低窗口/50%缩放1项通过。批量模式测试明确检查Esc先收起当前参数面，再退出批量模式，单次图撤销/重做断言保留。

容量用例改为正式旧工作流文件加载（会话缓存按合同剥离内嵌原图，不作为旧文件迁移入口），四图恢复及A/B实际上传后，发现保留连线删除漏校验通用输入容量。现仅在删除的投影预检启用统一输入策略：协议上限5张时，4+1+1展开为6张会整次拒绝，真实toast及全部节点/连接/扩展JSON完全不变。复制、克隆和旧关系恢复保留默认兼容行为，不被新模型约束强行拒绝。32项相关纯测试及4项真实保留删除/多桥/撤销重做通过。
