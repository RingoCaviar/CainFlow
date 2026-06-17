# 协议图片编辑路径配置功能

## 功能说明

在协议编辑界面中，你现在可以为支持图片编辑的 API 配置专门的编辑路径。当生图节点接收到参考图片输入时，系统会自动使用配置的图片编辑路径，而不是默认的图片生成路径。

## 使用场景

这个功能主要用于适配以下 API 场景：

1. **OpenAI 风格的 API**
   - 生成图片：`/v1/images/generations`
   - 编辑图片：`/v1/images/edits`

2. **第三方兼容 API**
   - 有些第三方 API 使用不同的路径来区分生成和编辑操作
   - 例如：`/api/generate` vs `/api/edit`

## 配置方法

### 1. 打开协议开发者面板

在设置界面中点击"协议开发者面板"按钮。

### 2. 编辑协议

选择你要配置的协议（如 `openai` 或 `ttapi-openai`），点击"编辑参数"。

### 3. 配置路径

在基本信息区域，你会看到两个路径字段：

- **请求路径模板**：默认路径，用于普通图片生成
  - 例如：`{{endpoint}}/v1/images/generations`
  
- **图片编辑路径（可选）**：当有参考图输入时使用的路径
  - 例如：`{{endpoint}}/v1/images/edits`

### 4. 保存配置

点击"💾 保存配置"按钮，配置会保存到本地文件。

## 工作原理

系统会在运行时检测生图节点的输入：

1. **无参考图**：使用"请求路径模板"中配置的路径
   ```
   POST https://api.example.com/v1/images/generations
   ```

2. **有参考图**：自动切换到"图片编辑路径"
   ```
   POST https://api.example.com/v1/images/edits
   ```

### 参考图检测逻辑

系统会检查以下输入端口：
- `image`
- `referenceImages`
- `image_1`, `image_2`, `image_3` 等

只要任何一个端口有有效的图片输入（URL 或 Base64），就会使用图片编辑路径。

## 配置示例

### OpenAI 协议配置

```json
{
  "id": "openai",
  "label": "OpenAI 兼容",
  "urlTemplate": "{{endpoint}}/v1/images/generations",
  "urlTemplates": {
    "image": "{{endpoint}}/v1/images/generations",
    "imageEdit": "{{endpoint}}/v1/images/edits"
  }
}
```

### 自定义第三方 API

```json
{
  "id": "my-custom-api",
  "label": "我的自定义 API",
  "urlTemplate": "{{endpoint}}/api/image/generate",
  "urlTemplates": {
    "image": "{{endpoint}}/api/image/generate",
    "imageEdit": "{{endpoint}}/api/image/modify"
  }
}
```

## 预览功能

在协议编辑界面的"请求体预览"区域，你可以看到生成的请求信息。

如果配置了图片编辑路径，预览中会显示：
- `url`：无参考图时使用的 URL
- `url_with_reference_images`：有参考图时使用的 URL（仅在两者不同时显示）

## 注意事项

1. **留空表示不启用**：如果"图片编辑路径"留空，系统会对所有情况使用默认路径模板
2. **变量支持**：两个路径字段都支持以下变量：
   - `{{endpoint}}`：API 端点
   - `{{model}}`：模型 ID
   - `{{taskType}}`：任务类型
3. **向后兼容**：未配置 `urlTemplates.imageEdit` 的协议会继续使用原有逻辑

## 测试方法

1. 配置协议后，创建一个图片生成节点
2. 不连接参考图输入，运行节点 → 应该使用默认路径
3. 连接一个图片节点到参考图输入端口，再次运行 → 应该使用编辑路径
4. 检查网络请求（开发者工具）确认路径是否正确切换

## 技术实现

### 核心文件

- `js/features/execution/protocols/request-builder.js`：URL 构建逻辑
- `js/features/settings/protocol-developer-panel.js`：协议编辑界面

### 关键函数

- `hasReferenceImages(inputs)`：检测是否有参考图输入
- `buildUrlFromTemplate(protocol, context)`：根据条件选择路径模板
