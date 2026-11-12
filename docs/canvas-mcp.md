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
| `edit_canvas` | 使用读取时的三个标识应用 v1 方案。支持新增、就地编辑、删除和连线。返回新的画布版本和步骤对应的实际节点 ID。 |
| `run_workflow` | 使用读取时的三个标识启动当前工作流，可限定节点。使用现有模型和供应商配置，返回 `runId`。 |
| `get_workflow_run` | 使用 `editorId`、`workflowId`、`runId` 分页获取运行状态、节点结果、可用文本和图片信息。 |
| `get_run_image` | 从指定运行和节点读取一张已缓存图片，`index` 从零开始。 |

首版可编辑 `Text`、`ImageImport`、`ImageGenerate`、`ImageResize`、`ImageMerge`、`ImagePreview`、`ImageCompare`。编辑引用现有节点时传入 `nodeId`。连线目标用方案的步骤 ID，来源可用步骤 ID 或已存在的节点 ID。新增生图节点时填写 `parameters.prompt`，并在 CainFlow 中配置可用的生图模型和供应商。若模型绑定多个供应商，在 Agent 面板选择要用的生图模型和供应商。

收到画布版本过期、编辑器切换或请求超时时，先重新读取画布，确认当前状态后再提交改动。运行记录与图片暂存在发起运行的编辑器内。运行结果的 `imageCount` 是该节点产出的图片数量。`get_run_image` 可读取其中留在缓存里的 PNG、JPEG、WebP 或 GIF，单张上限约 4.5 MB。
