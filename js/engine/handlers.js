import { state } from '../modules/state.js';
import { NODE_CONFIGS } from '../modules/constants.js';
import { showToast } from '../modules/utils.js';
import { saveHistoryEntry, saveImageAsset } from '../modules/db.js';

// These will be exported from index.js for now to avoid massive refactoring of UI logic
import { 
    showResolutionBadge, 
    fitNodeToContent, 
    getProxyHeaders, 
    updateAllConnections, 
    renderHistoryList 
} from '../modules/ui_bridge.js';

/**
 * Handles automatic saving of images to a local directory handle.
 * Part of the ImageSave node logic.
 */
export async function autoSaveToDir(nodeId, dataUrl) {
    if (!state.globalSaveDirHandle) return;
    
    try {
        const node = state.nodes.get(nodeId);
        const filenameInput = document.getElementById(`${nodeId}-filename`);
        let baseName = filenameInput ? filenameInput.value.trim() : 'generated_image';
        if (!baseName) baseName = 'generated_image';
        
        // Sanitize filename
        baseName = baseName.replace(/[\\/:*?"<>|]/g, '_');
        
        // Add timestamp to ensure uniqueness if not provided
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `${baseName}_${timestamp}.png`;
        
        const fileHandle = await state.globalSaveDirHandle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        
        await writable.write(blob);
        await writable.close();
        
        console.log(`Successfully auto-saved to: ${fileName}`);
    } catch (e) {
        console.error('Auto-save failed:', e);
        showToast('自动保存失败，请检查目录权限', 'error');
    }
}

export const NodeHandlers = {
    'ImageImport': async (node, inputs, signal) => {
        if (!node.imageData) throw new Error('未导入图片');
        node.data.image = node.imageData;
    },
    'ImageGenerate': async (node, inputs, signal) => {
        const { id } = node;
        const errorEl = document.getElementById(`${id}-error`);
        if (errorEl) errorEl.style.display = 'none';

        try {
            const configId = document.getElementById(`${id}-apiconfig`).value;
            const modelCfg = state.models.find(m => m.id === configId);
            if (!modelCfg) throw new Error('未找到选定的模型配置');
            const apiCfg = state.providers.find(p => p.id === modelCfg.providerId);
            if (!apiCfg) throw new Error('未找到绑定的 API 供应商');

            const aspect = document.getElementById(`${id}-aspect`).value;
            const resolution = document.getElementById(`${id}-resolution`).value;
            const searchEnabled = document.getElementById(`${id}-search`).checked;

            // Priority: Input port > Textarea
            const prompt = inputs.prompt || document.getElementById(`${id}-prompt`).value;

            if (!apiCfg.apikey) throw new Error('API 供应商密钥未配置');
            if (!prompt) throw new Error('请输入提示词');

            const parts = [{ text: prompt }];
            for (const key of ['image_1', 'image_2', 'image_3', 'image_4', 'image_5']) {
                if (inputs[key]) {
                    const match = inputs[key].match(/^data:(.+?);base64,(.+)$/);
                    if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
                }
            }

            const requestBody = { contents: [{ parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } };
            const imageConfig = {};
            if (aspect) imageConfig.aspectRatio = aspect;
            if (resolution) imageConfig.imageSize = resolution;
            if (Object.keys(imageConfig).length > 0) requestBody.generationConfig.imageConfig = imageConfig;
            if (searchEnabled) requestBody.tools = [{ googleSearch: {} }];

            const url = apiCfg.autoComplete !== false
                ? `${apiCfg.endpoint.replace(/\/+$/, '')}/v1beta/models/${modelCfg.modelId}:generateContent?key=${apiCfg.apikey}`
                : apiCfg.endpoint;
            showToast(`正在调用 ${modelCfg.name}...`, 'info', 5000);

            const headers = getProxyHeaders(url, 'POST');

            const response = await fetch('/proxy', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(requestBody),
                signal: signal
            });

            if (!response.ok) {
                const t = await response.text();
                let msg = `API 错误 (${response.status})`;
                try {
                    const json = JSON.parse(t);
                    if (json.error?.message) msg += `: ${json.error.message}`;
                    else msg += `: ${t.substring(0, 100)}`;
                } catch (e) {
                    msg += `: ${t.substring(0, 100)}`;
                }
                const err = new Error(msg);
                err.serverResponse = t;
                throw err;
            }

            const result = await response.json();
            if (!result) throw new Error('API 返回了空的 JSON 响应');
            
            let imageData = null;
            if (result.candidates && Array.isArray(result.candidates) && result.candidates[0]) {
                const candidate = result.candidates[0];
                if (candidate.content?.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.inlineData) {
                            imageData = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                            break;
                        }
                    }
                }
                
                // Detailed error parsing for Imagen/Gemini when image is missing
                if (!imageData) {
                    let reason = 'API 未返回图片数据';
                    if (result.error?.message) {
                        reason = `API 错误: ${result.error.message}`;
                    } else if (candidate.finishReason) {
                        const fr = candidate.finishReason;
                        if (fr === 'SAFETY') reason = '⚠️ 内容被安全过滤器拦截 (如有违规提示词或敏感动作)';
                        else if (fr === 'RECITATION') reason = '⚠️ 生成内容由于版权保护被拦截';
                        else reason = `生成停止原因: ${fr}`;
                    } else if (result.promptFeedback?.blockReason || result.promptFeedback?.gemini_block_reason) {
                        const br = result.promptFeedback.blockReason || result.promptFeedback.gemini_block_reason;
                        reason = `🚫 请求被屏蔽: ${br}`;
                        if (br === 'SAFETY') reason = '⚠️ 请求因违反安全政策被系统拦截 (SAFETY)';
                    } else if (result.gemini_block_reason) {
                        reason = `🚫 系统屏蔽: ${result.gemini_block_reason}`;
                    }
                    const err = new Error(reason);
                    err.serverResponse = JSON.stringify(result, null, 2);
                    throw err;
                }
            } else if (result.error?.message) {
                const err = new Error(`API 错误: ${result.error.message}`);
                err.serverResponse = JSON.stringify(result, null, 2);
                throw err;
            } else {
                const err = new Error('API 返回了空结果 (无候选内容)');
                err.serverResponse = JSON.stringify(result, null, 2);
                throw err;
            }

            node.data.image = imageData;
            showResolutionBadge(id, imageData);

            // Auto record to history
            await saveHistoryEntry({
                nodeId: id,
                image: imageData,
                prompt: prompt,
                model: modelCfg.name
            });
            if (document.getElementById('history-sidebar').classList.contains('active')) renderHistoryList();
        } catch (err) {
            if (errorEl) {
                errorEl.innerHTML = `<strong>生成失败</strong>${err.message}`;
                errorEl.style.display = 'block';
                // Automatically expand node to ensure the error message is visible and doesn't overlap
                fitNodeToContent(id);
            }
            throw err;
        }
    },
    'TextChat': async (node, inputs, signal) => {
        const { id } = node;
        const configId = document.getElementById(`${id}-apiconfig`).value;
        const modelCfg = state.models.find(m => m.id === configId);
        if (!modelCfg) throw new Error('未找到选定的模型配置');
        const apiCfg = state.providers.find(p => p.id === modelCfg.providerId);
        if (!apiCfg) throw new Error('未找到绑定的 API 供应商');

        const sysprompt = document.getElementById(`${id}-sysprompt`).value;
        const prompt = inputs.prompt || document.getElementById(`${id}-prompt`).value;
        
        const fixedToggle = document.getElementById(`${id}-fixed`);
        const isFixed = fixedToggle ? fixedToggle.checked : false;
        
        if (isFixed && node.isSucceeded && node.data && node.data.text) {
            return;
        }

        const responseArea = document.getElementById(`${id}-response`);

        if (!apiCfg.apikey) throw new Error('API 供应商密钥未配置');
        if (!prompt) throw new Error('请输入提问内容');

        showToast(`正在调用 ${modelCfg.name}...`, 'info', 5000);
        responseArea.innerHTML = '<div class="chat-response-placeholder">正在生成回复...</div>';

        try {
            let jsonResponse = null;
            let responseText = '';

            if (apiCfg.type === 'google') {
                const searchEnabled = document.getElementById(`${id}-search`)?.checked || false;
                const parts = [{ text: prompt }];
                for (const key of ['image_1', 'image_2', 'image_3', 'image_4', 'image_5']) {
                    if (inputs[key]) {
                        const match = inputs[key].match(/^data:(.+?);base64,(.+)$/);
                        if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
                    }
                }
                const body = { contents: [{ parts }] };
                if (sysprompt) body.systemInstruction = { parts: [{ text: sysprompt }] };
                if (searchEnabled) body.tools = [{ googleSearch: {} }];

                const url = apiCfg.autoComplete !== false
                    ? `${apiCfg.endpoint.replace(/\/+$/, '')}/v1beta/models/${modelCfg.modelId}:generateContent?key=${apiCfg.apikey}`
                    : apiCfg.endpoint;
                
                const headers = getProxyHeaders(url, 'POST');

                const res = await fetch('/proxy', {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(body),
                    signal
                });
                if (!res.ok) {
                    const t = await res.text();
                    const err = new Error(`HTTP ${res.status}: ${t.substring(0, 100)}`);
                    err.serverResponse = t;
                    throw err;
                }
                jsonResponse = await res.json();

                let resultText = jsonResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (jsonResponse.candidates?.[0]?.groundingMetadata) {
                    const metadata = jsonResponse.candidates[0].groundingMetadata;
                    if (metadata.searchEntryPoint?.html) {
                        resultText += `\n\n<div class="search-chips">${metadata.searchEntryPoint.html}</div>`;
                    }
                }
                responseText = resultText;
            } else {
                // OpenAI compatible handle
                const messages = [];
                if (sysprompt) messages.push({ role: 'system', content: sysprompt });
                const content = [{ type: 'text', text: prompt }];
                for (const key of ['image_1', 'image_2', 'image_3', 'image_4', 'image_5']) {
                    if (inputs[key]) content.push({ type: 'image_url', image_url: { url: inputs[key] } });
                }
                messages.push({ role: 'user', content });

                let url = apiCfg.endpoint.replace(/\/+$/, '');
                if (apiCfg.autoComplete !== false && !url.endsWith('/chat/completions')) url += '/chat/completions';
                
                const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiCfg.apikey}`, 'x-target-url': url };
                if (state.proxy && state.proxy.enabled) {
                    headers['x-proxy-enabled'] = 'true';
                    headers['x-proxy-host'] = state.proxy.ip;
                    headers['x-proxy-port'] = state.proxy.port;
                }

                const res = await fetch('/proxy', {
                    method: 'POST',
                    headers: { ...headers, 'x-target-method': 'POST' },
                    body: JSON.stringify({ model: modelCfg.modelId, messages }),
                    signal
                });
                if (!res.ok) {
                    const t = await res.text();
                    const err = new Error(`HTTP ${res.status}: ${t.substring(0, 100)}`);
                    err.serverResponse = t;
                    throw err;
                }
                jsonResponse = await res.json();
                responseText = jsonResponse.choices?.[0]?.message?.content || '';
            }

            if (!responseText) {
                const err = new Error('API 未返回文本内容');
                if (jsonResponse) err.serverResponse = JSON.stringify(jsonResponse, null, 2);
                throw err;
            }
            if (window.marked && window.marked.parse) {
                responseArea.innerHTML = window.marked.parse(responseText);
            } else {
                responseArea.innerText = responseText;
            }
            node.data.text = responseText;
            node.lastResponse = responseArea.innerHTML;
            node.isSucceeded = true;
            
            // Automatically expand node to fit the AI response
            fitNodeToContent(id);
            
            updateAllConnections();
        } catch (err) {
            responseArea.innerHTML = `<div class="chat-response-placeholder" style="color:var(--accent-red)">失败: ${err.message}</div>`;
            throw err;
        }
    },
    'ImagePreview': async (node, inputs, signal) => {
        const { id } = node;
        const imgData = inputs.image;
        const previewContainer = document.getElementById(`${id}-preview`);
        const controls = document.getElementById(`${id}-controls`);
        if (imgData) {
            node.previewZoom = 1;
            previewContainer.innerHTML = `<img src="${imgData}" alt="预览" style="cursor:pointer" draggable="false" />`;
            controls.style.display = 'flex';
            node.data.image = imgData;
            saveImageAsset(id, imgData);
            showResolutionBadge(id, imgData);
        } else {
            previewContainer.innerHTML = `<div class="preview-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>无输入图片</div>`;
            controls.style.display = 'none';
        }
    },
    'ImageSave': async (node, inputs, signal) => {
        const { id } = node;
        const imgData = inputs.image;
        const savePreview = document.getElementById(`${id}-save-preview`);
        if (imgData) {
            node.data.image = imgData;
            savePreview.innerHTML = `<img src="${imgData}" alt="待保存" draggable="false" />`;
            saveImageAsset(id, imgData);
            showResolutionBadge(id, imgData);
            await autoSaveToDir(id, imgData);
        } else {
            savePreview.innerHTML = '<div class="save-preview-placeholder">无输入图片</div>';
        }
    },
    'TextInput': async (node, inputs, signal) => {
        node.data.text = document.getElementById(`${node.id}-text`).value;
    },
    'TextDisplay': async (node, inputs, signal) => {
        const text = inputs.text || '';
        const display = document.getElementById(`${node.id}-display`);
        if (display) {
            display.textContent = text || '目前无输入文本';
            node.data.text = text;
            updateAllConnections();
        }
    }
};
