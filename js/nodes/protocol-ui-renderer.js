/**
 * 协议参数UI渲染器
 * 根据协议的参数定义动态生成UI控件
 */

/**
 * 转义HTML特殊字符
 */
function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 渲染节点表单字段容器
 */
function renderNodeFormField({ label, content, fieldClass = '', fieldId = '', note = '' }) {
    const classes = ['node-field', 'node-form-field'];
    if (fieldClass) classes.push(fieldClass);
    const fieldIdAttr = fieldId ? ` id="${fieldId}"` : '';
    const noteHtml = note ? `<div class="node-field-note">${note}</div>` : '';
    return `
        <div class="${classes.join(' ')}"${fieldIdAttr}>
            ${label ? `<label>${escapeHtml(label)}</label>` : ''}
            ${content}
            ${noteHtml}
        </div>
    `;
}

function isPortOnlyParameter(param = {}) {
    return param.portOnly === true || param.id === 'referenceImages';
}

/**
 * 渲染下拉选择控件
 */
function renderSelectControl(nodeId, param, value, customValues = {}) {
    const options = param.options || [];
    const selectedValue = value !== undefined ? value : param.defaultValue;

    const optionsHtml = options.map(option => {
        const selected = selectedValue === option.value ? 'selected' : '';
        return `<option value="${escapeHtml(option.value)}" ${selected}>${escapeHtml(option.label)}</option>`;
    }).join('');

    // 检查是否有 custom 选项
    const hasCustomOption = options.some(opt => opt.value === 'custom');
    const isCustomSelected = selectedValue === 'custom';

    let html = `<select id="${nodeId}-param-${param.id}" data-param-id="${param.id}">${optionsHtml}</select>`;

    // 如果有 custom 选项，添加自定义输入框
    if (hasCustomOption) {
        // 获取自定义值
        const customValue = customValues[param.id] || '';

        // 根据是否选中 custom 决定显示状态
        const displayStyle = isCustomSelected ? 'display: block;' : 'display: none;';
        html += `<input type="text"
                       id="${nodeId}-param-${param.id}-custom"
                       class="custom-value-input"
                       value="${escapeHtml(customValue)}"
                       placeholder="请输入自定义值，如: 1920x1080"
                       style="${displayStyle}"
                       data-param-id="${param.id}" />`;
    }

    return html;
}

/**
 * 渲染文本输入控件
 */
function renderTextControl(nodeId, param, value) {
    const currentValue = value !== undefined ? value : param.defaultValue || '';
    const placeholder = param.placeholder || '';
    return `<input type="text" id="${nodeId}-param-${param.id}" value="${escapeHtml(currentValue)}" placeholder="${escapeHtml(placeholder)}" />`;
}

/**
 * 渲染数字输入控件
 */
function renderNumberControl(nodeId, param, value) {
    const currentValue = value !== undefined ? value : (param.defaultValue ?? param.portCount ?? '');
    const min = param.min !== undefined ? param.min : '';
    const max = param.max !== undefined ? param.max : '';
    const step = param.step !== undefined ? param.step : 1;

    const minAttr = min !== '' ? ` min="${min}"` : '';
    const maxAttr = max !== '' ? ` max="${max}"` : '';
    const stepAttr = ` step="${step}"`;

    // 带加减号控件的数字输入
    return `
        <div class="number-stepper">
            <button type="button" class="number-step number-step-minus" data-target="${nodeId}-param-${param.id}" data-step="-${step}" ${min !== '' && parseFloat(currentValue) <= parseFloat(min) ? 'disabled' : ''}>−</button>
            <input type="number" id="${nodeId}-param-${param.id}" value="${escapeHtml(String(currentValue))}"${minAttr}${maxAttr}${stepAttr} data-min="${min}" data-max="${max}" data-step="${step}" />
            <button type="button" class="number-step number-step-plus" data-target="${nodeId}-param-${param.id}" data-step="${step}" ${max !== '' && parseFloat(currentValue) >= parseFloat(max) ? 'disabled' : ''}>+</button>
        </div>
    `;
}

/**
 * 渲染开关控件
 */
function renderToggleControl(nodeId, param, value) {
    const currentValue = value !== undefined ? value : param.defaultValue;
    const checked = currentValue === true ? 'checked' : '';
    return `
        <label class="toggle-switch protocol-param-toggle" title="${escapeHtml(param.label || '')}">
            <input type="checkbox" id="${nodeId}-param-${param.id}" ${checked} />
            <span class="toggle-slider"></span>
        </label>
    `;
}

