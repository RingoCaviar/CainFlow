# 通过 MCP 操作已保存的工作流

CainFlow 提供本机 stdio MCP 接入。本地服务运行时，外部客户端可以按工作流 ID 读取、编辑和运行已保存的工作流，并读取运行结果。关闭编辑器窗口后，仍可连接正在运行的本地服务。每批成功的编辑都会保存，可用 `undo_canvas` 一次撤销。

## 在 CainFlow 里启用

1. 在运行 CainFlow 服务的机器上安装 Node.js 22 或更高版本，再启动 CainFlow。如果服务进程的 `PATH` 中找不到 Node，可在启动前将 `CAINFLOW_NODE_PATH` 设为 Node 可执行文件的绝对路径。在桌面版或 `http://127.0.0.1:8767/` 进入 **设置 → 常规设置 → 外观与画布 → 画布 MCP**，打开开关。
2. 点击 **复制客户端配置**。首次连接时，使用 Python 3.11 或更新版本，在终端运行设置里提供的依赖安装命令。
3. 将复制的配置贴到支持本机 stdio 的 MCP 客户端，然后重载客户端。在客户端发「列出 CainFlow 已保存的工作流」验证连接，再指定想操作的工作流。

关闭开关会停止接收外部调用。CainFlow 会记住开关状态。再次启用可继续使用原令牌。如果本地服务重启后端口变化，或已安装的 MCP 适配器需要更新，重新复制客户端配置并重载客户端。

MCP 接口仅接受本机回环连接。配置内的令牌授予已保存工作流的读取、编辑和运行权限，请只粘贴到信任的本机客户端。

## 无窗口运行本地服务

桌面版退出会停止随窗口启动的服务。要在关闭所有窗口后使用 MCP，请启动无窗口模式。它在本机回环地址监听，并沿用同一套已保存的工作流与 MCP 开关。端口需与客户端配置中的 `--port` 一致。

```powershell
# Windows 发布包
.\CainFlow.exe --headless --port 8767
```

```sh
# macOS 发布包
./CainFlow --headless --port 8767

# 源码目录
python server.py --headless --port 8767
```

在 Windows 源码目录运行下面这条命令，可以启动独立的本地服务进程，再关闭启动它的 PowerShell 窗口。

```powershell
Start-Process -FilePath python -ArgumentList 'server.py','--headless','--port','8767' -WindowStyle Hidden
```

## 客户端配置示例

下面是使用 `mcpServers` 格式的示例。如果客户端有单独的命令、参数和环境变量输入框，分别填入复制配置中的 `command`、`args` 和 `env`。客户端找不到 Python 时，在 `command` 填 Python 的绝对路径。

```json
{
  "mcpServers": {
    "cainflow-canvas": {
      "command": "C:/path/to/python.exe",
      "args": ["D:/path/to/CainFlow/canvas_mcp.py", "--port", "8767"],
      "env": { "CAINFLOW_MCP_TOKEN": "<设置复制的令牌>" }
    }
  }
}
```

源码启动仍支持用 `CAINFLOW_MCP_TOKEN` 首次启用。通过开关保存设置后，以保存的状态为准。

## 工具

| 工具 | 用途 |
| --- | --- |
| `list_workflows` | 分页列出已保存的工作流名称和 `workflowId`。用返回的 `nextOffset` 继续读取。 |
| `read_canvas` | 按 `workflowId` 分页读取已保存的节点、参数、连线和端口。返回 `workflowId`、`revision`。 |
| `list_models` | 列出已配置的生图模型、可用供应商 ID 及参数选项。 |
| `create_workflow` | 保存一个空白工作流并返回名称和 ID。可传 `name`，省略时自动命名。 |
| `list_history` | 分页读取当前保存目录的历史图片信息，包括 `id`、`fileVersion` 和备注。 |
| `annotate_history` | 使用历史图片的 `id` 和 `fileVersion` 保存备注。空备注清除现有备注。 |
| `import_history` | 按历史图片的 `id` 和 `fileVersion`，把原图导入指定工作流。 |
| `list_prompts` | 分页读取提示词库，可按名称查询。 |
| `save_prompt` | 保存提示词。同名条目更新内容，保存结果由 CainFlow 持久化。 |
| `apply_prompt` | 将库中预设套用到指定节点的普通提示词或系统提示词。 |
| `edit_canvas` | 用 `workflowId`、`revision` 应用 v1 方案。支持新增、就地编辑、删除和连线。返回新的画布版本和步骤对应的实际节点 ID。 |
| `generate_image_batch` | 使用同一条提示词逐张处理 `sourceNodeIds` 指定的来源。一次建图，可同时启动新批次。 |
| `run_workflow` | 启动指定工作流，或指定 `nodeIds` 只运行这些节点，或指定 `targetNodeId` 运行到该节点。返回 `runId`。 |
| `stop_workflow` | 停止指定工作流的 MCP 运行。也可传 `nodeIds`，停止这些节点的运行分支。 |
| `undo_canvas` / `redo_canvas` | 撤销或重做指定工作流的一步 MCP 画布操作。 |
| `get_workflow_run` | 使用 `workflowId`、`runId` 分页获取运行状态、节点结果、可用文本和图片信息。 |
| `get_run_image` | 读取指定运行节点的一张图片，`index` 从零开始。 |

