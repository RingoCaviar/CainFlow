/**
 * VEO 视频 · OpenAI 视频格式协议插件 - 纯配置模式
 */
import { registerProtocol } from './index.js';

export const VeoOpenAIProtocol = {
    id: 'veo-openai',
    label: 'VEO 视频 · OpenAI 格式',
    taskTypes: ['video'],
    helpText: 'VEO OpenAI 视频生成格式，兼容 OpenAI 视频 API 规范',

    // URL模板
    urlTemplate: '{{endpoint}}/v1/video/generations',

    // API Key 配置
    apikeyLocation: 'header',
    apikeyField: 'Authorization',

    // 视频元数据
    videoMeta: {
        supportsImage: true,
        requiresPolling: true
    },

    // 固定参数
    fixedParams: {
        n: 1
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
            requestField: 'image',
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
            taskTypes: ['video'],
            requestField: 'prompt'
        },

        duration: {
            id: 'duration',
            exposed: true,
            inputPort: false,
            dataType: 'string',
            uiControl: 'select',
            label: '时长',
            taskTypes: ['video'],
            options: [
                { value: '8s', label: '8秒' },
                { value: '16s', label: '16秒' }
            ],
            defaultValue: '8s',
            requestField: 'duration'
        },

        size: {
            id: 'size',
            exposed: true,
            inputPort: false,
            dataType: 'string',
            uiControl: 'select',
            label: '尺寸',
            taskTypes: ['video'],
            options: [
                { value: '720x1280', label: '720×1280 (9:16)' },
                { value: '1280x720', label: '1280×720 (16:9)' }
            ],
            defaultValue: '720x1280',
            requestField: 'size'
        },

        loop: {
            id: 'loop',
            exposed: true,
            inputPort: false,
            dataType: 'boolean',
            uiControl: 'toggle',
            label: '循环播放',
            taskTypes: ['video'],
            defaultValue: false,
            requestField: 'loop'
        },

        response_format: {
            id: 'response_format',
            exposed: false,
            inputPort: false,
            dataType: 'string',
            uiControl: 'select',
            label: '响应格式',
            taskTypes: ['video'],
            options: [
                { value: 'url', label: 'URL' }
            ],
            defaultValue: 'url',
            requestField: 'response_format'
        }
    },

    // 响应解析路径
    responsePath: {
        video: 'data[0].url'
    }
};

registerProtocol(VeoOpenAIProtocol);
