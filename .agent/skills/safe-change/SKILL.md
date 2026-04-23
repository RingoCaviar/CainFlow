---
name: safe-change
description: CainFlow 安全变更流程 — 修BUG、改UI、加功能时的标准化步骤，确保修改不引入新问题
---

# CainFlow 安全变更技能

## 概述

本技能为 CainFlow 项目的**日常修改**（BUG修复、UI调整、新功能开发）提供一套**标准化安全流程**。
每次变更都遵循「理解 → 定位 → 快照 → 修改 → 验证 → 确认」六步法，最大程度避免引入新BUG。

**核心原则**：

- **改之前先理解**：你必须完全理解被修改代码的上下游依赖关系，才能动手
- **改之前先快照**：任何修改前都创建恢复点
- **改完立即验证**：每个原子修改都要跑烟雾测试 + 浏览器验证
- **一次只改一件事**：不要在一次提交中混合多个无关修改

---

## 前置条件

1. Python dev server 正在运行 (`python server.py`)，端口 `8767`
2. 浏览器可访问 `http://127.0.0.1:8767`
3. 项目已完成模块化拆分，当前为 ES Module 多文件架构

---

## 第一阶段：理解需求与影响分析

### 1.1 明确变更意图

在开始任何代码修改前，先回答以下问题：

| 问题 | 你必须回答 |
|:---|:---|
| **类型** | 是 BUG修复 / UI调整 / 新功能 / 性能优化 / 其他？ |
| **范围** | 涉及哪些模块文件？（列出所有将被修改的文件路径）|
| **用户可见吗** | 这个修改用户能直接感知到吗？（UI、行为、性能）|
| **有副作用吗** | 这个修改可能影响到哪些其他功能？|

### 1.2 依赖分析（必做）

CainFlow 是 ES Module 架构，模块之间有清晰的 import/export 关系。修改任何模块前，**必须先扫描依赖关系**。

**扫描被修改函数/变量的所有引用：**

```powershell
# 替换 <target> 为你要修改的函数名/变量名
Select-String -Path d:\mygithub\CainFlow\js\*.js -Pattern "<target>" -Recurse
Select-String -Path d:\mygithub\CainFlow\index.js -Pattern "<target>"
Select-String -Path d:\mygithub\CainFlow\index.html -Pattern "<target>"
```

**检查该函数是否暴露到了 window（全局）：**

```powershell
Select-String -Path d:\mygithub\CainFlow\index.js -Pattern "window\.<target>"
```

**输出一份影响清单：**

```
修改目标：<函数名/类名/变量名>
所在文件：<文件路径>
被引用于：
  - <文件1>:<行号> — <引用方式>
  - <文件2>:<行号> — <引用方式>
暴露到全局：是/否
HTML内联引用：是/否（如有，列出具体位置）
```

### 1.3 模块架构速查表

| 层级 | 模块文件 | 职责 | 主要依赖 |
|:---|:---|:---|:---|
| 状态层 | `js/state.js` | 全局状态对象、DOM元素缓存 | 无 |
| 常量层 | `js/constants.js` | 节点类型配置 NODE_CONFIGS | 无 |
| 工具层 | `js/utils.js` | 纯工具函数 | state |
| 存储层 | `js/storage/indexedDB.js` | IndexedDB 操作 | state |
| 存储层 | `js/storage/localStorage.js` | 本地存储、序列化/反序列化 | state, nodes/manager |
| UI层 | `js/ui/logging.js` | Toast通知、日志、错误模态框 | state, utils |
| UI层 | `js/ui/panels.js` | 面板初始化与切换 | state |
| UI层 | `js/ui/settings.js` | 设置模态框 | state, storage |
| UI层 | `js/ui/history.js` | 历史侧边栏 | state, storage/indexedDB |
| UI层 | `js/ui/canvas.js` | 连线渲染、缩放 | state |
| UI层 | `js/ui/interactions.js` | 画布交互（拖拽/缩放/框选） | state, nodes/manager |
| UI层 | `js/ui/overlays.js` | 全屏预览、绘图板 | state, utils |
| UI层 | `js/ui/toolbar.js` | 工具栏按钮绑定 | state, 多个模块 |
| UI层 | `js/ui/panelManager.js` | 面板互斥管理 | state |
| 节点层 | `js/nodes/manager.js` | 节点CRUD、事件绑定 | state, constants, utils, storage, engine |
| 节点层 | `js/nodes/handlers.js` | 节点执行处理器 | state, utils, storage |
| 引擎层 | `js/engine/workflow.js` | 工作流执行引擎 | state, nodes, utils |
| 引擎层 | `js/engine/serialization.js` | 节点序列化 | state |
| 引擎层 | `js/engine/topologicalSort.js` | 拓扑排序 | state |
| 引擎层 | `js/engine/history.js` | Undo历史栈 | state, serialization |
| 入口 | `index.js` | 应用入口、全局事件、window暴露 | 所有模块 |

