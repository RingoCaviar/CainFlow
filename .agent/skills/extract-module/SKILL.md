---
name: extract-module
description: 将指定的特定功能从大型单一的代码文件（或主入口文件）中安全提取为独立的模块化（ES6 Modules 或独立 JS）文件，确保功能无损分离。
---

# CainFlow 模块提取技能

## 概述

本技能专门用于将 CainFlow 项目中大型 JS 文件里的特定功能块（例如"历史记录管理"、"画布交互"、"节点拖拽"）安全、无损地提取为独立的 ES Module 文件。

**核心原则**：

- **只做搬运，不做改造**：严禁借提取之名修改已调通的业务逻辑
- **提取前先画地图**：必须完整理清目标代码的所有依赖和被依赖关系
- **提取后立即验证**：必须跑烟雾测试 + 浏览器验证，确认功能无损
- **一次只提取一个功能**：不要在一次操作中同时提取多个不相关的功能块

---

## 前置条件

1. Python dev server 正在运行 (`python server.py`)，端口 `8767`
2. 浏览器可访问 `http://127.0.0.1:8767`
3. 确认目标源文件存在且没有语法错误（页面能正常加载）

---

## 第一阶段：需求确认与范围划定

### 1.1 明确提取目标

在开始代码分析前，先回答以下问题：

| 问题 | 你必须回答 |
|:---|:---|
| **功能名称** | 用户希望提取的功能叫什么？（如 "历史记录"、"拖拽交互"） |
| **源文件** | 该功能目前耦合在哪个文件中？（如 `index.js`、某个大模块文件） |
| **目标路径** | 新模块文件应放到哪里？（遵循现有目录结构，如 `js/ui/`、`js/engine/`） |
| **边界清晰吗** | 该功能是一坨连续代码还是散落在文件各处？ |

### 1.2 全面搜索相关代码

使用 `grep_search` 对功能关键字进行**地毯式搜索**，搜索范围包括：

- **函数名**：该功能涉及的所有函数名
- **DOM 元素引用**：该功能操作的 `getElementById`、`querySelector` 涉及的 id/class
- **事件监听**：绑定了哪些 `addEventListener`
- **状态变量**：读写了 `state` 的哪些属性

```
搜索示例（替换 <关键字> 为功能相关的名称）：

工具: grep_search
路径: d:\mygithub\CainFlow\js\
关键字: <关键字>
选项: MatchPerLine=true, CaseInsensitive=true

工具: grep_search
路径: d:\mygithub\CainFlow\index.js
关键字: <关键字>

工具: grep_search
路径: d:\mygithub\CainFlow\index.html
关键字: <关键字>
```

### 1.3 阅读并标记代码边界

使用 `view_file` 阅读源文件，**精确标记**待提取代码的范围：

- 开始行号 ~ 结束行号
- 列出所有即将被搬到新模块的函数名与变量名
- 标记哪些是纯内部私有的，哪些是需要对外暴露的

**输出格式：**

```
## 📋 代码边界标记

源文件: <文件路径>
代码范围: L<起始行> ~ L<结束行>

将提取的函数/变量:
  - [内部] functionA()         — L120~L145
  - [内部] functionB()         — L150~L180
  - [导出] initFeatureX()      — L200~L230
  - [内部] let localVar = ...  — L110

将保留在原文件的函数/变量:
  - functionC() — 虽然名字相关，但被其他功能使用
```

---

## 第二阶段：依赖关系追踪（必做）

这是最关键的一步。**依赖理不清，提取必翻车。**

### 2.1 追踪外部依赖（该功能需要什么）

逐一检查待提取的代码块中，引用了哪些外部模块或全局对象：

```
搜索示例：

对待提取代码中出现的每个外部变量/函数，执行：

工具: grep_search
路径: d:\mygithub\CainFlow\js\
关键字: export.*<变量名或函数名>
选项: MatchPerLine=true

或者直接在源文件中查找该符号的 import 语句。
```

**常见的外部依赖来源（CainFlow 架构）：**

