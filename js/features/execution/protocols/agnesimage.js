/**
 * Agnes Image 协议插件 - 纯配置模式
 */
import { registerProtocol } from './index.js';

export const AgnesimageProtocol = {
    id: 'agnesimage',
    label: 'Agnes Image',
    taskTypes: ["image"],

    // URL模板
    urlTemplate: '{{endpoint}}/v1/images/generations',

    // API Key 配置
    apikeyLocation: 'header',
    apikeyField: 'Authorization: Bearer {apikey} ',

    // 参数定义
    parameters: {
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
            step: 1
        },

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
            uiControl: 'text',
            label: '提示词',
        },
        size: {
            id: 'size',
            exposed: true,
            inputPort: false,
            portType: 'text',
            required: true,
            omitIfEmpty: false,
            dataType: 'string',
            uiControl: 'text',
            label: '分辨率',
            defaultValue: '1024x768',
        },
    },

    // 响应解析路径
    responsePath: {
        image: 'data[0].url',
        chat: 'choices[0].message.content',
        video: 'data.video_url'
    }
};

registerProtocol(AgnesimageProtocol);
