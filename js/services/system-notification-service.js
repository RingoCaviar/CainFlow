export function createSystemNotificationService({
    notificationRef = typeof Notification !== 'undefined' ? Notification : null,
    navigatorRef = typeof navigator !== 'undefined' ? navigator : null,
    consoleRef = console,
    serviceWorkerUrl = './notification-sw.js'
} = {}) {
    let registrationPromise = null;

    function isSupported() {
        return !!notificationRef;
    }

    function getPermission() {
        return notificationRef?.permission || 'unsupported';
    }

    async function requestPermission() {
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
        try {
            await getRegistration();
        } catch (err) {
            consoleRef.warn('Notification service worker registration failed:', err);
        }
        return true;
    }

    async function showNotification(title, options = {}) {
        if (!isSupported()) return false;
        if (getPermission() !== 'granted') return false;

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

    return {
        isSupported,
        getPermission,
        requestPermission,
        ensureReady,
        showNotification
    };
}