## 编辑节点与连线

`read_canvas` 的 `creatableTypes` 是可创建的节点类型，`editableFields` 是可写参数，`nodePatchFields` 是通用节点属性。没有可写参数清单的类型可按默认设置创建，步骤需填 `execute: false`。新建空节点时也使用 `execute: false`。

- 传 `nodeId` 编辑现有节点。使用 `patch` 的 `title`、`x`、`y`、`enabled` 来改名、移动或设置启用状态。其余受支持设置通过 `parameters` 修改。
- 连线目标用方案内的步骤 ID，来源可用步骤 ID 或现有节点 ID。断开某条线时，在 `disconnects` 项填写 `ref`、`port` 和读取到的 `connectionId`。省略 `connectionId` 表示清空这个输入。文本合并、文本拆分和图片合并按节点当前配置返回端口。缩减图片合并输入前，需明确断开会受影响的现有连线。
- 对话节点可编辑普通提示词、系统提示词及固定设置。视频生成可编辑提示词、比例和生成次数。调色节点可编辑白平衡、色温、色调、自然饱和度和饱和度。使用 `parameterOptions` 核对当前节点的枚举值或取值范围。
- 电商套图节点的 `parameters.productInfo` 支持按字段更新 `name`（商品名称）、`sellingPoints`（核心卖点，字符串数组）、`audience`（目标人群）、`useCases`（使用场景）和 `details`（商品资料）。`parameters.copyLanguage` 设置图中文字的语言，从 `parameterOptions.copyLanguage` 选择语言代码，例如 `auto`、`en` 或 `ja`。修改语言后在节点参数列重新生成方案。步骤使用 `execute: false`。
- 已规划的详情页通过 `commerceDetailPage` 返回 `sectionCount` 和 `readySectionCount`。在编辑器里进行整页规划、版式调整、文案编辑和套图运行。套图输出端口按阅读顺序发布模型成图。
- 需要生成的新生图节点填写 `parameters.prompt`。生图步骤和批处理的 `modelId` 传 `list_models` 返回的配置项 `id`，`providerId` 传对应供应商的 `id`。

编辑、运行、停止、撤销和重做都需要 `read_canvas` 返回的 `workflowId` 和 `revision`，以确认要操作的已保存版本。内置 Agent 可以直接处理「运行选中的节点」「运行节点『主图』」「运行到『主图』」「停止当前工作流」「撤销上一步」「重做上一步」。模型规划的已有节点编辑会先展示就地变更预览。

为同一次 `read_canvas` 读取节点、连线、长文本或素材的后续页时，沿用原来的过滤条件，并传回首页的 `workflowId` 和 `revision`。收到 `stale_revision` 时，从首页重新读取。首次读取只需指定 `workflowId`。

早期保存的文件如果还没有工作流 ID，在编辑器里打开并保存一次，即可用 `list_workflows` 找到。

编辑器启动时，如果 MCP 保存了同一工作流的较新版本，未改动的标签会加载该版本。未保存的草稿会保留，尝试保存过期草稿时会显示冲突提示。

## 把图片放进画布

- **画布已有图片**：直接从对应节点的图片输出连线。需要新建独立的图片导入节点时，从 `read_canvas` 的 `nodes[].assets` 读取已保存的素材键，填入新建 `ImageImport` 步骤的 `assetKey`。素材还有后续页时，用 `nextAssetOffset` 继续读。替换现有图片导入节点的图片时，将单张文件拖到该节点上。
- **CainFlow 历史图片**：客户端用 `list_history` 找到条目的 `id` 和 `fileVersion`，再用 `import_history` 直接导入。通过返回的 `imported[].nodeId` 对应每张历史图片。
- **其他本地图片**：通过编辑器导入。多选图片文件并拖到画布空白处，每张图会创建一个图片导入节点。Canvas MCP 没有文件上传接口，`assetKey` 只引用已经登记的素材。

用户已指定图片并要求导入时，能访问文件和操作编辑器的客户端应在宿主授权范围内直接完成导入。界面保存后，用目标 `workflowId` 重新调用 `read_canvas`，确认对应节点的 `assets` 已出现，再用最新 `revision` 编辑。需要按页连线时，先核对文件与节点的对应关系。确实缺少文件、访问权限或界面操作能力时，只请用户补齐缺少的一步，例如将指定图片拖到目标工作流的画布空白处并保存。

## 批量处理指定图片

可对客户端说「给工作流里的商品原图统一换成浅灰背景，比例 4:5，逐张出图并直接运行」。客户端先用 `read_canvas` 找到来源节点，再把 `workflowId`、`revision`、`sourceNodeIds` 和共用 `prompt` 传给 `generate_image_batch`。可通过 `parameters` 指定 `{"aspect":"4:5","resolution":"2K"}`，具体取值以所选模型为准。

