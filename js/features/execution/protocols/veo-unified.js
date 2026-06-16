/**
 * VEO 视频 · 统一格式协议插件 - 纯配置模式
 */
import { registerProtocol } from './index.js';

export const VeoUnifiedProtocol = {
    id: 'veo-unified',
    label: 'VEO 视频 · 统一格式',
    taskTypes: ['video'],
    helpText: 'VEO 统一视频生成格式，支持文生视频和图生视频',

    // URL模板
    urlTemplate: '{{endpoint}}/video/create',

    // API Key 配置
    apikeyLocation: 'query',
    apikeyField: 'key',

    // 视频元数据
    videoMeta: {
        supportsImage: true,
        requiresPolling: true
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
            requestField: 'images',
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

        aspect_ratio: {
            id: 'aspect_ratio',
            exposed: true,
            inputPort: false,
            dataType: 'string',
            uiControl: 'select',
            label: '宽高比',
            taskTypes: ['video'],
            options: [
                { value: '9:16', label: '9:16 竖屏' },
                { value: '16:9', label: '16:9 横屏' }
            ],
            defaultValue: '9:16',
            requestField: 'aspect_ratio'
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
        }
    },

    // 响应解析路径
    responsePath: {
        video: 'video_url'
    }
};

registerProtocol(VeoUnifiedProtocol);
