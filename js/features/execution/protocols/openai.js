/**
 * OpenAI 兼容 协议插件 - 纯配置模式
 */
import { registerProtocol } from './index.js';

function imageSelect(id, label, choices) {
    return {
        id, label, exposed: true, inputPort: false, portType: 'text', required: false,
        omitIfEmpty: true, dataType: 'string', uiControl: 'select', taskTypes: ['image'],
        options: [{ value: '', label: '默认' }, ...choices.map(([value, name]) => ({ value, label: name }))]
    };
}

export const OpenaiProtocol = {
    id: 'openai',
    label: 'OpenAI 兼容',
    taskTypes: ["chat", "image"],

    // URL模板
    urlTemplate: '{{endpoint}}/v1/images/generations',

    // API Key 配置
    apikeyLocation: 'header',
    apikeyField: 'Authorization',

    // 参数定义
    parameters: {
        model: {
            id: 'model',
            exposed: false,
            inputPort: false,
            portType: 'text',
            required: true,
            omitIfEmpty: false,
            dataType: 'string',
            uiControl: 'text',
            label: '模型',
            defaultValue: '{{modelId}}',
        },
        referenceImages: {
            id: 'referenceImages',
            exposed: true,
            inputPort: true,
            portType: 'image',
            portCount: 5,
            portLabel: '参考图 {index}',
            requestField: 'reference_images',
            portOnly: true,
            required: false,
            omitIfEmpty: true,
            dataType: 'array',
            uiControl: 'number',
            label: '参考图输入',
            defaultValue: 5,
            min: 0,
            max: 20,
            step: 1,
            taskTypes: ['image']
        },
        systemPrompt: {
            id: 'systemPrompt',
            requestField: 'prompt',
            exposed: true,
            inputPort: false,
            portType: 'text',
            required: false,
            omitIfEmpty: true,
            dataType: 'string',
            uiControl: 'textarea',
            label: '系统提示词',
            placeholder: '设定生成规则、风格或限制...',
            rows: 2,
        },
        prompt: {
            id: 'prompt',
            exposed: true,
            inputPort: true,
            portType: 'text',
            required: true,
            omitIfEmpty: true,
            dataType: 'string',
            uiControl: 'textarea',
            label: '提示词',
        },
        resolution: {
            id: 'resolution',
            requestField: 'size',
            exposed: true,
            inputPort: false,
            portType: 'text',
            required: true,
            omitIfEmpty: true,
            dataType: 'string',
            uiControl: 'select',
            label: '分辨率',
            options: [
                    {
                                        "value": "",
                                        "label": "自动 (auto)"
                    },
                    {
                                        "value": "1024x1024",
                                        "label": "1024×1024 · 1:1 方图"
                    },
                    {
                                        "value": "1024x768",
                                        "label": "1024×768 · 4:3 1K 横图"
                    },
                    {
                                        "value": "768x1024",
                                        "label": "768×1024 · 3:4 1K 竖图"
                    },
                    {
                                        "value": "1536x1024",
                                        "label": "1536×1024 · 3:2 横图"
                    },
                    {
                                        "value": "1024x1536",
                                        "label": "1024×1536 · 2:3 竖图"
                    },
                    {
                                        "value": "2048x2048",
                                        "label": "2048×2048 · 1:1 2K 方图"
                    },
                    {
                                        "value": "2048x1536",
                                        "label": "2048×1536 · 4:3 2K 横图"
                    },
                    {
                                        "value": "1536x2048",
                                        "label": "1536×2048 · 3:4 2K 竖图"
                    },
                    {
                                        "value": "2048x1152",
                                        "label": "2048×1152 · 16:9 2K 横图"
                    },
                    {
                                        "value": "1152x2048",
                                        "label": "1152×2048 · 9:16 2K 竖图"
                    },
                    {
                                        "value": "2880x2880",
                                        "label": "2880×2880 · 1:1 4K 方图"
                    },
                    {
                                        "value": "3072x2304",
                                        "label": "3072×2304 · 4:3 4K 横图"
                    },
                    {
                                        "value": "2304x3072",
                                        "label": "2304×3072 · 3:4 4K 竖图"
                    },
                    {
                                        "value": "3840x2160",
                                        "label": "3840×2160 · 16:9 4K 横图"
                    },
                    {
                                        "value": "2160x3840",
                                        "label": "2160×3840 · 9:16 4K 竖图"
                    },
                    {
                                        "value": "custom",
                                        "label": "自定义"
                    }
],
        },
        quality: {
            id: 'quality',
            exposed: true,
            inputPort: false,
            portType: 'text',
            required: false,
            omitIfEmpty: true,
            dataType: 'string',
            uiControl: 'select',
            label: '质量',
            options: [
                    {
                                        "value": "",
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
                    },
                    {
                                        "value": "auto",
                                        "label": "自动"
                    }
],
        },
        moderation: {
            id: 'moderation',
            exposed: true,
            inputPort: false,
            portType: 'text',
            required: false,
            omitIfEmpty: true,
            dataType: 'string',
            uiControl: 'select',
            label: '内容审核',
            options: [
                    {
                                        "value": "",
                                        "label": "默认"
                    },
                    {
                                        "value": "auto",
                                        "label": "自动"
                    },
                    {
                                        "value": "low",
                                        "label": "低"
                    }
],
        },
        background: {
            id: 'background',
            exposed: true,
            inputPort: false,
            portType: 'text',
            required: false,
            omitIfEmpty: true,
            dataType: 'string',
            uiControl: 'select',
            label: '背景',
            options: [
                    {
                                        "value": "",
                                        "label": "默认"
                    },
                    {
                                        "value": "auto",
                                        "label": "自动"
                    },
                    {
                                        "value": "transparent",
                                        "label": "透明"
                    },
                    {
                                        "value": "opaque",
                                        "label": "不透明"
                    }
],
        },
        output_format: imageSelect('output_format', '输出格式', [
            ['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP']
        ]),
        output_compression: {
            id: 'output_compression',
            exposed: true,
            inputPort: false,
            portType: 'text',
            required: false,
            omitIfEmpty: true,
            dataType: 'number',
            uiControl: 'number',
            label: '输出压缩 (%)',
            min: 0,
            max: 100,
            step: 1,
            taskTypes: ['image']
        },
        input_fidelity: imageSelect('input_fidelity', '参考图保真度', [
            ['low', '低'], ['high', '高']
        ]),
        style: imageSelect('style', '风格', [
            ['vivid', '鲜明'], ['natural', '自然']
        ]),
        response_format: imageSelect('response_format', '返回格式', [
            ['url', '图片链接'], ['b64_json', 'Base64 图片']
        ]),
        complexity: imageSelect('complexity', '构图规划', [
            ['low', '低'], ['medium', '中'], ['high', '高']
        ]),
        n: {
            id: 'n',
            requestField: 'n',
            exposed: false,
            inputPort: false,
            required: false,
            omitIfEmpty: false,
            dataType: 'number',
            uiControl: 'number',
            label: '生成数量',
            defaultValue: 1,
        },
    },

    // 响应解析路径
    responsePath: {
        image: 'data[0].url',
        chat: 'choices[0].message.content',
        video: 'data.video_url'
    }
};

registerProtocol(OpenaiProtocol);
