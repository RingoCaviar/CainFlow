# 通过 MCP 控制画布

CainFlow 提供本机 stdio MCP 接入。外部客户端可以读取当前画布、新建或修改受支持的节点、删除节点、调整连线、运行工作流并读取结果。每批成功的编辑会保存，可在 CainFlow 里一次撤销。

## 在 CainFlow 里启用

1. 在桌面版或 `http://127.0.0.1:8767/` 打开 CainFlow。进入 **设置 → 常规设置 → 外观与画布 → 画布 MCP**，打开开关。
2. 点击 **复制客户端配置**。首次连接时，使用 Python 3.11 或更新版本，在终端运行设置里提供的依赖安装命令。
3. 将复制的配置贴到支持本机 stdio 的 MCP 客户端，然后重载客户端。打开目标工作流，在客户端发「读取 CainFlow 当前画布」验证连接。

关闭开关立即停止接收外部调用，已经启动的工作流可在画布内操作。CainFlow 会记住开关状态。再次启用可继续使用原令牌。如果桌面版重启后分配了新端口，重新复制客户端配置。

MCP 接口仅接受本机回环连接。多个标签页打开 CainFlow 时，先切到目标标签页，再让客户端读取画布。若浏览器暂停了该页，切回即可恢复连接。配置内的令牌授予直接编辑和运行权限，请只粘贴到信任的本机客户端。

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
| `read_canvas` | 分页读取实时节点、参数、连线、端口和选中节点。返回 `editorId`、`workflowId`、`revision`。 |
| `list_models` | 列出已配置的生图模型、可用供应商 ID 及参数选项。 |
| `create_workflow` | 创建并打开空白工作流。可传 `name`，省略时自动命名。 |
| `list_history` | 分页读取当前保存目录的历史图片信息，包括 `id`、`fileVersion` 和备注。 |
| `annotate_history` | 使用历史图片的 `id` 和 `fileVersion` 保存备注。空备注清除现有备注。 |
| `import_history` | 按历史图片的 `id` 和 `fileVersion`，把原图导入当前画布。 |
| `list_prompts` | 分页读取提示词库，可按名称查询。 |
| `save_prompt` | 保存提示词。同名条目更新内容，保存结果由 CainFlow 持久化。 |
| `apply_prompt` | 将库中预设套用到指定节点的普通提示词或系统提示词。 |
| `edit_canvas` | 使用读取时的三个标识应用 v1 方案。支持新增、就地编辑、删除和连线。返回新的画布版本和步骤对应的实际节点 ID。 |
| `generate_image_batch` | 使用同一条提示词逐张处理选区或指定的画布图片。一次建图，可同时启动新批次。 |
| `run_workflow` | 启动当前工作流，或指定 `nodeIds` 只运行这些节点，或指定 `targetNodeId` 运行到该节点。返回 `runId`。 |
| `stop_workflow` | 停止当前工作流的运行。也可传 `nodeIds`，停止这些节点的运行分支。 |
| `undo_canvas` / `redo_canvas` | 撤销或重做当前工作流的一步画布操作。 |
| `get_workflow_run` | 使用 `editorId`、`workflowId`、`runId` 分页获取运行状态、节点结果、可用文本和图片信息。 |
| `get_run_image` | 从指定运行和节点读取一张已缓存图片，`index` 从零开始。 |

## 编辑节点与连线

`read_canvas` 的 `creatableTypes` 是可创建的节点类型，`editableFields` 是可写参数，`nodePatchFields` 是通用节点属性。没有可写参数清单的类型可按默认设置创建，步骤需填 `execute: false`。新建空节点时也使用 `execute: false`。

- 传 `nodeId` 编辑现有节点。使用 `patch` 的 `title`、`x`、`y`、`enabled` 来改名、移动或设置启用状态。其余受支持设置通过 `parameters` 修改。
- 连线目标用方案内的步骤 ID，来源可用步骤 ID 或现有节点 ID。断开某条线时，在 `disconnects` 项填写 `ref`、`port` 和读取到的 `connectionId`。省略 `connectionId` 表示清空这个输入。文本合并、文本拆分和图片合并按节点当前配置返回端口。缩减图片合并输入前，需明确断开会受影响的现有连线。
- 对话节点可编辑普通提示词、系统提示词及固定设置。视频生成可编辑提示词、比例和生成次数。调色节点可编辑白平衡、色温、色调、自然饱和度和饱和度。使用 `parameterOptions` 核对当前节点的枚举值或取值范围。
- 电商套图节点的 `parameters.productInfo` 支持按字段更新 `name`（商品名称）、`sellingPoints`（核心卖点，字符串数组）、`audience`（目标人群）、`useCases`（使用场景）和 `details`（商品资料）。`parameters.copyLanguage` 设置图中文字的语言，从 `parameterOptions.copyLanguage` 选择语言代码，例如 `auto`、`en` 或 `ja`。修改语言后在节点参数列重新生成方案。步骤使用 `execute: false`。
- 需要生成的新生图节点填写 `parameters.prompt`。生图步骤和批处理的 `modelId` 传 `list_models` 返回的配置项 `id`，`providerId` 传对应供应商的 `id`。未指定模型时，新节点使用 Agent 面板的选择。

