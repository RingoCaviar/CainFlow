/**
 * 维护模型兼容格式的统一注册表，作为设置页、节点 UI 与执行层的单一来源。
 */
export const MODEL_PROTOCOLS = Object.freeze({
    google: Object.freeze({
        id: 'google',
        label: 'Google / Gemini',
        defaultTaskTypes: ['chat', 'image'],
        helpText: 'Google / Gemini 格式会走 generateContent，请求体按 Gemini 协议构造。'
    }),
    openai: Object.freeze({
        id: 'openai',
        label: 'OpenAI 兼容',
        defaultTaskTypes: ['chat', 'image'],
        helpText: 'OpenAI 兼容格式会按模型用途，分别走 /chat/completions 或 /images/generations；生图节点有参考图输入时自动改走 /images/edits。'
    }),
    'newapi-image-async': Object.freeze({
        id: 'newapi-image-async',
        label: 'NEW API 原生异步模式',
        defaultTaskTypes: ['image'],
        helpText: 'NEW API 原生异步图片模式会提交到 /v1/videos，并通过 /v1/videos/{id} 轮询任务；最终图片会从 image_url、url 或兼容字段 video_url 中读取。'
    }),
    'veo-unified': Object.freeze({
        id: 'veo-unified',
        label: 'VEO 视频 · 统一格式',
        defaultTaskTypes: ['video'],
        helpText: '统一格式会创建到 /v1/video/create，并通过 /v1/video/query 轮询结果。',
        videoMeta: Object.freeze({
            statusText: '统一格式',
            supportsEnhancePrompt: true,
            supportsUpsample: true,
            note: '统一格式会走 /v1/video/create 与 /v1/video/query，支持 enhance_prompt、enable_upsample 等参数。'
        })
    }),
    'veo-openai': Object.freeze({
        id: 'veo-openai',
        label: 'VEO 视频 · OpenAI 视频格式',
        defaultTaskTypes: ['video'],
        helpText: 'OpenAI 视频格式会创建到 /v1/videos，并通过 /v1/videos/{id} 轮询，最终从 /v1/videos/{id}/content 下载视频。',
        videoMeta: Object.freeze({
            statusText: 'OpenAI 视频格式',
            supportsEnhancePrompt: false,
            supportsUpsample: false,
            note: 'OpenAI 视频格式会走 /v1/videos、/v1/videos/{id} 与 /content，参数按 OpenAI 视频兼容格式发送。'
        })
    }),
    'doubao-video': Object.freeze({
        id: 'doubao-video',
        label: '豆包视频生成',
        defaultTaskTypes: ['video'],
        helpText: '豆包视频生成会创建到 /volc/v1/contents/generations/tasks，并通过 /volc/v1/contents/generations/tasks/{id} 轮询任务状态。参数按文档作为顶层字段发送，图片通过 content 中的 role 区分首帧、尾帧与参考图。',
        videoMeta: Object.freeze({
            statusText: '豆包视频生成',
            supportsEnhancePrompt: false,
            supportsUpsample: false,
            note: '豆包视频生成会走 /volc/v1/contents/generations/tasks 创建任务，再通过 /volc/v1/contents/generations/tasks/{id} 查询状态；分辨率、宽高比、时长等参数按文档作为顶层字段发送。'
        })
    })
});

export const MODEL_PROTOCOL_IDS = Object.freeze(Object.keys(MODEL_PROTOCOLS));

export function isKnownModelProtocol(protocol = '') {
    return Object.prototype.hasOwnProperty.call(MODEL_PROTOCOLS, protocol);
}

export function getModelProtocolConfig(protocol = '') {
    return MODEL_PROTOCOLS[protocol] || null;
}

export function getModelProtocolHelpText(protocol = '', fallback = '') {
    return getModelProtocolConfig(protocol)?.helpText || fallback;
}

export function getVideoProtocolOptionMeta(protocol = '') {
    return getModelProtocolConfig(protocol)?.videoMeta || {
        statusText: 'OpenAI 视频格式',
        supportsEnhancePrompt: false,
        supportsUpsample: false,
        note: 'OpenAI 视频格式会走 /v1/videos、/v1/videos/{id} 与 /content，参数按 OpenAI 视频兼容格式发送。'
    };
}

export function getProtocolSelectOptions(taskType = '') {
    return MODEL_PROTOCOL_IDS
        .map((id) => MODEL_PROTOCOLS[id])
        .filter((config) => !taskType || config.defaultTaskTypes.includes(taskType))
        .map((config) => ({
            value: config.id,
            label: config.label
        }));
}