### 1.4 全局暴露函数清单

以下函数通过 `window.xxx = xxx` 暴露到全局，**修改其签名或行为需要格外小心**：

```javascript
// index.js 中暴露的全局函数
window.state           // 来自 js/state.js
window.addNode         // 来自 js/nodes/manager.js
window.runWorkflow     // 来自 js/engine/workflow.js
window.updateAllConnections // 来自 js/ui/canvas.js
window.updatePortStyles    // 来自 js/ui/canvas.js
window.autoSaveToDir       // 来自 js/nodes/manager.js
window.closeModal      // 来自 js/ui/logging.js
window.showLogDetail   // 来自 js/ui/logging.js
window.zoomToFit       // 来自 js/ui/canvas.js
window.selectAllNodes  // 来自 js/nodes/manager.js
window.removeNode      // 来自 js/nodes/manager.js
window.saveState       // 来自 js/storage/localStorage.js
window.renderHistoryList  // 来自 js/ui/history.js
```

> ⚠️ 这些函数被 HTML 内联事件 (`onclick`) 或烟雾测试脚本直接调用，修改签名会导致静默失败！

---

## 第二阶段：安全修改流程

### 2.1 创建恢复快照

在开始编码前，根据修改范围选择一种快照策略：

**小改动（1-2个文件）** — 文件级备份：

```powershell
# 备份将被修改的文件
Copy-Item d:\mygithub\CainFlow\js\<module>.js d:\mygithub\CainFlow\js\<module>.js.bak
```

**中/大改动（3个以上文件或新功能）** — Git 分支：

```powershell
cd d:\mygithub\CainFlow
git stash
git checkout -b fix/<修改描述>
git stash pop
```

### 2.2 修改规范

#### 2.2.1 修改现有函数

```
✅ DO:
  - 保持函数签名不变（参数个数、顺序、默认值）
  - 新参数加在末尾并设置默认值
  - 返回值类型保持一致

❌ DON'T:
  - 改变已暴露到 window 的函数签名
  - 删除正在被其他模块 import 的 export
  - 将同步函数改为异步（除非同时更新所有调用方）
```

#### 2.2.2 添加新函数/模块

```
✅ DO:
  - 新函数优先添加到最相关的现有模块中
  - 需要跨模块调用时，通过 import/export 建立正规依赖
  - 如果 HTML 内联事件需要调用，在 index.js 中添加 window.xxx = xxx

❌ DON'T:
  - 在模块内部通过 window.xxx 调用其他模块的函数
    （应该使用 import，window.xxx 仅用于 HTML 内联兼容）
  - 创建循环依赖（A import B 且 B import A）
```

#### 2.2.3 修改 UI / CSS

```
✅ DO:
  - CSS 变量使用项目已有的变量（--accent-primary, --text-secondary 等）
  - 新增 DOM 元素使用唯一的 id，且命名风格与现有一致
  - 修改 HTML 结构后检查对应 JS 中的 getElementById / querySelector 是否匹配

❌ DON'T:
  - 内联 style 引入新的硬编码颜色值
  - 删除被 JS 引用的 DOM 元素 id
  - 修改 CSS 类名时忘记同步 JS 中的 classList 操作
```

#### 2.2.4 修改 state 对象

```
✅ DO:
  - 新增属性：在 js/state.js 的 state 对象中添加，设置合理默认值
  - 如果属性需要持久化：同步修改 js/storage/localStorage.js 中的 saveState/loadState
  - 如果属性需要序列化到工作流：同步修改 js/engine/serialization.js

❌ DON'T:
  - 修改已有属性名称（会导致所有引用断裂）
  - 改变属性类型（如 Map 改 Object、数组改 Set）
  - 在 state 之外的地方存储应该全局共享的状态
```

