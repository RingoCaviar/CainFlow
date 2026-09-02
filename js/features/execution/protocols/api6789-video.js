/** 6789中转视频协议：Kling O3 与 MiniMax H3 由精确模型变体区分。 */
import { registerProtocol } from './index.js';

export const RelayVideoProtocol = {
    id: 'async-video-api',
    label: '6789中转视频',
    schemaVersion: 1,
    taskTypes: ['video'],
    helpText: '6789中转视频接口：按模型选择 Kling O3 或 MiniMax H3 的请求格式。',
    apikeyLocation: 'header',
    apikeyField: 'Authorization: Bearer {apikey}',
    parameters: {
        prompt: { id: 'prompt', label: '提示词', exposed: true, inputPort: true, portType: 'text', required: true, dataType: 'string', uiControl: 'textarea', requestField: 'prompt', taskTypes: ['video'] },
        seconds: { id: 'seconds', label: '时长（秒）', exposed: true, inputPort: false, dataType: 'number', uiControl: 'number', requestField: 'seconds', taskTypes: ['video'], min: 4, max: 15, defaultValue: 4 },
        size: { id: 'size', label: '尺寸', exposed: true, inputPort: false, dataType: 'string', uiControl: 'select', requestField: 'size', taskTypes: ['video'], options: [{ value: '1440x1920', label: '1440×1920（3:4）' }], defaultValue: '1440x1920' },
        referenceImages: { id: 'referenceImages', label: '参考图输入', exposed: true, inputPort: true, portType: 'image', portCount: 1, portLabel: '参考图', portOnly: true, taskTypes: ['video'] }
    },
    variants: {
        'kling-o3': {
            requestEncoding: 'json',
            requestEncodingWhenReferenceImages: 'multipart',
            createPath: '/v1/videos',
            queryPath: '/v1/videos/{{taskId}}',
            referenceImage: { field: 'images', mode: 'repeat-field' },
            parameters: {
                seconds: { id: 'seconds', label: '时长（秒）', exposed: true, dataType: 'number', uiControl: 'number', requestField: 'seconds', min: 3, max: 15, defaultValue: 3 },
                size: { id: 'size', label: '尺寸', exposed: true, dataType: 'string', uiControl: 'select', requestField: 'size', options: [{ value: '960x1280', label: '960×1280' }], defaultValue: '960x1280' },
                referenceImages: { id: 'referenceImages', label: '参考图输入', exposed: true, inputPort: true, portType: 'image', portCount: 5, portLabel: '参考图 {index}', portOnly: true }
            },
            asyncTask: { taskIdPath: 'id', statusPath: 'status', completedStatuses: ['completed'], resultPath: 'video_url' }
        },
        'minimax-h3': {
            requestEncoding: 'json',
            createPath: '/v1/videos',
            queryPath: '/v1/videos/{{taskId}}',
            referenceImage: { field: 'input_reference', mode: 'single-string', maxCount: 1 },
            parameters: {
                seconds: { id: 'seconds', label: '时长（秒）', exposed: true, dataType: 'number', uiControl: 'number', requestField: 'seconds', min: 4, max: 15, defaultValue: 4 },
                size: { id: 'size', label: '尺寸', exposed: true, dataType: 'string', uiControl: 'select', requestField: 'size', options: [{ value: '1440x1920', label: '1440×1920（3:4）' }], defaultValue: '1440x1920' }
            },
            asyncTask: { taskIdPath: 'id', statusPath: 'status', completedStatuses: ['completed'], resultPath: 'metadata.url' }
        }
    }
};

registerProtocol(RelayVideoProtocol);