编辑、运行、停止、撤销和重做都需要 `read_canvas` 返回的编辑器、工作流和画布版本。内置 Agent 可以直接处理「运行选中的节点」「运行节点『主图』」「运行到『主图』」「停止当前工作流」「撤销上一步」「重做上一步」。模型规划的已有节点编辑会先展示就地变更预览。

## 批量处理选中图片

在画布选中原图后，可对客户端说「给这些图统一换成浅灰背景，比例 4:5，逐张出图并直接运行」。客户端先调用 `read_canvas`，再将返回的三个标识、共用 `prompt` 和 `parameters` 传给 `generate_image_batch`。参数如 `{"aspect":"4:5","resolution":"2K"}`，具体取值以所选模型为准。指定 `sourceNodeIds` 时按该列表选图。省略时使用读取得到的选区，优先使用选中的图片导入节点。画布或选区发生变化后需重新读取。

传 `run: true` 时，在建图保存后只运行本批新建分支，用返回的 `run.runId` 查询进度。省略 `run` 时只建图。结果带 `runError` 时说明建图已保存，可以用返回的节点 ID 继续运行。分支运行失败时，可用节点 ID 在 CainFlow 画布查看详细错误。一次批处理最多 100 个画布操作，每张单图对应生图和预览两个节点，多图输出中的每张图额外建立一个原图引用节点。

使用 `read_canvas` 的 `parameterOptions` 查看当前生图节点的比例、分辨率档位及其他枚举值。用档位值填写 `resolution`，空字符串对应控件的默认项。模型支持时，可在 `protocolParams` 内填写 `systemPrompt`、`output_format` 等协议字段。

权限范围见 [画布能力规范](adr/0025-scoped-canvas-automation.md)。

## 空白工作流、历史备注与提示词库

`create_workflow` 返回新工作流的 ID 和名称。打开后先调用 `read_canvas`，再编辑新画布。创建前会保存原工作流，名称不能与现有工作流重名。`create_workflow`、`list_history`、`annotate_history`、`list_prompts` 和 `save_prompt` 使用当前已连接的编辑器，可选传 `editorId` 固定目标。

`list_history` 返回当前保存目录中的图片信息。给某张图添加备注时，把该条目的 `id` 和 `fileVersion` 传给 `annotate_history`。原文件被替换或保存目录已切换时请重新列出。备注最长 80 个字符。

提示词库由 CainFlow 持久化，内置 Agent、MCP 和界面使用同一份库。可在内置 Agent 输入「新建空白工作流，命名为『商品评审』」「给最新一张历史图片加备注：正面样片」「保存提示词『白底规则』：保留包装文字，使用柔光」。也可以输入「查看历史图片」或「查看提示词库」。

此前只存在浏览器里的提示词库，可从原来的 CainFlow 地址打开 **设置 → 旧浏览器数据迁移**，迁入当前数据目录。

## 导入历史图片与套用库提示词

`import_history` 与 `apply_prompt` 都需要 `read_canvas` 返回的 `editorId`、`workflowId` 和 `revision`。每次成功编辑后返回新的画布版本。一次导入或套用可撤销一次。

- `import_history` 的 `items` 接收 1 至 20 项 `{id, fileVersion}`，从 `list_history` 获取。文件变化或切换保存目录时，重新读取列表。导入使用原图并创建图片导入节点。内置 Agent 可接受「把历史图片 ID 42、53 导入当前画布」。
- `apply_prompt` 接收 `nodeId`、唯一的 `promptId` 或精确的 `name`，以及 `target`。普通提示词用 `prompt`，支持文本、对话和图片生成节点。对话或生图节点接入独享的可写文本时，编辑该文本节点。需要修改共享文本时，请直接指定文本节点。系统提示词用 `system`，可在 `read_canvas` 中通过 `supportsSystemPrompt` 识别支持的对话或生图节点。内置 Agent 可接受「把库里的『白底规则』套用到选中节点的系统提示词」，并在修改前展示预览。

收到画布版本过期、编辑器切换或请求超时时，先重新读取画布，确认当前状态后再提交改动。运行记录与图片暂存在发起运行的编辑器内。运行结果的 `imageCount` 是该节点产出的图片数量。`get_run_image` 可读取其中留在缓存里的 PNG、JPEG、WebP 或 GIF，单张上限约 4.5 MB。

画面风格节点 VisualStyle 支持 preset、description、medium、palette、lighting、texture、background、composition、typography、avoid。通过节点能力清单读取 preset 枚举。style 输出可连接图片生成或电商套图的 style 输入，每个目标只接一个风格。参考图接 image 输入，提取操作在节点内显式执行；普通运行只输出配置。内置 Agent 与 MCP 共用字段校验和连线规则。详见 [画面风格](visual-style.md)。
