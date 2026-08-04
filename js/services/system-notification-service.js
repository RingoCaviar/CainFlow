export function createSystemNotificationService({
    notificationRef = typeof Notification !== 'undefined' ? Notification : null,
    navigatorRef = typeof navigator !== 'undefined' ? navigator : null,
    fetchRef = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null,
    platformRef = typeof navigator !== 'undefined' ? (navigator.userAgentData?.platform || navigator.platform || '') : '',
    desktopRef = typeof globalThis !== 'undefined' ? globalThis.__cainflowDesktop : null,
    consoleRef = console,
    serviceWorkerUrl = './js/services/notification-sw.js',
    nativeNotificationUrl = '/api/system-notification'
} = {}) {
    let registrationPromise = null;

    function isWindows() {
        return /win/i.test(String(platformRef || ''));
    }

    function usesNativeEndpoint() {
        return isWindows() || desktopRef?.info?.platform === 'darwin';
    }

    function isSupported() {
        return usesNativeEndpoint() ? !!fetchRef : !!notificationRef;
    }

    function getPermission() {
        if (usesNativeEndpoint()) return fetchRef ? 'granted' : 'unsupported';
        return notificationRef?.permission || 'unsupported';
    }

    async function requestPermission() {
        if (usesNativeEndpoint()) return fetchRef ? 'granted' : 'unsupported';
        if (!notificationRef) return 'unsupported';
        if (notificationRef.permission === 'granted') return 'granted';

        return notificationRef.requestPermission();
    }

    function getServiceWorkerContainer() {
        return navigatorRef?.serviceWorker || null;
    }

    async function getRegistration() {
        const serviceWorker = getServiceWorkerContainer();
        if (!serviceWorker) return null;

        if (!registrationPromise) {
            registrationPromise = serviceWorker.register(serviceWorkerUrl)
                .catch((err) => {
                    registrationPromise = null;
                    throw err;
                });
        }

        const registration = await registrationPromise;
        await serviceWorker.ready;
        return registration;
    }

    async function ensureReady() {
        if (!isSupported()) return false;
        if (usesNativeEndpoint()) return true;
        try {
            await getRegistration();
        } catch (err) {
            consoleRef.warn('Notification service worker registration failed:', err);
        }
        return true;
    }

    async function showBrowserNotification(title, options = {}) {
        if (!notificationRef || notificationRef.permission !== 'granted') return false;
        const normalizedOptions = {
            ...options,
            tag: options.tag || 'cainflow-workflow-run',
            renotify: options.renotify ?? true,
            requireInteraction: options.requireInteraction ?? false
        };

        try {
            const registration = await getRegistration();
            if (registration?.showNotification) {
                await registration.showNotification(title, normalizedOptions);
                return true;
            }
        } catch (err) {
            consoleRef.warn('Service worker notification failed:', err);
        }

        try {
            new notificationRef(title, normalizedOptions);
            return true;
        } catch (err) {
            consoleRef.warn('System notification failed:', err);
            return false;
        }
    }

    async function showNotification(title, options = {}) {
        if (!isSupported()) return false;
        if (getPermission() !== 'granted') return false;

        if (usesNativeEndpoint()) {
            try {
                const response = await fetchRef(nativeNotificationUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title,
                        body: options.body || '',
                        tag: options.tag || 'cainflow-workflow-run'
                    })
                });
                const result = await response.json().catch(() => null);
                if (response.ok && result?.success) return true;
                if (response.ok && result?.channel === 'unsupported') {
                    return showBrowserNotification(title, options);
                }
                consoleRef.warn('Native notification failed:', result?.error || response.statusText);
                return false;
            } catch (err) {
                consoleRef.warn('Native notification request failed:', err);
                return false;
            }
        }

        return showBrowserNotification(title, options);
    }

    return {
        isSupported,
        getPermission,
        requestPermission,
        ensureReady,
        showNotification
    };
}
