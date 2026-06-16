/**
 * NEW API 异步图片生成协议 - 纯配置模式
 */
import { registerProtocol } from './index.js';

export const NewapiImageAsyncProtocol = {
    id: 'newapi-image-async',
    label: 'NEW API 异步图片',
    taskTypes: ['image'],
    helpText: 'NEW API 异步图片生成协议，提交任务后轮询获取结果',

    // URL模板
    urlTemplate: '{{endpoint}}/v1/images/async/generations',

    // API Key 配置
    apikeyLocation: 'header',
    apikeyField: 'Authorization',

    // 固定参数
    fixedParams: {
        n: 1,
        response_format: 'url'
    },

    // 参数定义
    parameters: {
        referenceImages: {
            id: 'referenceImages',
            exposed: true,
            inputPort: true,
            portType: 'image',
            portCount: 5,
            portLabel: '参考图 {index}',
            requestField: 'image_urls',
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

        prompt: {
            id: 'prompt',
            label: '提示词',
            exposed: true,
            inputPort: true,
            required: true,
            dataType: 'string',
            uiControl: 'textarea',
            taskTypes: ['image'],
            requestField: 'prompt'
        },

        size: {
            id: 'size',
            exposed: true,
            inputPort: false,
            dataType: 'string',
            uiControl: 'select',
            label: '尺寸',
            taskTypes: ['image'],
            options: [
                { value: '1024x1024', label: '1024×1024' },
                { value: '1792x1024', label: '1792×1024' },
                { value: '1024x1792', label: '1024×1792' }
            ],
            defaultValue: '1024x1024',
            requestField: 'size'
        },

        quality: {
            id: 'quality',
            exposed: true,
            inputPort: false,
            dataType: 'string',
            uiControl: 'select',
            label: '质量',
            taskTypes: ['image'],
            options: [
                { value: 'standard', label: '标准' },
                { value: 'hd', label: '高清' }
            ],
            defaultValue: 'standard',
            requestField: 'quality'
        },

        style: {
            id: 'style',
            exposed: true,
            inputPort: false,
            dataType: 'string',
            uiControl: 'select',
            label: '风格',
            taskTypes: ['image'],
            options: [
                { value: 'vivid', label: '生动' },
                { value: 'natural', label: '自然' }
            ],
            defaultValue: 'vivid',
            requestField: 'style'
        }
    },

    // 响应解析路径
    responsePath: {
        image: 'data[0].url'
    }
};

registerProtocol(NewapiImageAsyncProtocol);
