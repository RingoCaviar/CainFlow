---
name: debug
description: CainFlow 调试与排错指南 — 系统化的BUG定位、日志分析和状态检查流程
---

# CainFlow 调试与排错技能

## 概述

本技能定义了在 CainFlow 项目中遇到 BUG 或非预期行为时的**标准化调试流程**。
面对偶发 BUG 或不明确的错误时，请避免“盲人摸象”式的修改，请遵循「复现 → 收集 → 定位 → 验证」的系统化方法论。

---

## 第零阶段：环境就绪与 Server 管理

在开始任何 UI 或逻辑调试前，必须确保本地服务器正常运行，因为 CainFlow所有的模块（ES Modules）以及 API 代理都依赖它。

### 0.1 Server 启动状态检测
1. **检查进程**：观察当前环境或终端进程中，`python server.py` 是否已在后台运行。
2. **检查端口**：Server 默认运行在 `8767` 端口，如果没有启动，页面将无法访问或加载失败。
3. **自动启动**：一旦检测到此进程未运行，必须作为第一要务通过命令行启动服务器（建议放在后台异步执行）：
   ```powershell
   cd d:\mygithub\CainFlow
   python server.py
   ```

---

## 第一阶段：问题复现与隔离

### 1.1 明确复现路径
在尝试修复前，请先总结并记录问题的复现条件：
1. **前置状态**：空画布？加载了已有的工作流？
2. **触发动作**：导致 BUG 发生的确切操作序列（例如：拖入一张图片 -> 改变节点宽度 -> 按下 Delete）。
3. **实际表现 vs 预期表现**：系统哪里表现得不对劲？

### 1.2 注入错误嗅探器
很多 BUG 不会立刻导致页面崩溃，而是抛出未捕获的异常。
你可以使用浏览器控制台执行以下代码捕获隐藏错误，或者让 `browser_subagent` 注入并观察日志：

```javascript
window.__debugErrors = [];
window.addEventListener('error', e => {
    console.error('🍎 [Debug Error]', e.message, '\n位置:', e.filename, '行:', e.lineno);
    window.__debugErrors.push({type: 'error', evt: e});
});
window.addEventListener('unhandledrejection', e => {
    console.error('🍏 [Debug Unhandled Promise]', e.reason);
    window.__debugErrors.push({type: 'promise', evt: e});
});
```

---

## 第二阶段：全方位信息收集

不要急于看代码，先利用已有的工具和日志。

### 2.1 检查浏览器开发者工具 (DevTools)
1. **Console (控制台)**
   - 重点关注红色的 `TypeError` (类型错误，通常是 null/undefined 读取) 和 `ReferenceError` (变量未定义)。
   - 在 ES Module 多文件架构下，留意报错堆栈位于 `js/` 目录下的哪个文件。
2. **Network (网络)**
   - 过滤 `Fetch/XHR`。是否有 404 / 403 / 500 等异常状态码？
   - 检查请求 Header 中的 `x-target-url` 等自定代理配置，以及 Payload 中的参数。
3. **Application Storage (应用存储)**
   - 如果遇到“内容没保存”、“节点消失”、“图片加载失败”，去查此处。
   - `Local Storage` -> 检查 `nodeflow_ai_state` 数据字段是否完整。
   - `IndexedDB` -> 检查 `CainFlowDB` 下的 `imageAssets`（当前工作流图片）和 `imageHistory`（历史图库）是否存在脏数据或者超出配额。

### 2.2 检查后端服务 (`server.py`)
遇到网络请求直接被中断 (Connection Refused / CORS Issue 等)：
- 会不会是 Python server 崩溃了？
- 看控制台中是否有 `Exception:` 打印或提示 `[ERROR] 无法启动服务器`。

---

## 第三阶段：全局状态（State）诊断

CainFlow 的所有核心组件都是以状态树驱动的。如果界面与预期不符（如节点多出 / 缺少 / 连线错误），直接解剖 `window.state`。

在浏览器控制台执行：
```javascript
console.log(window.state);
```

**诊断项目清单：**
1. **节点集合 (`state.nodes`)**
   - 节点的 Map 的 `size` 是否正常？
   - 展开某个节点数据，确认其 `imageData`, `text` 或者是 `enabled` 属性是否如UI呈现的那样。