### 2.3 常见变更场景速查

#### 场景A：修复BUG

```
1. 理解BUG现象 → 在浏览器中复现
2. 定位BUG代码 → 用 grep 搜索关键字
3. 分析根因 → 是逻辑错误？DOM引用错误？时序问题？
4. 备份文件 → Copy-Item
5. 编写修复代码 → 遵循修改规范
6. 浏览器验证 → 确认BUG已修复
7. 跑烟雾测试 → 确认没有引入新问题
```

#### 场景B：UI 调整

```
1. 确认修改范围 → 是 CSS 还是 HTML 还是 JS 的 DOM 操作？
2. 扫描 CSS/HTML 中的引用关系
3. 备份文件
4. 修改代码
5. 浏览器子代理截图验证 → 确认视觉效果正确
6. 跑烟雾测试 → 确认功能未受影响
```

#### 场景C：添加新功能

```
1. 设计方案 → 确定涉及哪些模块、是否需要新文件
2. 依赖分析 → 确认不会产生循环依赖
3. Git 分支 → 中大型功能必须用分支
4. 分步实现 → 每个子功能完成后都验证
5. 更新烟雾测试 → 如果新功能需要测试覆盖
6. 全量验证
```

#### 场景D：修改 server.py（Python后端）

```
1. 备份 server.py
2. 修改代码
3. 停止旧 server 进程
4. 重新启动 server.py
5. 浏览器验证 API 功能
6. 跑烟雾测试
```

---

## 第三阶段：自动化验证

### 3.1 快速烟雾测试（每次修改后必做）

使用 browser_subagent 执行以下验证：

**Step 1：注入错误哨兵**

```
打开 http://127.0.0.1:8767
在浏览器控制台执行 tests/error-sentinel.js 的内容
```

**Step 2：等待页面加载**

```
等待 document.readyState === 'complete'
检查 window.__smokeTestError 是否为 null
```

**Step 3：执行烟雾测试**

```
在浏览器控制台执行 tests/smoke-test.js 的内容
等待测试完成，读取 window.__smokeTestResults
```

**Step 4：判定结果**

```
如果 __smokeTestResults.allPassed === true → 通过
如果有 FAIL → 立即停止，分析失败原因
```

### 3.2 浏览器视觉验证（UI修改必做）

使用 browser_subagent 进行截图对比：

| 检查项 | 操作 | 期望 |
|:---|:---|:---|
| 页面整体布局 | 截图首页 | 无错位、无遮挡 |
| 工具栏完整性 | 检查顶部工具栏 | 所有按钮可见 |
| 右键菜单 | 在画布右键 | 上下文菜单正常弹出 |
| 节点创建 | 通过菜单添加节点 | 节点正确渲染 |
| 面板切换 | 点击工作流/历史/日志 | 面板正常打开/关闭 |
| 设置弹窗 | 点击设置按钮 | 模态框正常显示 |
| 深色主题一致性 | 观察整体色调 | 新元素不应有白色背景突兀 |

### 3.3 交互测试（功能修改必做）

| 测试项 | 操作 | 预期结果 |
|:---|:---|:---|
| 画布平移 | 鼠标中键拖拽 / 空格+左键拖拽 | 画布平移，网格跟随 |
| 画布缩放 | 滚轮缩放 | 缩放流畅，zoom% 更新 |
| 节点拖拽 | 左键拖拽节点 | 节点移动，连线跟随更新 |
| 节点连接 | 拖拽端口创建连线 | 贝塞尔连线正确渲染 |
| 节点删除 | 点击节点X按钮 | 节点和关联连线一同删除 |
| 多选操作 | Ctrl+A 全选 | 所有节点高亮 |
| 复制粘贴 | Ctrl+C → Ctrl+V | 节点在鼠标位置粘贴 |
| 撤销 | Ctrl+Z | 状态恢复 |
| 工作流保存 | 点击保存 | Toast 提示成功 |
| 工作流加载 | 选择工作流 | 节点恢复到画布 |

### 3.4 控制台错误检查

