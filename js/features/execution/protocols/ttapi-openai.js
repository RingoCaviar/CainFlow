/**
 * TTAPI OpenAI 协议插件 - 纯配置模式
 */
import { registerProtocol } from './index.js';

export const TtapiOpenaiProtocol = {
    "id": "ttapi-openai",
    "label": "TTAPI OpenAI",
    "taskTypes": [
        "image"
    ],
    "urlTemplate": "{{endpoint}}/v1/images/generations",
    "apikeyLocation": "header",
    "apikeyField": "TT-API-KEY",
    "parameters": {
        "referenceImages": {
            "portOnly": true,
            "max": 20,
            "label": "参考图输入",
            "dataType": "array",
            "id": "referenceImages",
            "exposed": true,
            "omitIfEmpty": true,
            "uiControl": "number",
            "portLabel": "参考图 {index}",
            "portType": "image",
            "defaultValue": "5",
            "requestField": "images",
            "step": 1,
            "portCount": 5,
            "required": false,
            "inputPort": true,
            "min": 0,
            "taskTypes": [
                "image"
            ]
        },
        "systemPrompt": {
            "id": "systemPrompt",
            "requestField": "prompt",
            "exposed": true,
            "inputPort": false,
            "portType": "text",
            "required": false,
            "omitIfEmpty": true,
            "dataType": "string",
            "uiControl": "textarea",
            "label": "系统提示词",
            "placeholder": "设定生成规则、风格或限制...",
            "rows": 2
        },
        "prompt": {
            "label": "提示词",
            "dataType": "string",
            "id": "prompt",
            "exposed": true,
            "omitIfEmpty": true,
            "uiControl": "textarea",
            "portType": "text",
            "required": true,
            "inputPort": true
        },
        "model": {
            "label": "模型",
            "dataType": "string",
            "id": "model",
            "exposed": false,
            "omitIfEmpty": false,
            "uiControl": "text",
            "portType": "text",
            "defaultValue": "{{modelId}}",
            "required": true,
            "inputPort": false
        },
        "size": {
            "label": "分辨率",
            "dataType": "string",
            "id": "size",
            "exposed": true,
            "omitIfEmpty": true,
            "uiControl": "select",
            "portType": "text",
            "options": [
                {
                    "value": "",
                    "label": "自动"
                },
                {
                    "value": "1024x1024",
                    "label": "1024x1024（方形）"
                },
                {
                    "value": "1792x1024",
                    "label": "1792x1024（横向）"
                },
                {
                    "value": "1024x1792",
                    "label": "1024x1792（纵向）"
                }
            ],
            "required": false,
            "inputPort": false
        },
        "quality": {
            "label": "质量",
            "dataType": "string",
            "id": "quality",
            "exposed": true,
            "omitIfEmpty": true,
            "uiControl": "select",
            "portType": "text",
            "defaultValue": "auto",
            "options": [
                {
                    "value": "auto",
                    "label": "默认"
                },
                {
                    "value": "low",
                    "label": "低"
                },
                {
                    "value": "medium",
                    "label": "中"
                },
                {
                    "value": "high",
                    "label": "高"
                }
            ],
            "required": false,
            "inputPort": false
        },
        "output_compression": {
            "label": "输出压缩",
            "dataType": "number",
            "id": "output_compression",
            "exposed": true,
            "omitIfEmpty": true,
            "uiControl": "number",
            "portType": "text",
            "defaultValue": 100,
            "required": false,
            "inputPort": false
        },
        "output_format": {
            "label": "输出格式",
            "dataType": "string",
            "id": "output_format",
            "exposed": true,
            "omitIfEmpty": true,
            "uiControl": "select",
            "portType": "text",
            "defaultValue": "png",
            "options": [
                {
                    "value": "png",
                    "label": "PNG（默认）"
                },
                {
                    "value": "jpeg",
                    "label": "JPEG"
                },
                {
                    "value": "webp",
                    "label": "WEBP"
                }
            ],
            "required": false,
            "inputPort": false,
            "taskTypes": [
                "image"
            ]
        },
        "background": {
            "label": "背景",
            "dataType": "string",
            "id": "background",
            "exposed": true,
            "omitIfEmpty": true,
            "uiControl": "select",
            "portType": "text",
            "defaultValue": "auto",
            "options": [
                {
                    "value": "auto",
                    "label": "自动"
                },
                {
                    "value": "opaque",
                    "label": "不透明"
                },
                {
                    "value": "transparent",
                    "label": "透明"
                }
            ],
            "required": false,
            "inputPort": false
        },
        "moderation": {
            "label": "审查",
            "dataType": "string",
            "id": "moderation",
            "exposed": true,
            "omitIfEmpty": true,
            "uiControl": "select",
            "portType": "text",
            "defaultValue": "auto",
            "options": [
                {
                    "value": "auto",
                    "label": "自动"
                },
                {
                    "value": "low",
                    "label": "低"
                }
            ],
            "required": false,
            "inputPort": false
        },
        "n": {
            "label": "生成数量",
            "dataType": "number",
            "id": "n",
            "exposed": false,
            "omitIfEmpty": false,
            "uiControl": "number",
            "defaultValue": 1,
            "requestField": "n",
            "required": false,
            "inputPort": false
        },
        "partial_images": {
            "label": "部分图片数量",
            "dataType": "number",
            "id": "partial_images",
            "exposed": false,
            "omitIfEmpty": false,
            "uiControl": "number",
            "defaultValue": 0,
            "requestField": "partial_images",
            "required": false,
            "inputPort": false
        },
        "stream": {
            "label": "流式响应",
            "dataType": "boolean",
            "id": "stream",
            "exposed": false,
            "omitIfEmpty": false,
            "uiControl": "toggle",
            "defaultValue": false,
            "requestField": "stream",
            "required": false,
            "inputPort": false
        },
        "user": {
            "label": "用户标识",
            "dataType": "string",
            "id": "user",
            "exposed": false,
            "omitIfEmpty": false,
            "uiControl": "text",
            "defaultValue": "",
            "requestField": "user",
            "required": false,
            "inputPort": false
        }
    },
    "responsePath": {
        "image": "data[0].url",
        "chat": "choices[0].message.content",
        "video": "data.video_url"
    },
    "helpText": "TTAPI OpenAI 格式，使用 TT-API-KEY 请求头，按模型用途走 /chat/completions 或 /images/generations"
};

registerProtocol(TtapiOpenaiProtocol);