传 `run: true` 时，在建图保存后只运行本批新建分支，用返回的 `run.runId` 查询进度。省略 `run` 时只建图。结果带 `runError` 时说明建图已保存，可以用返回的节点 ID 继续运行。分支运行失败时，可用节点 ID 在 CainFlow 画布查看详细错误。一次批处理最多 100 个画布操作，每张单图对应生图和预览两个节点，多图输出中的每张图额外建立一个原图引用节点。

使用 `read_canvas` 的 `parameterOptions` 查看当前生图节点的比例、分辨率档位及其他枚举值。用档位值填写 `resolution`，空字符串对应控件的默认项。模型支持时，可在 `protocolParams` 内填写 `systemPrompt`、`output_format` 等协议字段。

权限范围见 [画布能力规范](adr/0025-scoped-canvas-automation.md)。

## 空白工作流、历史备注与提示词库

`create_workflow` 保存一个空白工作流并返回 ID 和名称。按新 ID 调用 `read_canvas`，再编辑新画布。名称不能与现有工作流重名。历史和提示词库工具使用 CainFlow 服务当前配置的目录和提示词库。

`list_history` 返回当前保存目录中的图片信息。给某张图添加备注时，把该条目的 `id` 和 `fileVersion` 传给 `annotate_history`。原文件被替换或保存目录已切换时请重新列出。备注最长 80 个字符。

提示词库由 CainFlow 持久化，内置 Agent、MCP 和界面使用同一份库。可在内置 Agent 输入「新建空白工作流，命名为『商品评审』」「给最新一张历史图片加备注：正面样片」「保存提示词『白底规则』：保留包装文字，使用柔光」。也可以输入「查看历史图片」或「查看提示词库」。

此前只存在浏览器里的提示词库，可从原来的 CainFlow 地址打开 **设置 → 旧浏览器数据迁移**，迁入当前数据目录。

## 导入历史图片与套用库提示词

`import_history` 与 `apply_prompt` 都需要 `read_canvas` 返回的 `workflowId` 和 `revision`。每次成功编辑后返回新的画布版本。一次导入或套用可撤销一次。

- `import_history` 的 `items` 接收 1 至 20 项 `{id, fileVersion}`，从 `list_history` 获取。文件变化或切换保存目录时，重新读取列表。导入使用原图并创建图片导入节点。内置 Agent 可接受「把历史图片 ID 42、53 导入当前画布」。
- `apply_prompt` 接收 `nodeId`、唯一的 `promptId` 或精确的 `name`，以及 `target`。普通提示词用 `prompt`，支持文本、对话和图片生成节点。对话或生图节点接入独享的可写文本时，编辑该文本节点。需要修改共享文本时，请直接指定文本节点。系统提示词用 `system`，可在 `read_canvas` 中通过 `supportsSystemPrompt` 识别支持的对话或生图节点。内置 Agent 可接受「把库里的『白底规则』套用到选中节点的系统提示词」，并在修改前展示预览。

收到画布版本过期或请求超时时，先重新读取并确认保存状态，再提交改动。运行记录按工作流 ID 和运行 ID 查询，在当前服务进程内保留。成功保存的节点结果会写入工作流。

`read_canvas.runnableTypes` 列出后台可运行的节点类型，包括文本、绑定已保存源图的图片导入、通用输出节点、智能对话、生图和视频生成。图片缩放、调色、旧版图片保存、产品精修和电商套图当前会返回 `node_unsupported_node`。生图和视频使用已配置且受后台支持的协议，异步原片从同源供应商地址下载。

后台运行会解析提示词中已保存的 `@图片` 引用。引用的画布图片缺失或历史原图版本变化时，节点会在请求供应商前报输入错误。请在编辑器重新选择原图并保存工作流。

`get_workflow_run` 按 `nextOffset` 分页读取节点状态、文本摘要和素材键。`imageCount` 表示该节点的图片数量。新生成的图片和视频会归档到已配置的保存目录，`historySaved` 和 `historySaveFailures` 分别报告归档成功和失败的数量。`get_run_image` 读取已保存或暂存的 PNG、JPEG、WebP 或 GIF，单张上限约 4.5 MB。

画面风格节点 VisualStyle 以 description 为主要编辑字段（最多 20000 字符）；styleDetailLevel 可取 minimal、low、medium、high、ultra（默认 medium），仅控制下次提取的描述详略，不改变当前风格文本；preset、medium、palette、lighting、texture、background、composition、typography、avoid 保留旧配置兼容。通过节点能力清单读取 preset 枚举。style 输出可连接图片生成或电商套图的 style 输入，每个目标只接一个风格。参考图接 image 输入，提取操作在节点参数浮层显式执行；普通运行只输出配置。内置 Agent 与 MCP 共用字段校验和连线规则。详见 [画面风格](visual-style.md)。
