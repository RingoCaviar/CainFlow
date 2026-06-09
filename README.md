# CainFlow

**CainFlow** 是一款受 ComfyUI 启发的轻量级节点式 AI 编排工具。项目基于原生网页技术构建，配合本地 Python 服务提供工作流、设置、媒体恢复、更新与下载等能力，适合快速搭建图片与视频相关的 AI 工作流。

![CainFlow 效果演示](.github/show.jpg)

## 下载

- 发布版下载：<https://github.com/RingoCaviar/CainFlow/releases/latest>
- 推荐普通用户直接下载发布版 ZIP，解压后启动即可
- 推荐开发者克隆源码后本地运行，便于调试前端与后端逻辑

## 功能特点

- 节点式工作流编排，适合串联图片、文本、视频等多种处理流程
- 原生前端实现，启动轻量，易于按模块扩展
- 本地保存工作流与历史数据，默认不依赖云端托管
- 内置工作流管理、媒体恢复、下载、更新和日志能力
- 提供 Windows 发布版，并支持构建 macOS 发布包

## 当前版本

- 版本来源：[js/core/constants.js](D:/mygithub/CainFlow/js/core/constants.js) 中的 `APP_VERSION_NUMBER`
- 最新发布版请以 [GitHub Releases](https://github.com/RingoCaviar/CainFlow/releases/latest) 为准
- 发布前统一校验命令：`pwsh ./scripts/validate-release-readiness.ps1`

> 仓库内统一以 `js/core/constants.js` 中的 `APP_VERSION_NUMBER` 为准。

## 运行方式

### 方式一：使用发布版

1. 前往 [Releases](https://github.com/RingoCaviar/CainFlow/releases/latest) 下载最新压缩包。
2. Windows 用户解压后运行 `CainFlow.exe`。
3. macOS 用户解压后运行 `CainFlow`，首次运行如被系统拦截，需要在系统安全设置中手动放行。

### 方式二：源码运行

适合需要修改前端、后端或打包脚本的开发者。

1. 安装 Python 3。
2. 克隆或下载本仓库源码。
3. 在项目根目录运行 [start_cainflow.bat](D:/mygithub/CainFlow/start_cainflow.bat)。
4. 启动后访问 `http://127.0.0.1:8767`。

说明：

- 启动脚本会优先使用 `python_runtime\python.exe`，否则回退到系统中的 `python` 或 `py`
- 当前仓库未提供根目录 `requirements.txt`，如果你新增了 Python 依赖，记得同步补充安装说明
- 启动脚本包含端口 `8767` 占用检测，避免重复启动 CainFlow

## 项目结构

```text
CainFlow/
|- index.html              # 页面结构与主要 UI 容器
|- index.js                # 前端装配入口
|- index.css               # 样式入口
|- css/                    # 分层样式与主题
|- js/                     # 前端核心、节点、画布与功能模块
|- backend/                # 本地 HTTP 服务、路由与业务服务
|- workflows/              # 本地工作流 JSON
|- scripts/                # 构建与维护脚本
|- .github/workflows/      # 发布与清理工作流
|- server.py               # Python 启动入口
|- start_cainflow.bat      # Windows 启动脚本
```

主要模块说明：

- `js/core/`：版本、常量、共享状态、通用工具
- `js/features/`：工作流、执行、设置、历史、更新等功能模块
- `js/nodes/`：节点模板、绑定、序列化与生命周期
- `js/canvas/`：画布交互、缩放拖拽、连线与几何计算
- `backend/routes/`：后端接口入口
- `backend/services/`：工作流、下载、更新、安全、日志等后端逻辑

## 开发说明

- 前端真实入口是 [index.js](D:/mygithub/CainFlow/index.js)，新增功能优先放到 `js/features/*` 或 `js/core/*`
- 后端启动入口是 [server.py](D:/mygithub/CainFlow/server.py)，实际运行逻辑在 [backend/main.py](D:/mygithub/CainFlow/backend/main.py)
- 工作流默认保存在 [workflows](D:/mygithub/CainFlow/workflows) 目录，更新前建议先备份该目录
- 结构化后端请求日志会写入 [log](D:/mygithub/CainFlow/log) 目录

## 打包与发布

- 本地构建脚本： [scripts/build-release-local.ps1](D:/mygithub/CainFlow/scripts/build-release-local.ps1)
- GitHub Actions 工作流：
  - [release.yml](D:/mygithub/CainFlow/.github/workflows/release.yml)
  - [cleanup-releases.yml](D:/mygithub/CainFlow/.github/workflows/cleanup-releases.yml)
  - [cleanup-workflow-runs.yml](D:/mygithub/CainFlow/.github/workflows/cleanup-workflow-runs.yml)

## 默认供应商

当前默认供应商配置位于 [js/core/constants.js](D:/mygithub/CainFlow/js/core/constants.js)，预置了 `GXP` 供应商与演示模型。首次使用前请在设置面板中填写自己的 API Key，并根据实际情况修改接口地址。

## 隐私与数据

- 工作流与大部分配置默认保存在本地
- API Key 由本地应用保存与使用
- 更新、下载、代理探测等能力会按你的配置访问外部网络

## 开源许可

CainFlow 主项目使用 [GNU GPL v3.0](LICENSE)。

仓库中包含随源码分发的第三方组件：

- `js/vendor/three.module.js`：Three.js，使用 MIT License

更多第三方版权与许可说明见 [NOTICE](D:/mygithub/CainFlow/NOTICE)。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=RingoCaviar/CainFlow&type=Date)](https://star-history.com/#RingoCaviar/CainFlow&Date)
