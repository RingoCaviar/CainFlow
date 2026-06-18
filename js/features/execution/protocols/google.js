/**
 * Google / Gemini 协议插件 - 纯配置模式
 */
import { registerProtocol } from './index.js';

export const GoogleProtocol = {
    "id": "google",
    "label": "Google / Gemini",
    "taskTypes": [
        "chat",
        "image"
    ],
    "urlTemplate": "{{endpoint}}/v1beta/models/{{model}}:generateContent",
    "apikeyLocation": "query",
    "apikeyField": "key",
    "parameters": {
        "referenceImages": {
            "requestField": "contents",
            "portOnly": true,
            "step": 1,
            "min": 0,
            "portLabel": "参考图 {index}",
            "id": "referenceImages",
            "portType": "image",
            "inputPort": true,
            "uiControl": "number",
            "label": "参考图输入",
            "dataType": "array",
            "defaultValue": "5",
            "portCount": 5,
            "max": 20,
            "exposed": false,
            "taskTypes": [
                "image"
            ],
            "omitIfEmpty": true,
            "required": false
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
            "id": "prompt",
            "portType": "text",
            "inputPort": true,
            "uiControl": "textarea",
            "label": "提示词",
            "dataType": "string",
            "exposed": true,
            "omitIfEmpty": true,
            "required": true
        },
        "aspect": {
            "options": [
                {
                    "value": "",
                    "label": "自动"
                },
                {
                    "value": "1:1",
                    "label": "1:1"
                },
                {
                    "value": "1:4",
                    "label": "1:4"
                },
                {
                    "value": "1:8",
                    "label": "1:8"
                },
                {
                    "value": "2:3",
                    "label": "2:3"
                },
                {
                    "value": "3:2",
                    "label": "3:2"
                },
                {
                    "value": "3:4",
                    "label": "3:4"
                },
                {
                    "value": "4:1",
                    "label": "4:1"
                },
                {
                    "value": "4:3",
                    "label": "4:3"
                },
                {
                    "value": "4:5",
                    "label": "4:5"
                },
                {
                    "value": "5:4",
                    "label": "5:4"
                },
                {
                    "value": "8:1",
                    "label": "8:1"
                },
                {
                    "value": "9:16",
                    "label": "9:16"
                },
                {
                    "value": "16:9",
                    "label": "16:9"
                },
                {
                    "value": "21:9",
                    "label": "21:9"
                }
            ],
            "id": "aspect",
            "portType": "text",
            "inputPort": false,
            "uiControl": "select",
            "label": "宽高比",
            "dataType": "string",
            "exposed": true,
            "omitIfEmpty": true,
            "required": false
        },
        "resolution": {
            "options": [
                {
                    "value": "",
                    "label": "默认 (1K)"
                },
                {
                    "value": "2K",
                    "label": "2K"
                },
                {
                    "value": "4K",
                    "label": "4K"
                }
            ],
            "id": "resolution",
            "portType": "text",
            "inputPort": false,
            "uiControl": "select",
            "label": "分辨率",
            "dataType": "string",
            "exposed": true,
            "omitIfEmpty": true,
            "required": false
        },
        "search": {
            "id": "search",
            "portType": "text",
            "inputPort": false,
            "uiControl": "toggle",
            "label": "启用搜索",
            "dataType": "boolean",
            "defaultValue": false,
            "exposed": true,
            "omitIfEmpty": true,
            "required": false
        },
        "image_search": {
            "id": "image_search",
            "portType": "text",
            "inputPort": false,
            "uiControl": "toggle",
            "label": "图片搜索",
            "dataType": "boolean",
            "defaultValue": false,
            "exposed": false,
            "omitIfEmpty": true,
            "required": false
        },
        "model": {
            "id": "model",
            "portType": "text",
            "inputPort": false,
            "uiControl": "text",
            "label": "模型",
            "dataType": "string",
            "defaultValue": "{{modelId}}",
            "exposed": false,
            "omitIfEmpty": false,
            "required": true
        }
    },
    "responsePath": {
        "image": "data[0].url",
        "chat": "choices[0].message.content",
        "video": "data.video_url"
    }
};

registerProtocol(GoogleProtocol);