每次验证时都在浏览器控制台执行：

```javascript
// 检查是否有未捕获的错误
if (window.__smokeTestErrors && window.__smokeTestErrors.length > 0) {
    console.error('存在未捕获错误:', window.__smokeTestErrors);
}
// 检查关键全局函数
['addNode', 'removeNode', 'saveState', 'loadState', 'updateAllConnections', 'serializeNodes']
    .forEach(fn => {
        if (typeof window[fn] !== 'function') console.error(`❌ 全局函数缺失: ${fn}`);
    });
```

---

## 第四阶段：回退策略

### 单文件回退

```powershell
Copy-Item d:\mygithub\CainFlow\js\<module>.js.bak d:\mygithub\CainFlow\js\<module>.js -Force
```

### Git 回退

```powershell
cd d:\mygithub\CainFlow
# 放弃当前修改
git checkout -- <文件路径>

# 或回退整个分支
git checkout main
git branch -D fix/<修改描述>
```

### Server 重启

修改 server.py 后如果出问题：

```powershell
# 终止现有 server（通过 send_command_input 的 Terminate）
# 重新启动
cd d:\mygithub\CainFlow
python server.py
```

---

## 第五阶段：修改完成确认

### 5.1 完成检查清单

每次修改完成后，逐项核对：

- [ ] 所有修改的文件已备份或在 Git 分支上
- [ ] 依赖分析已完成，所有受影响的引用已同步更新
- [ ] import/export 语句正确无遗漏
- [ ] 如修改了全局函数签名 → index.js 中的 window 暴露已同步
- [ ] 如修改了 HTML 元素 id → JS 中的 getElementById 已同步
- [ ] 如修改了 state 属性 → localStorage 序列化/反序列化已同步
- [ ] 如新增了 CSS → 使用了项目已有的变量，无硬编码颜色
- [ ] 烟雾测试全部通过 (window.__smokeTestResults.allPassed === true)
- [ ] 浏览器控制台无红色错误
- [ ] 视觉效果符合预期（如有UI变更）

### 5.2 变更日志

每次修改完成后，输出一份简短的变更日志：

```
## 变更摘要
- **类型**: BUG修复 / UI调整 / 新功能
- **涉及文件**: 
  - `js/xxx.js` — 描述修改内容
  - `index.css` — 描述修改内容
- **影响范围**: 描述这次修改可能影响到的功能
- **验证结果**: 烟雾测试 ✅ / 视觉验证 ✅ / 交互测试 ✅
- **回退方案**: 有 .bak 文件 / Git 分支
```

---

### 5.3 变更日志

执行完毕并确认没问题后，清理不需要的临时文件以及关闭server


## 关键注意事项

### ⚠️ 高风险操作警告

1. **修改 `js/state.js` 中的 state 结构** — 几乎所有模块都依赖它
   - 新增属性安全，删除/重命名属性危险
   
2. **修改 `js/nodes/manager.js` 中的 `addNode()`** — 这是最核心的函数
   - 控制所有节点类型的创建，改错一处全部节点创建都会崩

3. **修改 `js/engine/workflow.js`** — 工作流执行引擎
   - 涉及网络请求和异步流程，bug难复现

4. **修改 `index.html` 中的 DOM 结构** — 大量 JS 用 getElementById
   - 删除任何元素前搜索其 id 在 JS 中的所有引用

5. **修改 `server.py`** — 需要重启服务
   - 修改前确保没有正在运行的工作流

### ✅ 安全修改区域

1. **CSS 样式调整** — 只改视觉，不影响逻辑（注意不要删除被 JS classList 操作的类名）
2. **utils.js 中新增工具函数** — 零依赖的纯函数最安全
3. **constants.js 新增节点类型** — 只要不修改已有类型的结构
4. **logging.js 修改日志格式** — 影响范围小

### 🔧 开发技巧

1. **快速刷新**：修改 JS/CSS 后在浏览器按 `Ctrl+F5` 强制刷新
2. **模块加载失败排查**：在 DevTools Network 面板检查 `.js` 文件状态码
3. **DOM引用失败排查**：搜索 `getElementById` 对应的 id 在 HTML 中是否存在
4. **异步问题排查**：检查 `async/await` 是否正确传播
