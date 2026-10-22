# Agent 输入确认、就近布局与消息呈现

关联本地 Issue：prompt-agent#045。

## 输入与应用边界

上下文候选供模型理解，不能仅因候选可见就创建图片导入节点。单图方案解析与多步骤方案标准化共享参考图授权判断；独立生成使用本轮附件或显式选择，历史选择需提供当前用户原话 evidence。新增 `targetSelection.mode = "none"` 表达纯文字生成；`imageRoles` 与导入步骤可提供 evidence。画布节点的选中状态不等于引用授权。

`prompt-only` 保留上一版方案输入，不能用最新结果或其他候选替换。原有 latest/explicit 续改规则保持。多步骤方案拒绝未使用或未确认的导入步骤；明确导入素材本身可以是独立目的。独立生成重用已有节点时将旧图片输入显式加入断开清单。

回复阶段只构造方案；完整应用中的旧 promptPlan 转换到 canvasPlan 批量应用路径，导入、连线和自动保存均受原子提交与撤销管理。会话升级保留 runs，不推断或更换已保存历史资产；缺失旧输入仍显示可操作的错误。

## 定位接口

`nodeBounds(node, zoom)` 将实际尺寸统一为画布单位；`findNearbyNodePosition({x,y,width,height,occupied,gap})` 在矩形边缘候选中选择离目标最近且不碰撞的位置，不修改已有节点。默认节点间避让 40、生成与保存的理想水平间隔 80。Agent 按依赖定位新步骤，公共保存入口使用同一算法。面板避让采用实测二维矩形。

## 呈现接口

`renderAgentBody({documentRef,body,text,sources})` 是普通回复、历史恢复与联网引用的共同正文入口。它仅创建固定标签与文本节点，不执行 HTML；`normalizeAgentBodyText` 是展示兼容处理，不改写持久化原文。仅明确的转义换行及列表前 `/n` 被修复，代码、URL、路径与歧义内容保持原样。

界面借鉴 [Vercel AI Elements](https://vercel.com/academy/ai-sdk/ai-elements) 的消息与操作分层，未引入 React 或第三方组件库。用户消息轻背景、Agent 正文无重复外框；方案按实际输入、步骤、折叠细节与操作呈现。逐步模型与参数按需展开，底部两个全局模型选择器始终可见。沿用七主题语义色及公共菜单适配器。

## 面板不透明规则

普通主题的 Agent 外壳通过语义变量 `--surface-panel-underlay` 提供不透明底层，避免画布内容透入；glass-light 与 glass-dark 在主题调色板将该底层设为透明，保留原玻璃表面。不增加主题专用组件选择器。

## 平面按钮

Agent 内及所属浮层按钮使用纯色表面、边框与 outline 焦点，不使用渐变、外发光、内阴影或按压缩放；主次操作保留语义颜色区分。浮层外壳仍可保留层级阴影，顶部应用工具栏不在本次调整范围。
