/**
 * TTAPI Gemini 协议插件 - 纯配置模式
 */
import { registerProtocol } from './index.js';

export const TtapiProtocol = {
    "id": "ttapi",
    "label": "TTAPI Gemini",
    "taskTypes": [
        "image"
    ],
    "urlTemplate": "{{endpoint}}/gemini/chat/completions",
    "apikeyLocation": "header",
    "apikeyField": "TT-API-KEY",
    "parameters": {
        "referenceImages": {
            "requestField": "refer_images",
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
            "exposed": true,
            "taskTypes": [
                "image"
            ],
            "omitIfEmpty": true,
            "required": false
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
        "model": {
            "requestField": "model",
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
        },
        "aspect_ratio": {
            "requestField": "aspect_ratio",
            "options": [
                {
                    "value": "1:1",
                    "label": "1:1 方图"
                },
                {
                    "value": "2:3",
                    "label": "2:3 竖图"
                },
                {
                    "value": "3:2",
                    "label": "3:2 横图"
                },
                {
                    "value": "3:4",
                    "label": "3:4 竖图"
                },
                {
                    "value": "4:3",
                    "label": "4:3 横图"
                },
                {
                    "value": "4:5",
                    "label": "4:5 竖图"
                },
                {
                    "value": "5:4",
                    "label": "5:4 横图"
                },
                {
                    "value": "9:16",
                    "label": "9:16 竖图"
                },
                {
                    "value": "16:9",
                    "label": "16:9 横图"
                },
                {
                    "value": "21:9",
                    "label": "21:9 超宽画幅"
                },
                {
                    "value": "1:4",
                    "label": "1:4 竖图"
                },
                {
                    "value": "4:1",
                    "label": "4:1 横图"
                },
                {
                    "value": "1:8",
                    "label": "1:8 超宽竖图"
                },
                {
                    "value": "8:1",
                    "label": "8:1 超宽横幅"
                }
            ],
            "id": "aspect_ratio",
            "portType": "text",
            "inputPort": false,
            "uiControl": "select",
            "label": "宽高比",
            "dataType": "string",
            "defaultValue": "1:1",
            "exposed": true,
            "taskTypes": [
                "image"
            ],
            "omitIfEmpty": true,
            "required": true
        },
        "image_size": {
            "requestField": "image_size",
            "options": [
                {
                    "value": "1K",
                    "label": "1K"
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
            "id": "image_size",
            "portType": "text",
            "inputPort": false,
            "uiControl": "select",
            "label": "分辨率",
            "dataType": "string",
            "defaultValue": "1K",
            "exposed": true,
            "taskTypes": [
                "image"
            ],
            "omitIfEmpty": true,
            "required": false
        },
        "google_search": {
            "requestField": "google_search",
            "id": "google_search",
            "portType": "text",
            "inputPort": false,
            "uiControl": "toggle",
            "label": "启用搜索",
            "dataType": "boolean",
            "defaultValue": false,
            "exposed": true,
            "taskTypes": [
                "image"
            ],
            "omitIfEmpty": true,
            "required": false
        },
        "image_search": {
            "requestField": "image_search",
            "id": "image_search",
            "portType": "text",
            "inputPort": false,
            "uiControl": "toggle",
            "label": "图片搜索",
            "dataType": "boolean",
            "defaultValue": false,
            "exposed": true,
            "taskTypes": [
                "image"
            ],
            "omitIfEmpty": true,
            "required": false
        },
        "thinking_level": {
            "requestField": "thinking_level",
            "options": [
                {
                    "value": "",
                    "label": "默认"
                },
                {
                    "value": "Minimal",
                    "label": "Minimal"
                },
                {
                    "value": "High",
                    "label": "High"
                }
            ],
            "id": "thinking_level",
            "portType": "text",
            "inputPort": false,
            "uiControl": "select",
            "label": "思考强度",
            "dataType": "string",
            "exposed": true,
            "taskTypes": [
                "image"
            ],
            "omitIfEmpty": true,
            "required": false
        }
    },
    "responsePath": {
        "image": "data.image_url",
        "chat": "choices[0].message.content",
        "video": "data.video_url"
    },
    "helpText": "TTAPI Gemini Chat 走 /gemini/chat/completions，Gemini 生图走 /gemini/image/generate；请求头使用 TT-API-KEY，Chat 响应读取 choices[0].message.content，生图响应读取 data.image_url。",
    "urlTemplates": {
        "chat": "{{endpoint}}/gemini/chat/completions",
        "image": "{{endpoint}}/gemini/image/generate"
    }
};

registerProtocol(TtapiProtocol);
