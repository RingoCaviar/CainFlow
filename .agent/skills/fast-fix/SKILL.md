---
name: fast-fix
description: CainFlow 快速修复与开发技能 — 以最小 Token 消耗快速定位、修复 Bug 或实现新需求，包含自动服务管理流。
---

# CainFlow 快速修复与开发 (Fast-Fix)

## 概述

本技能旨在为 CainFlow 项目提供一种**极致高效**的修复和开发流程。核心目标是：
1. **减少 Token 消耗**：不进行多余的代码全量读取。
2. **提高效率**：自动化环境检查，跳过繁琐的非必要步骤。
3. **闭环验证**：执行完即验证，验证完即交付。

---

## 执行流程

### 第一步：环境检查与自动服务管理 (Environment Readiness)

在开始任何工作前，必须确保本地开发环境已就绪。

1. **检测服务状态**：
   使用 `netstat -ano | findstr :8767` 检查端口 `8767` 是否被占用。
   - **如果端口已占用**：记录为 `AUTO_START=false`。使用现有的服务，**任务结束后不要关闭它**。
   - **如果端口未占用**：记录为 `AUTO_START=true`。运行 `python server.py` 启动服务，**任务结束后必须关闭它**。

2. **访问检查**：
   使用 `browser_subagent` 访问 `http://127.0.0.1:8767`，确保页面能正常打开。

### 第二步：快速定位与思路分析 (Localization)

不要盲目阅读大量文件，采用「精准打击」策略：

1. **关键词搜索**：
   根据用户描述的 Bug 现象或需求关键词，使用 `grep_search` 定位核心代码。
   ```powershell
   # 示例：搜索报错信息或相关功能名
   Select-String -Path d:\mygithub\CainFlow\js\*.js -Pattern "关键函数名"
   ```

2. **最小化理解**：
   只阅读受影响函数及其直接调用者的前后 50-100 行代码（使用 `view_file` 指定 `StartLine` 和 `EndLine`）。

3. **制定方案**：
   在内心（或简短回复中）形成修复思路：
   - 错误根因是什么？
   - 需要修改哪个文件的哪几行？
   - 修改后是否会影响其他功能（快速扫描依赖）？

### 第三步：精确执行 (Execution)

1. **直接修改**：
   使用 `replace_file_content` 或 `multi_replace_file_content` 应用修改。
   - **严禁**：为了一个小修改而重写整个大文件。
   - **必须**：保持原有缩进和命名风格。

### 第四步：快速验证 (Verification)

1. **刷新浏览器**：
   在 `browser_subagent` 中刷新页面并等待加载完成。

2. **快速自动化检查**：
   在浏览器控制台执行以下脚本来捕获运行时错误：
   ```javascript
   // 检查是否有致命渲染错误
   const errorCheck = () => {
       const errors = [];
       if (window.state === undefined) errors.push("state 对象未定义");
       // 检查关键 DOM 元素
       if (!document.getElementById('canvas-container')) errors.push("画布容器丢失");
       return errors;
   };
   console.log("验证检查结果:", errorCheck());
   ```

3. **手动验证**：
   根据修改内容，让 `browser_subagent` 点击相关按钮或执行相关操作，观察控制台输出。

4. **视觉确认**：
   如有 UI 变动，通过 `browser_subagent` 截图确认。

### 第五步：任务总结与环境清理 (Conclusion)

1. **报告总结**：
   - **Bug 原因**（如果是修复任务）：一句话描述导致问题的根本原因。
   - **修改内容**：列出修改的文件和核心逻辑。
   - **验证结果**：确认已修复/已实现。

2. **清理环境**：
   - 如果 `AUTO_START=true`：终止 `python server.py` 进程。
   - 如果 `AUTO_START=false`：**保持服务运行**，不要杀掉用户的进程。

---

## 最佳实践与禁令

- **禁止**：在没有复现问题前就开始改代码。
- **效率**：优先查看 `js/state.js` 和 `index.js`，它们通常是问题的汇聚点。
- **Token 节省**：所有的 `view_file` 必须限定范围，除非文件总行数小于 200 行。
- **安全性**：虽然追求速度，但不得破坏 `safe-change` 技能中提到的全局暴露函数签名。
