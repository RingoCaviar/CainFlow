# CainFlow v3.2.7 + 预览图 / Tab 切换修复补丁

## 说明

本包基于 CainFlow 官方 v3.2.7，额外应用了预览图显示与 tab 切换结果恢复修复。

## 官方 v3.2.7 已包含的改动

- 修复图片生成节点参数下拉菜单显示不全的问题（CSS + 空字符串默认值）
- 修复预览节点部分布局问题（`.node-preview` 样式）
- TTAPI OpenAI 请求参数构建调整

## 本补丁额外修复的问题

### 问题 1：ImageGenerate 完成后 ImagePreview 预览空白

**现象**：`ImageGenerate → ImagePreview` 工作流运行时，ImageGenerate 成功生成图片，但 ImagePreview 节点预览空白，点击预览可看大图。

**根因**：v3.2.7 只把图片推送到 runtime 沙盒中的下游节点，没有同步到主画布。主画布 ImagePreview 仍必须等自身执行完成才能显示。

### 问题 2：切换工作流 tab 后运行结果不显示

**现象**：包含 ImagePreview、ImageSave、ImageCompare 节点的工作流在后台运行完成后，切换回该工作流，所有节点结果空白。

**根因**：
- ImagePreview / ImageSave 的 runtime 图片保存到 IndexedDB 是后台 fire-and-forget，可能在 snapshot 合并进 `tab.data` 前尚未完成。
- ImageCompare 的运行结果完全没有进入 `tab.data`：既没保存到 IndexedDB，也没序列化 `compareImageA/B`。

## 修改文件

| 文件 | 修改内容 |
|------|----------|
| `js/features/workflow/workflow-runtime-manager.js` | ① ImageGenerate 完成后立即同步主画布下游 ImagePreview/ImageSave；② runtime 中 `syncImagePreviewNode` / `syncImageSaveNode` 改为 `await` 保存到 IndexedDB；③ runtime `syncImageCompareNode` 把对比图 B 持久化到 IndexedDB；④ `serializeRuntimeNode` 序列化 ImageCompare 的 `compareImageA/B` 与 assetKey。 |
| `js/nodes/node-lifecycle.js` | 单图恢复条件 `canonicalImageCount > 1` 改为 `> 0`。 |
| `js/features/media/display-image-renderer.js` | 缩略图生成失败时回退到原图。 |

## 测试建议

1. 启动后访问 `http://127.0.0.1:8767`，强制刷新浏览器（Ctrl+F5）。
2. 测试预览修复：运行 `ImageGenerate → ImagePreview`，确认生成完成后预览节点立即显示图片。
3. 测试 tab 切换修复：创建两个工作流，一个包含 `ImageGenerate → ImagePreview → ImageSave → ImageCompare`，运行过程中切换到另一个工作流，等运行完成后再切回，确认所有节点结果都正常显示。
