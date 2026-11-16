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
| `list_prompts` | 分页读取提示词库，可按名称查询。 |
| `save_prompt` | 保存提示词。同名条目更新内容，保存结果由 CainFlow 持久化。 |
| `edit_canvas` | 使用读取时的三个标识应用 v1 方案。支持新增、就地编辑、删除和连线。返回新的画布版本和步骤对应的实际节点 ID。 |
| `generate_image_batch` | 使用同一条提示词逐张处理选区或指定的画布图片。一次建图，可同时启动新批次。 |
| `run_workflow` | 使用读取时的三个标识启动当前工作流，可限定节点。使用现有模型和供应商配置，返回 `runId`。 |
| `get_workflow_run` | 使用 `editorId`、`workflowId`、`runId` 分页获取运行状态、节点结果、可用文本和图片信息。 |
| `get_run_image` | 从指定运行和节点读取一张已缓存图片，`index` 从零开始。 |

可编辑 `Text`、`ImageImport`、`ImageGenerate`、`ImageResize`、`ImageMerge`、`ImagePreview`、`ImageCompare`。编辑引用现有节点时传入 `nodeId`。连线目标用方案的步骤 ID，来源可用步骤 ID 或已存在的节点 ID。新增生图节点时填写 `parameters.prompt`。生图步骤和批处理的 `modelId` 传 `list_models` 返回的配置项 `id`，`providerId` 传对应供应商的 `id`。未指定模型时，新节点使用 Agent 面板的选择。

## 批量处理选中图片

在画布选中原图后，可对客户端说「给这些图统一换成浅灰背景，比例 4:5，逐张出图并直接运行」。客户端先调用 `read_canvas`，再将返回的三个标识、共用 `prompt` 和 `parameters` 传给 `generate_image_batch`。参数如 `{"aspect":"4:5","resolution":"2K"}`，具体取值以所选模型为准。指定 `sourceNodeIds` 时按该列表选图。省略时使用读取得到的选区，优先使用选中的图片导入节点。画布或选区发生变化后需重新读取。

传 `run: true` 时，在建图保存后只运行本批新建分支，用返回的 `run.runId` 查询进度。省略 `run` 时只建图。结果带 `runError` 时说明建图已保存，可以用返回的节点 ID 继续运行。分支运行失败时，可用节点 ID 在 CainFlow 画布查看详细错误。一次批处理最多 100 个画布操作，每张单图对应生图和预览两个节点，多图输出中的每张图额外建立一个原图引用节点。

使用 `read_canvas` 的 `parameterOptions` 查看当前生图节点的比例、分辨率档位及其他枚举值。用档位值填写 `resolution`，空字符串对应控件的默认项。模型支持时，可在 `protocolParams` 内填写 `systemPrompt`、`output_format` 等协议字段。

权限范围见 [画布能力规范](adr/0025-scoped-canvas-automation.md)。

## 空白工作流、历史备注与提示词库

`create_workflow` 返回新工作流的 ID 和名称。打开后先调用 `read_canvas`，再编辑新画布。创建前会保存原工作流，名称不能与现有工作流重名。以上五个应用工具使用当前已连接的编辑器，可选传 `editorId` 固定目标。

`list_history` 返回当前保存目录中的图片信息。给某张图添加备注时，把该条目的 `id` 和 `fileVersion` 传给 `annotate_history`。原文件被替换或保存目录已切换时请重新列出。备注最长 80 个字符。

提示词库由 CainFlow 持久化，内置 Agent、MCP 和界面使用同一份库。可在内置 Agent 输入「新建空白工作流，命名为『商品评审』」「给最新一张历史图片加备注：正面样片」「保存提示词『白底规则』：保留包装文字，使用柔光」。也可以输入「查看历史图片」或「查看提示词库」。

此前只存在浏览器里的提示词库，可从原来的 CainFlow 地址打开 **设置 → 旧浏览器数据迁移**，迁入当前数据目录。

收到画布版本过期、编辑器切换或请求超时时，先重新读取画布，确认当前状态后再提交改动。运行记录与图片暂存在发起运行的编辑器内。运行结果的 `imageCount` 是该节点产出的图片数量。`get_run_image` 可读取其中留在缓存里的 PNG、JPEG、WebP 或 GIF，单张上限约 4.5 MB。
