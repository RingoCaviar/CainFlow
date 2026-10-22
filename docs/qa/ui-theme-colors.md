# 七主题配色回归（theme-color-audit#001）

## 已复现与修复

| 界面 | 修复前 | 修复方式 |
| --- | --- | --- |
| Agent `@节点` | 菜单透明；深色系列文字对比度约 1:1；选中轮廓丢失 | 使用不透底的菜单表面、主题文字和可见的选中／焦点标记 |
| Agent 模型、参考图及消息 | 部分选中背景使用未定义的 `accent-subtle`；链接和焦点混用填充色 | 采用现有活动背景和新的可读文字语义色 |
| 协议编辑器 | 浅色主题仍显示黑色面板、输入框及渐变，深色文字无法辨认 | 面板、参数、节点预览、请求预览和保存状态统一使用语义颜色 |
| 协议按钮 | 独立样式文件给全站按钮覆盖颜色 | 将协议按钮颜色限定在协议面板，保留既有公共尺寸规则 |
| 历史、缓存、统计、日志 | dark／paper 部分空状态和说明对比度约 3.0–4.14:1 | 对应文字从装饰性弱色改为可读的次级文字色 |
| 更新通知 | Paper 的取消按钮对比度约 1.20:1 | 通知组件统一负责按钮普通、悬停、焦点、禁用颜色，删除主题补丁 |
| 主操作按钮 | pro、glass-light、glass-dark、pink 的部分渐变端点不足 4.5:1 | 运行／主按钮使用已验证的主题主操作填充色和配套文字色；保留边框、阴影、尺寸 |

## 自动检查

- `tests/theme-color-audit-browser.test.mjs`：完整应用启动，调用真实 Agent 节点提及模块，打开真实模型菜单和协议编辑器，连续切换七主题；主面板按真实按钮逐个打开。
- 检查文字对比度、Agent 菜单不透底、选中标记、640px 窗口下菜单边界及点击命中、协议保存状态、通知按钮普通／悬停／焦点。协议使用 1700px 窗口，Agent 使用 300px 面板。
- `tests/fixtures/primary-action-theme-surface.html`：同一共享按钮皮肤下检查七主题填充文字对比度；有渐变时逐端点检查。
- 源码护栏拒绝重新引入这次失效的颜色变量、协议全局按钮颜色及通知按钮主题补丁。
- 图片结果预览矩阵从三主题扩展到七主题，分别检查 300px 与 612px 面板的打开、缩放、切图、关闭和节点状态保持。
- 继续运行已有设置／菜单／节点七主题视觉回归、面板互斥、Agent 方案与参考图、全屏拖动、绘制输出及键盘相关测试。

普通文字阈值为 4.5:1，大字为 3:1。主面板自动扫描按祖先背景逐层合成透明色；非均匀背景不冒充精确自动结果，配合现有专项视觉矩阵和截图检查。禁用控件、图像内容及装饰性颜色不作为正文对比度失败处理。

## 重现与截图

```powershell
$env:CAINFLOW_QA_SCREENSHOT_DIR = Join-Path $PWD '.scratch/theme-color-audit/after'
node --test tests/theme-color-audit-browser.test.mjs
node --test tests/prompt-agent-result-preview-browser.test.mjs tests/fullscreen-preview-drag-browser.test.mjs
```

截图使用隔离数据库和受控模型配置，不发送生成请求。当前本地证据：

- Agent：[修复前](../../.scratch/theme-color-audit/before/agent-dark.png)／[修复后](../../.scratch/theme-color-audit/after/agent-dark.png)。
- 协议编辑器：[修复前](../../.scratch/theme-color-audit/before/protocol-light.png)／[修复后](../../.scratch/theme-color-audit/after/protocol-light.png)；两图窗口宽度不同，用于比较配色，不作布局像素基线。
- 窄窗口菜单：[Pink](../../.scratch/theme-color-audit/after/model-narrow-pink.png)。

上述 `.scratch` 证据仅保留在本地，可用命令重新生成；未更新既有截图基线以掩盖差异。图片查看器的黑底、绘制棋盘和颜色滑条光谱保持原用途。本轮不修改协议编辑器原有窄窗口布局。

## 本轮结果

全量 Node 回归使用 `--test-concurrency=4`：1128 项中 1126 通过、2 项原有可选跳过、0 失败；排除了依赖仓库默认模板内容的 `default-workflow-neutral`，因为本地 `Default.json` 是用户工作数据。最终截图专项 4 项通过，`git diff --check` 通过。本轮未改动本地工作流、未更新版本号、未提交或发布。

## Agent 联网与选择菜单补充（theme-color-audit#002）

原“联网方式”仍使用系统下拉，其展开项没有纳入上一轮自定义模型菜单验证。本轮用真实应用回归先断言该入口使用统一主题菜单；修复前在这一断言失败，修复后覆盖七主题实时切换、640px 视口与 300px Agent 面板、实际点击命中、选项文字 4.5:1 及焦点 3:1。透明菜单按面板叠加画布的实际背景计算。

- 联网方式、模型、命令、节点提及及参考图菜单外壳对齐公共菜单语义色、边框、圆角和阴影；选择按钮统一箭头。
- `tests/prompt-agent-menu-theme-browser.test.mjs` 验证 End/Enter 选择只产生一次 change、关闭联网禁用专用模型、Esc 逐层关闭并恢复焦点、程序恢复不产生 change、失效模型不回退、销毁时无残留并恢复 select 属性。
- 既有搜索 fixture 覆盖工作流恢复、clear 保留设置、模型动态删除与恢复；菜单交互 fixture 覆盖方向键、Tab、外部点击、关闭清理和长名称。面板协调、全画布方案、共享预览回归继续运行。
- 隔离数据和受控模型，不发起付费生成。用户本地 Default.json 不修改，不运行要求它等于仓库模板的测试。

截图可用以下命令重建：

```powershell
$env:CAINFLOW_QA_SCREENSHOT_DIR = '.scratch/theme-color-audit/agent-menus-after'
node --test tests/prompt-agent-menu-theme-browser.test.mjs
Remove-Item Env:CAINFLOW_QA_SCREENSHOT_DIR
```

代表性截图：[Pink](../../.scratch/theme-color-audit/agent-menus-after/network-pink.png)、[Dark](../../.scratch/theme-color-audit/agent-menus-after/network-dark.png)、[Glass light](../../.scratch/theme-color-audit/agent-menus-after/network-glass-light.png)。本地截图不纳入版本控制。

最终全量 Node 回归：1129 项，1127 通过、2 项原有跳过、0 失败（排除用户 Default 模板一致性测试），日志 `.scratch/theme-color-audit/agent-menus-all-node.log`。最初专项中的退出流程断言曾在并发运行失败，独立重跑及最终全量均通过，未修改退出业务或放宽断言。最终截图专项通过，`git diff --check` 通过；Default.json SHA256 保持 `8C66604BD5937A7F4A9DA03E20CCBCBBB18CED63C511CC1EFD72710DCE1BBACD`。
