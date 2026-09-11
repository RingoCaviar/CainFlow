/** 6789 Seedance 视频协议：按精确模型 ID 声明请求与输入约束。 */
import { registerProtocol } from './index.js';

const ratios = ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'].map((value) => ({ value, label: value }));

function createVariant(durationOptions, maxImages) {
    return {
        requestEncoding: 'json',
        createPath: '/v1/videos',
        queryPath: '/v1/videos/{{taskId}}',
        referenceImage: { field: 'image_urls', mode: 'json-array', maxCount: maxImages, urlPattern: '^https://' },
        parameters: {
            duration: { id: 'duration', label: '时长（秒）', exposed: true, dataType: 'number', uiControl: 'select', requestField: 'duration', options: durationOptions.map((value) => ({ value, label: `${value}秒` })), defaultValue: durationOptions[0] },
            referenceImages: { id: 'referenceImages', label: '参考图输入', exposed: true, inputPort: true, portType: 'image', portCount: maxImages, portLabel: '参考图 {index}', portOnly: true }
        },
        asyncTask: { taskIdPath: 'id', statusPath: 'status', completedStatuses: ['succeeded'], failedStatuses: ['failed'], resultPath: 'file', fallbackResultPaths: ['download_url'] }
    };
}

export const Api6789SeedanceProtocol = {
    id: 'api6789-seedance',
    label: '6789 Seedance',
    schemaVersion: 1,
    taskTypes: ['video'],
    variantIdCaseInsensitive: true,
    helpText: '6789 Seedance 接口支持文生视频和公网 HTTPS 参考图视频。',
    authentication: { location: 'header', field: 'Authorization', template: 'Bearer {apikey}' },
    parameters: {
        prompt: { id: 'prompt', label: '提示词', exposed: true, inputPort: true, portType: 'text', required: true, dataType: 'string', uiControl: 'textarea', requestField: 'prompt', taskTypes: ['video'], minLength: 1, maxLength: 6000 },
        ratio: { id: 'ratio', label: '画面比例', exposed: true, inputPort: false, dataType: 'string', uiControl: 'select', requestField: 'ratio', options: ratios, defaultValue: '16:9', taskTypes: ['video'] },
        resolution: { id: 'resolution', label: '分辨率', exposed: true, inputPort: false, dataType: 'string', uiControl: 'select', requestField: 'resolution', options: [{ value: '720p', label: '720p' }], defaultValue: '720p', taskTypes: ['video'] }
    },
    variants: {
        'seedance2.0': createVariant([5, 10, 15], 9),
        'seedance2.0fast': createVariant([5, 10, 15], 9),
        'seedance2.0mini': createVariant([5, 10], 9),
        'seedance2.5': createVariant([30], 30)
    }
};

registerProtocol(Api6789SeedanceProtocol);