| 依赖来源 | 典型用法 | import 路径示例 |
|:---|:---|:---|
| `state` 全局状态 | `state.nodes`, `state.scale` | `import { state } from '../state.js'` 或 `'./state.js'` |
| `db` 数据库操作 | `db.saveImage()`, `db.getHistory()` | `import { db } from '../storage/indexedDB.js'` |
| `utils` 工具函数 | `showToast()`, `debounce()` | `import { showToast } from './logging.js'` |
| `constants` 配置 | `NODE_CONFIGS` | `import { NODE_CONFIGS } from '../constants.js'` |
| DOM 元素 | `state.elements.xxx` | 通过 state 间接引用 |

### 2.2 追踪对外暴露（谁在用这个功能）

检查待提取的每个函数是否被其他文件调用：

```
对每个即将从原文件移出的函数，执行：

工具: grep_search
路径: d:\mygithub\CainFlow\
关键字: <函数名>
选项: MatchPerLine=true, Includes=["*.js", "*.html"]
```

**特别注意以下 CainFlow 特有的引用方式：**

1. **`window.xxx` 全局暴露**：检查 `index.js` 中是否有 `window.函数名 = 函数名`
2. **HTML 内联事件**：检查 `index.html` 中是否有 `onclick="函数名()"` 等内联调用
3. **其他模块的 import**：检查其他 `.js` 文件是否通过 `import { 函数名 } from '...'` 引用
4. **动态调用**：检查是否存在 `window['函数名']` 或字符串拼接调用的情况

### 2.3 输出依赖地图

**必须以下面的格式整理并输出，提交用户审阅后才能进入下一步：**

```
## 🗺️ 依赖地图

### 外部依赖（新模块需要 import 的）
  - state          ← from '../state.js'         — 用于读取 state.nodes, state.scale
  - db             ← from '../storage/indexedDB.js' — 用于 db.saveImage()
  - showToast      ← from './logging.js'         — 用于提示用户

### 对外暴露（其他地方调用了这些函数）
  - initHistory()  → index.js:L45 调用初始化
  - renderHistoryList() → index.js:L300 通过 window 暴露
                       → index.html:L88 内联 onclick 调用

### window 全局暴露（需要在 index.js 中维护）
  - window.renderHistoryList = renderHistoryList  — index.js:L300

### 不确定/需要确认的依赖
  - (列出任何无法确定的动态引用)
```

---

## 第三阶段：制定提取计划

### 3.1 参考现有模块风格

**必须先读取项目中已有的模块文件**，确保新模块与项目整体风格一致：

```
阅读现有模块作为模板参考：

工具: view_file
路径: d:\mygithub\CainFlow\js\modules\ 或 js\ui\ 中已有的模块文件
（根据项目实际目录结构而定）
```

需要确认的风格统一项：
- `import` 路径使用相对路径还是绝对路径？
- `export` 使用命名导出还是默认导出？
- 模块是否有统一的初始化入口函数（如 `initXxx()`）？
- 文件头部是否有注释说明？

### 3.2 输出提取计划

**必须以下面的格式输出完整计划，等待确认后才能动手：**

```
## 📐 提取计划

### 新建文件
  文件: js/<层级>/<功能名>.js
  内容:
    - import: [state, db, showToast]
    - 内部变量: [localVar1, localVar2]
    - 内部函数: [_privateHelper1(), _privateHelper2()]
    - 导出函数: [export initXxx(), export renderXxx()]

### 修改原文件: <原文件路径>
  删除:
    - L120~L230: 功能X的全部代码
  新增:
    - 在 import 区域添加: import { initXxx, renderXxx } from './<功能名>.js'
  替换:
    - (如有需要替换的调用方式，列出)

### 修改入口文件: index.js（如需要）
  修改 import 来源:
    - 原: import { renderXxx } from './js/<原文件>.js'
    - 新: import { renderXxx } from './js/<层级>/<功能名>.js'
  window 暴露保持不变:
    - window.renderXxx = renderXxx

### 不修改的文件
  - index.html — 内联 onclick 调用的函数名未变，无需修改
  - 其他模块 — 不直接依赖被提取的函数
```

