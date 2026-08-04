let runtimeInfo = null;
let taskbarFocusHandlersInstalled = false;

function getApi() {
    return globalThis.pywebview?.api || null;
}

function bytesToBase64(bytes) {
    const chunkSize = 0x8000;
    let binary = '';
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
}

async function waitForDesktopApi(timeoutMs = 2500) {
    if (getApi()) return getApi();
    const desktopExpected = new URLSearchParams(globalThis.location?.search || '').get('desktop') === '1';
    if (!globalThis.pywebview && !desktopExpected) return null;
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve(getApi());
        };
        globalThis.addEventListener?.('pywebviewready', finish, { once: true });
        globalThis.setTimeout(finish, timeoutMs);
    });
}

export async function initializeDesktopBridge() {
    const api = await waitForDesktopApi();
    if (!api) return null;
    runtimeInfo = await api.get_runtime_info();
    globalThis.__cainflowDesktop = {
        info: runtimeInfo,
        chooseDirectory: () => api.choose_directory(),
        openDirectory: (path) => api.open_directory(path),
        openExternal: (url) => api.open_external(url),
        setTaskbarStatus: async (status) => {
            const documentRef = globalThis.document;
            if (!documentRef?.hidden && documentRef?.hasFocus?.()) return false;
            try {
                const applied = await api.set_taskbar_status(status);
                if (!documentRef?.hidden && documentRef?.hasFocus?.()) {
                    await api.clear_taskbar_status();
                    return false;
                }
                return applied;
            } catch (error) {
                console.warn('Taskbar status update failed:', error);
                return false;
            }
        },
        clearTaskbarStatus: async () => {
            try {
                return await api.clear_taskbar_status();
            } catch (error) {
                console.warn('Taskbar status clear failed:', error);
                return false;
            }
        },
        saveFile: async (name, mime, source) => {
            let blob = source;
            if (!(blob instanceof Blob)) {
                const response = await fetch(String(source));
                if (!response.ok) throw new Error(`读取保存内容失败: HTTP ${response.status}`);
                blob = await response.blob();
            }
            const bytes = new Uint8Array(await blob.arrayBuffer());
            return api.save_file(name, mime || blob.type || '', {
                encoding: 'base64',
                data: bytesToBase64(bytes)
            });
        }
    };
    installTaskbarFocusHandlers();
    installDesktopNavigationHandlers();
    return runtimeInfo;
}

function installTaskbarFocusHandlers() {
    if (taskbarFocusHandlersInstalled) return;
    taskbarFocusHandlersInstalled = true;
    const clear = () => {
        if (!globalThis.document?.hidden) {
            void globalThis.__cainflowDesktop?.clearTaskbarStatus();
        }
    };
    globalThis.addEventListener?.('focus', clear);
    globalThis.document?.addEventListener?.('visibilitychange', clear);
}

function installDesktopNavigationHandlers() {
    globalThis.document?.addEventListener('click', async (event) => {
        const anchor = event.target?.closest?.('a');
        if (!anchor) return;
        if (anchor.hasAttribute('download')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            const name = anchor.download || 'CainFlow-export';
            try {
                await globalThis.__cainflowDesktop.saveFile(name, '', anchor.href);
            } catch (error) {
                console.error('Desktop save failed:', error);
            }
            return;
        }
        if (anchor.target === '_blank') {
            event.preventDefault();
            event.stopImmediatePropagation();
            await globalThis.__cainflowDesktop.openExternal(anchor.href);
        }
    }, true);

    const nativeOpen = globalThis.open?.bind(globalThis);
    globalThis.open = (url, target, features) => {
        if (target === '_blank' && /^https?:/i.test(String(url || ''))) {
            void globalThis.__cainflowDesktop.openExternal(String(url));
            return null;
        }
        return nativeOpen?.(url, target, features) || null;
    };
}

export function isDesktopRuntime() {
    return runtimeInfo?.desktop === true;
}
