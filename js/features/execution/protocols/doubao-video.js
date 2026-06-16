/**
 * 豆包视频生成协议插件 - 纯配置模式
 */
import { registerProtocol } from './index.js';

export const DoubaoVideoProtocol = {
    id: 'doubao-video',
    label: '豆包视频',
    taskTypes: ['video'],
    helpText: '豆包视频生成协议，支持文生视频和图生视频',

    // URL模板
    urlTemplate: '{{endpoint}}/api/v3/video/generations',

    // API Key 配置
    apikeyLocation: 'header',
    apikeyField: 'Authorization',

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
            requestField: 'content',
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
            dataType: 'number',
            uiControl: 'select',
            label: '时长（秒）',
            taskTypes: ['video'],
            options: [
                { value: 5, label: '5秒' },
                { value: 10, label: '10秒' }
            ],
            defaultValue: 5,
            requestField: 'duration'
        },

        resolution: {
            id: 'resolution',
            exposed: true,
            inputPort: false,
            dataType: 'string',
            uiControl: 'select',
            label: '分辨率',
            taskTypes: ['video'],
            options: [
                { value: '720p', label: '720p' },
                { value: '1080p', label: '1080p' }
            ],
            defaultValue: '720p',
            requestField: 'resolution'
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
                { value: '16:9', label: '16:9' },
                { value: '9:16', label: '9:16' },
                { value: '1:1', label: '1:1' }
            ],
            defaultValue: '16:9',
            requestField: 'aspect_ratio'
        },

        loop: {
            id: 'loop',
            exposed: false,
            inputPort: false,
            dataType: 'boolean',
            uiControl: 'toggle',
            label: '循环播放',
            taskTypes: ['video'],
            defaultValue: false,
            requestField: 'loop',
            description: '生成可循环播放的视频'
        }
    },

    // 响应解析路径
    responsePath: {
        video: 'data.video_url'
    }
};

registerProtocol(DoubaoVideoProtocol);