2. **连线池 (`state.connections`)**
   - 是否包含 `from` 或 `to` 指向了已经不存在的节点 ID？（这会导致 `updateAllConnections` 报错瘫痪）。
3. **DOM 缓存 (`state` 中引用的 `elements`)**
   - 在 ES Module 中，`elements` 对象里的 DOM 是否成功挂载？如果返回 null，大概率是因为在 `DOMContentLoaded` 事件触发前就执行了 `document.getElementById`。

---

## 第四阶段：按场景切入定界

根据问题的现象特征，直接去特定的范围进行针对性排查。

### 🔍 场景A：UI更新迟滞 / 视图异常 （比如连线对不齐，DOM 找不到）
> **可能原因**：由于异步修改或尺寸变化，没有触发重新布局渲染机制。
- **调查方向**：
  - 代码是否在调整了节点尺寸后，漏掉了 `window.updateAllConnections()`？
  - 改写了 HTML 结构，但 JavaScript 中绑定的 `getElementById('...')` 没有同步修改？
  - 检查 `js/ui/` 和 `js/canvas/` 目录下相关渲染逻辑。

### 🔍 场景B：工作流运行卡死 / 某个节点一直在转圈
> **可能原因**：`js/engine/` 内部出现了未捕获异常，阻断了 Promise 链；或网络请求发生严重降级卡死。
- **调查方向**：
  - 检查 `js/engine/executor.js`：节点执行的循环是否意外被 `break` 或是没能 `await` 到结果？
  - 检查 `js/engine/handlers.js`：特定节点类型的逻辑处理函数，是否返回了错误的格式格式（比如丢掉了预期的字段）。
  - 有没有触发流控逻辑（重试、断板）。

### 🔍 场景C：图片资产丢失 / 报错 / 下载失败
> **可能原因**：DataURL字符串过大超出内存限制，IndexedDB存储失败等。
- **调查方向**：
  - 检查 `js/storage/indexedDB.js` 操作。是不是有跨域污染 (Tainted Canvas) 问题导致 toDataURL() 失败？
  - 查看是否存在异步争用（一边在保存图像，一边正在读取或者删除图像）。

### 🔍 场景D：点击交互按钮没反应 / HTML事件失效
> **可能原因**：事件没有正确挂载绑定，或者缺少全局访问权限。
- **调查方向**：
  - ES module 环境下，HTML 中内联的 ``onclick="func()"`` 将报错无法找到函数。检查 `index.js` 是否漏掉了 `window.func = func;`。
  - 事件监听所在的 DOM 节点是否随着重新渲染被替换了？如果是，需要用事件代理或重新挂载 `addEventListener`。

---

## 第五阶段：验证修复结果

当你完成代码修改后，遵循最后一公里的“两步验证法”：

1. **精准回归验证**：
   重试第一阶段拿到的“确切操作序列”，确保当前报错不再产生，交互效果回归正常。

2. **核心链路防跌验证 (Smoke Test)**：
   运行 `safe-change` 模块所附带的烟雾测试，确保你修补了一个边缘类型的 BUG 后，没有带崩系统最核心的功能（如序列化、IndexedDB等关联模块）。
   - 打开 127.0.0.1 控制台，注入 `tests/smoke-test.js` 执行。
   - 看到 `🟢 ALL TESTS PASSED` ，方可断言 Debug 流程安全完毕。

---

## 第六阶段：清理与安全退出 (Server 结束)

当确认所有的调试与功能修复已经完毕，并且回归测试均已过关后，为了释放系统资源和结束完整的维护周期，请自动执行以下清理过程：

### 6.1 Server 关闭与自动退出
1. **终止 Server 进程**：若在调试前启动了或者当前有正在运行的 `python server.py` 后台进程，请使用中断命令（例如调用带 `Terminate: true` 的发送输入工具）来干净体面地关闭服务进程，确保 `8767` 端口被释放。
2. **清理调试遗留**：若调试期间生成了临时的测试快照、测试用的日志文本或其他垃圾文件，且确信不再被需要，应一并删除。
3. **汇报结束**：最后总结本次排查、修复及清理结果。