/**
 * 渲染多行文本控件
 */
function renderTextareaControl(nodeId, param, value) {
    const currentValue = value !== undefined ? value : param.defaultValue || '';
    const placeholder = param.placeholder || '';
    const rows = param.rows || 3;
    return `<textarea id="${nodeId}-param-${param.id}" rows="${rows}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(currentValue)}</textarea>`;
}

/**
 * 根据参数定义渲染控件
 */
export function renderProtocolParameter(nodeId, param, value, customValues = {}) {
    if (!param || !param.uiControl) return '';

    switch (param.uiControl) {
        case 'select':
            return renderSelectControl(nodeId, param, value, customValues);
        case 'text':
            return renderTextControl(nodeId, param, value);
        case 'number':
            return renderNumberControl(nodeId, param, value);
        case 'toggle':
            return renderToggleControl(nodeId, param, value);
        case 'textarea':
            return renderTextareaControl(nodeId, param, value);
        default:
            console.warn(`未知的UI控件类型: ${param.uiControl}`);
            return '';
    }
}

/**
 * 渲染协议的所有参数
 */
export function renderProtocolParameters(nodeId, protocol, taskType, restoreData = {}) {
    if (!protocol || !protocol.parameters) return '';

    const parameters = protocol.parameters;
    const fieldsHtml = [];

    // 从 restoreData.protocolParams 读取保存的参数值
    const savedParams = restoreData.protocolParams || {};
    // 从 restoreData.customValues 读取自定义值
    const customValues = restoreData.customValues || {};

    Object.entries(parameters).forEach(([paramId, param]) => {
        // 检查参数是否应该在此任务类型下显示
        if (param.taskTypes && !param.taskTypes.includes(taskType)) {
            return;
        }

        // 检查参数是否暴露
        if (param.exposed !== true) {
            return;
        }
        // 获取保存的值 - 优先从 protocolParams 读取
        const savedValue = savedParams[paramId];

        // 渲染控件
        const controlHtml = renderProtocolParameter(nodeId, param, savedValue, customValues);

        if (controlHtml) {
            const isToggle = param.uiControl === 'toggle';
            // 包装成表单字段
            const fieldHtml = renderNodeFormField({
                label: isToggle ? '' : (param.label || paramId),
                content: isToggle
                    ? `<label class="node-field-inline-label" for="${nodeId}-param-${param.id}">${escapeHtml(param.label || paramId)}</label>${controlHtml}`
                    : controlHtml,
                fieldId: param.fieldId || `${nodeId}-${paramId}-field`,
                fieldClass: isToggle
                    ? `node-field-row node-field-row-compact ${param.fieldClass || ''}`.trim()
                    : (param.fieldClass || ''),
                note: param.note || ''
            });

            fieldsHtml.push(fieldHtml);
        }
    });

    return fieldsHtml.join('');
}

/**
 * 获取协议参数的值映射
 * 从DOM元素读取当前值
 */
export function getProtocolParameterValues(nodeId, protocol, taskType, documentRef = document) {
    if (!protocol || !protocol.parameters) return {};

    const values = {};
    const parameters = protocol.parameters;

    Object.entries(parameters).forEach(([paramId, param]) => {
        // 检查参数是否应该在此任务类型下显示
        if (param.taskTypes && !param.taskTypes.includes(taskType)) {
            return;
        }

        // 检查参数是否暴露
        if (param.exposed !== true) {
            return;
        }
        if (isPortOnlyParameter(param)) return;

        const element = documentRef.getElementById(`${nodeId}-param-${paramId}`);
        if (!element) return;

        // 根据控件类型读取值
        if (param.uiControl === 'toggle') {
            values[paramId] = element.checked;
        } else if (param.uiControl === 'number') {
            const num = parseFloat(element.value);
            values[paramId] = isNaN(num) ? param.defaultValue : num;
        } else if (param.uiControl === 'select') {
            const selectedValue = element.value;
            // 如果选择了 custom，读取自定义输入框的值
            if (selectedValue === 'custom') {
                const customInput = documentRef.getElementById(`${nodeId}-param-${paramId}-custom`);
                values[paramId] = customInput ? customInput.value : '';
            } else {
                values[paramId] = selectedValue;
            }
        } else {
            values[paramId] = element.value;
        }
    });

    return values;
}
