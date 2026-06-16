/**
 * 协议参数事件绑定器
 * 根据协议的参数定义动态绑定事件
 */

/**
 * 防抖函数
 */
function debounce(func, wait = 300) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function isPortOnlyParameter(param = {}) {
    return param.portOnly === true || param.id === 'referenceImages';
}

/**
 * 绑定单个参数的事件
 */
export function bindProtocolParameter(nodeId, paramId, param, element, state, scheduleSave, onPortRefresh, documentRef = document) {
    if (!element || !param) return;

    const node = state.nodes.get(nodeId);
    if (!node) return;

    // 根据控件类型绑定事件
    switch (param.uiControl) {
        case 'select':
            element.addEventListener('change', () => {
                const selectedValue = element.value;

                // 检查是否选择了 custom
                if (selectedValue === 'custom') {
                    // 显示自定义输入框
                    const customInput = documentRef.getElementById(`${nodeId}-param-${paramId}-custom`);
                    if (customInput) {
                        customInput.style.display = 'block';
                        customInput.focus();
                    }
                } else {
                    // 隐藏自定义输入框
                    const customInput = documentRef.getElementById(`${nodeId}-param-${paramId}-custom`);
                    if (customInput) {
                        customInput.style.display = 'none';
                    }
                }

                // 保存到 protocolParams
                if (!node.data.protocolParams) {
                    node.data.protocolParams = {};
                }
                node.data.protocolParams[paramId] = selectedValue;
                scheduleSave();
            });

            // 绑定自定义输入框的事件
            const customInput = documentRef.getElementById(`${nodeId}-param-${paramId}-custom`);
            if (customInput) {
                const debouncedCustomSave = debounce(() => {
                    // 保存自定义值
                    if (!node.data.customValues) {
                        node.data.customValues = {};
                    }
                    node.data.customValues[paramId] = customInput.value;
                    scheduleSave();
                }, 300);

                customInput.addEventListener('input', debouncedCustomSave);
                customInput.addEventListener('change', () => {
                    if (!node.data.customValues) {
                        node.data.customValues = {};
                    }
                    node.data.customValues[paramId] = customInput.value;
                    scheduleSave();
                });
            }
            break;

        case 'text':
            // 文本输入使用防抖
            const debouncedTextSave = debounce(() => {
                if (!node.data.protocolParams) {
                    node.data.protocolParams = {};
                }
                node.data.protocolParams[paramId] = element.value;
                scheduleSave();
            }, 300);

            element.addEventListener('input', debouncedTextSave);
            element.addEventListener('change', () => {
                if (!node.data.protocolParams) {
                    node.data.protocolParams = {};
                }
                node.data.protocolParams[paramId] = element.value;
                scheduleSave();
            });
            break;

        case 'number':
            const saveNumberValue = () => {
                const num = parseFloat(element.value);
                const value = isNaN(num) ? param.defaultValue : num;

                if (!node.data.protocolParams) {
                    node.data.protocolParams = {};
                }
                node.data.protocolParams[paramId] = value;

                // portOnly/portCount 参数会影响动态端口数量。
                if ((isPortOnlyParameter(param) || (param.portCount && typeof param.portCount === 'number')) && typeof onPortRefresh === 'function') {
                    onPortRefresh(nodeId);
                }

                scheduleSave();
            };
            element.addEventListener('input', saveNumberValue);
            element.addEventListener('change', saveNumberValue);
            break;

        case 'toggle':
            element.addEventListener('change', () => {
                if (!node.data.protocolParams) {
                    node.data.protocolParams = {};
                }
                node.data.protocolParams[paramId] = element.checked;
                scheduleSave();
            });
            break;

        case 'textarea':
            // 多行文本使用防抖
            const debouncedTextareaSave = debounce(() => {
                if (!node.data.protocolParams) {
                    node.data.protocolParams = {};
                }
                node.data.protocolParams[paramId] = element.value;
                scheduleSave();
            }, 300);

            element.addEventListener('input', debouncedTextareaSave);
            element.addEventListener('change', () => {
                if (!node.data.protocolParams) {
                    node.data.protocolParams = {};
                }
                node.data.protocolParams[paramId] = element.value;
                scheduleSave();
            });
            break;

        default:
            console.warn(`未知的UI控件类型: ${param.uiControl}`);
            break;
    }
}