### 3.3 风险评估

对以下高风险点逐一确认：

- [ ] 是否涉及 `window.xxx` 暴露的函数？→ 需在 `index.js` 中更新 import 来源
- [ ] 是否涉及 HTML 内联 `onclick` 调用？→ 确认函数名不变，window 暴露路径正确
- [ ] 是否涉及 `state` 对象的属性修改？→ 确认 state 引用方式不变
- [ ] 是否涉及 `DOMContentLoaded` 时序？→ 确认初始化顺序不受影响
- [ ] 是否涉及循环依赖？→ 新模块 import A，A 是否又 import 新模块？

---

## 第四阶段：安全实施提取

### 4.1 创建恢复快照（必做）

在动手前备份所有即将被修改的文件：

```powershell
# 备份原文件
Copy-Item d:\mygithub\CainFlow\js\<原文件>.js d:\mygithub\CainFlow\js\<原文件>.js.bak

# 备份 index.js（如果需要修改）
Copy-Item d:\mygithub\CainFlow\index.js d:\mygithub\CainFlow\index.js.bak
```

### 4.2 创建新模块文件

按照第三阶段的计划，创建新的模块文件：

```
操作要点：
1. 文件顶部：写入所有必要的 import 语句
2. 文件中部：原样搬入代码，不修改任何逻辑
3. 文件底部：export 所有需要对外暴露的函数/变量
4. 内部私有函数不需要 export
```

**⚠️ 严禁行为：**
- ❌ 重命名任何函数或变量
- ❌ 修改参数列表或返回值
- ❌ "顺便优化"代码逻辑
- ❌ 改变函数的同步/异步特性
- ❌ 合并或拆分原有函数

### 4.3 清理原文件并建立桥接

```
操作要点：
1. 从原文件中删除已提取的代码块
2. 在原文件顶部添加对新模块的 import
3. 如果原文件有 re-export 需求（其他文件通过原文件间接引用），添加 re-export：
   export { initXxx, renderXxx } from './<功能名>.js'
```

### 4.4 更新入口文件 index.js（如需要）

```
操作要点：
1. 修改 import 语句：将导入来源从原文件改为新模块
2. window.xxx 暴露语句保持不变，只是导入来源变了
3. 初始化调用顺序：如果新模块有 init 函数，确保调用位置不变
```

---

## 第五阶段：严格验证

### 5.1 静态检查（代码审查）

提取完成后立即执行以下检查：

**检查 1：新模块内部引用完整性**

```
对新模块中使用的每个外部符号，确认 import 语句存在：

工具: view_file
路径: 新创建的模块文件
验证: 每个 import 的符号都能在源模块中找到对应的 export
```

**检查 2：原文件清理干净**

```
工具: grep_search
路径: <原文件>
关键字: <已提取的函数名>
验证: 不应该再出现该函数的定义（只有 import 和可能的 re-export）
```

**检查 3：没有引入循环依赖**

```
检查新模块的 import 链：
  新模块 imports → [A, B, C]
  A imports → [...]  是否包含新模块？
  B imports → [...]  是否包含新模块？
```

**检查 4：`this` 绑定安全性**

特别留意以下场景：
- 被提取的函数作为事件回调使用（`addEventListener('click', func)`）
- 被提取的函数赋值给对象属性后调用
- 使用了 `this` 关键字的函数

### 5.2 运行时验证（浏览器检查）

使用 `browser_subagent` 进行完整验证：

**Step 1：页面加载检查**

```
1. 打开 http://127.0.0.1:8767
2. 打开开发者工具控制台
3. 检查是否有红色错误（特别是 import 错误和 ReferenceError）
4. 确认页面正常渲染
```

**Step 2：目标功能验证**

```
1. 执行用户描述的功能的完整操作路径
2. 确认功能表现与提取前完全一致
3. 检查控制台无新增错误
```

**Step 3：关联功能回归**

```
1. 测试原文件中剩余功能是否仍然正常
2. 测试通过 window.xxx 暴露的全局函数是否可用
3. 测试 HTML 内联事件是否正常触发
```