/**
 * 绑定协议的所有参数事件
 */
export function bindProtocolParameters(nodeId, protocol, taskType, el, state, scheduleSave, onPortRefresh, documentRef = document) {
    if (!protocol || !protocol.parameters) return;

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

        // 查找对应的DOM元素
        const element = documentRef.getElementById(`${nodeId}-param-${paramId}`);
        if (!element) {
            console.warn(`找不到参数控件元素: ${nodeId}-param-${paramId}`);
            return;
        }

        // 绑定事件
        bindProtocolParameter(nodeId, paramId, param, element, state, scheduleSave, onPortRefresh, documentRef);
    });

    // 绑定数字加减按钮事件
    const numberStepButtons = el.querySelectorAll('.number-step');
    numberStepButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetId = button.getAttribute('data-target');
            const step = parseFloat(button.getAttribute('data-step')) || 1;
            const input = documentRef.getElementById(targetId);

            if (!input) return;

            const currentValue = parseFloat(input.value) || 0;
            const min = input.getAttribute('data-min');
            const max = input.getAttribute('data-max');

            let newValue = currentValue + step;

            // 应用最小值和最大值限制
            if (min !== '' && min !== null) {
                newValue = Math.max(parseFloat(min), newValue);
            }
            if (max !== '' && max !== null) {
                newValue = Math.min(parseFloat(max), newValue);
            }

            input.value = newValue;

            // 触发 input 事件以保存状态
            input.dispatchEvent(new Event('input', { bubbles: true }));

            // 更新按钮状态
            updateNumberStepButtonStates(input, documentRef);
        });
    });

    // 为数字输入框添加 input 事件，更新按钮状态
    const numberInputs = el.querySelectorAll('input[type="number"]');
    numberInputs.forEach(input => {
        input.addEventListener('input', () => {
            updateNumberStepButtonStates(input, documentRef);
        });
        // 初始化按钮状态
        updateNumberStepButtonStates(input, documentRef);
    });
}

/**
 * 更新数字加减按钮的启用/禁用状态
 */
function updateNumberStepButtonStates(input, documentRef = document) {
    const inputId = input.id;
    const currentValue = parseFloat(input.value);
    const min = input.getAttribute('data-min');
    const max = input.getAttribute('data-max');

    // 查找对应的加减按钮
    const buttons = documentRef.querySelectorAll(`.number-step[data-target="${inputId}"]`);

    buttons.forEach(button => {
        const step = parseFloat(button.getAttribute('data-step')) || 1;
        const isDecrease = step < 0;

        let shouldDisable = false;

        if (isDecrease && min !== '' && min !== null) {
            // 减号按钮：当前值已达到最小值
            shouldDisable = currentValue <= parseFloat(min);
        } else if (!isDecrease && max !== '' && max !== null) {
            // 加号按钮：当前值已达到最大值
            shouldDisable = currentValue >= parseFloat(max);
        }

        button.disabled = shouldDisable;
    });
}

/**
 * 绑定协议切换事件
 * 当用户切换模型时，可能需要重新渲染参数UI
 */
export function bindProtocolSwitchHandler(nodeId, modelSelectElement, onProtocolChange) {
    if (!modelSelectElement) return;

    modelSelectElement.addEventListener('change', () => {
        if (typeof onProtocolChange === 'function') {
            onProtocolChange();
        }
    });
}

/**
 * 序列化协议参数
 * 从节点数据中提取协议参数
 */
export function serializeProtocolParameters(nodeId, protocol, taskType, documentRef = document) {
    if (!protocol || !protocol.parameters) return ;

    const serialized = {};
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
        if (isPortOnlyParameter(param)) {
            return;
        }

        const element = documentRef.getElementById(`${nodeId}-param-${paramId}`);
        if (!element) return;

        // 根据控件类型序列化值
        if (param.uiControl === 'toggle') {
            serialized[paramId] = element.checked;
        } else if (param.uiControl === 'number') {
            const num = parseFloat(element.value);
            serialized[paramId] = isNaN(num) ? param.defaultValue : num;
        } else {
            serialized[paramId] = element.value;
        }
    });

    return serialized;
}