**Step 4：烟雾测试**

```
在浏览器控制台执行 tests/smoke-test.js
等待测试完成，确认 window.__smokeTestResults.allPassed === true
```

### 5.3 全局函数可用性快速检查

在浏览器控制台执行：

```javascript
// 验证所有 window 暴露的函数仍然可用
['addNode', 'removeNode', 'saveState', 'updateAllConnections',
 'runWorkflow', 'zoomToFit', 'selectAllNodes', 'closeModal',
 'showLogDetail', 'autoSaveToDir', 'renderHistoryList', 'updatePortStyles']
  .forEach(fn => {
      if (typeof window[fn] !== 'function') console.error(`❌ 全局函数缺失: ${fn}`);
      else console.log(`✅ ${fn}`);
  });
```

---

## 第六阶段：完成确认与清理

### 6.1 完成检查清单

每次提取完成后，逐项核对：

- [ ] 新模块文件已创建，路径符合项目目录结构
- [ ] 新模块的 import/export 语句完整无遗漏
- [ ] 原文件中已删除被提取的代码，并添加了对新模块的 import
- [ ] index.js 中的 import 来源已更新（如需要）
- [ ] window.xxx 暴露语句指向正确的导入来源
- [ ] HTML 内联事件调用的函数名未改变
- [ ] 浏览器控制台无红色错误
- [ ] 目标功能操作正常
- [ ] 烟雾测试全部通过
- [ ] 原文件的剩余功能未受影响
- [ ] 所有修改的文件都有 .bak 备份

### 6.2 输出变更日志

```
## 模块提取摘要
- **提取功能**: <功能描述>
- **新建文件**: `js/<层级>/<功能名>.js`
  - 导出: [函数列表]
  - import: [依赖列表]
- **修改文件**:
  - `<原文件>` — 删除了 L<x>~L<y> 的代码，新增了 import 语句
  - `index.js` — 更新了 import 来源（如适用）
- **未修改文件**: index.html, 其他模块（无需变更）
- **验证结果**: 烟雾测试 ✅ / 功能验证 ✅ / 控制台无错误 ✅
- **回退方案**: 各文件有 .bak 备份
```

### 6.3 清理

```powershell
# 确认一切正常后，清理备份文件
Remove-Item d:\mygithub\CainFlow\js\<原文件>.js.bak
Remove-Item d:\mygithub\CainFlow\index.js.bak
```

---

## ⚠️ 核心操作戒律

### 绝对禁止

1. **禁止改逻辑**：只做代码位置的搬运和模块化封装，严禁修改任何已调通的业务逻辑、算法或数据结构
2. **禁止改签名**：函数名、参数顺序、参数个数、返回值类型必须保持不变
3. **禁止改时序**：不要改变函数的同步/异步特性，不要改变初始化调用的先后顺序
4. **禁止越界操作**：只提取用户指定的功能，不要"顺便"带走或重构相邻的代码

### 必须遵守

1. **遇到不确定的动态引用 → 立即暂停询问用户**
2. **依赖地图未确认 → 不允许开始实施**
3. **提取计划未确认 → 不允许开始实施**
4. **验证未通过 → 必须回退并报告问题**

### CainFlow 专有注意事项

1. **`window.xxx` 暴露链路**：CainFlow 中大量函数通过 `index.js` 的 `window.xxx = xxx` 暴露给 HTML 内联事件和控制台使用。提取模块后必须确保这条链路不断裂（import 来源变了，但 window 赋值仍在 index.js 中）
2. **`state.elements` DOM 缓存**：许多 UI 模块通过 `state.elements.xxx` 访问 DOM，这些引用在 `DOMContentLoaded` 之后才有效。提取模块时不要改变初始化时机
3. **ES Module 加载顺序**：CainFlow 使用 `<script type="module">` 加载，模块的执行顺序由 import 依赖图决定。新增模块不会改变这个顺序，但要注意不要引入循环依赖
4. **IndexedDB 异步操作**：涉及 `db` 对象的代码都是异步的，提取时确保 `async/await` 链路完整搬运，不要遗漏 `await`
