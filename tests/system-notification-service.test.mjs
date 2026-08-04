import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const source = await fs.readFile(new URL('../js/services/system-notification-service.js', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { createSystemNotificationService } = await import(moduleUrl);

test('Windows routes notifications to the native endpoint only', async () => {
    const requests = [];
    const service = createSystemNotificationService({
        platformRef: 'Win32',
        notificationRef: { permission: 'denied' },
        fetchRef: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, json: async () => ({ success: true, channel: 'windows-native' }) };
        }
    });
    assert.equal(service.getPermission(), 'granted');
    assert.equal(await service.showNotification('CainFlow', { body: 'done' }), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/system-notification');
});

test('Windows native failure does not fall through to browser notifications', async () => {
    let browserNotifications = 0;
    function NotificationStub() { browserNotifications += 1; }
    NotificationStub.permission = 'granted';
    const service = createSystemNotificationService({
        platformRef: 'Windows',
        notificationRef: NotificationStub,
        fetchRef: async () => ({ ok: false, statusText: 'failed', json: async () => ({ success: false, error: 'blocked' }) }),
        consoleRef: { warn() {} }
    });
    assert.equal(await service.showNotification('CainFlow'), false);
    assert.equal(browserNotifications, 0);
});

test('Windows falls back to browser notifications only when native delivery is unsupported', async () => {
    const shown = [];
    function NotificationStub(title) { shown.push(title); }
    NotificationStub.permission = 'granted';
    const service = createSystemNotificationService({
        platformRef: 'Windows',
        notificationRef: NotificationStub,
        navigatorRef: null,
        fetchRef: async () => ({ ok: true, json: async () => ({ success: false, channel: 'unsupported' }) })
    });
    assert.equal(await service.showNotification('CainFlow'), true);
    assert.deepEqual(shown, ['CainFlow']);
});

test('non-Windows keeps the browser notification path', async () => {
    const shown = [];
    function NotificationStub(title, options) { shown.push({ title, options }); }
    NotificationStub.permission = 'granted';
    const service = createSystemNotificationService({
        platformRef: 'Linux x86_64',
        notificationRef: NotificationStub,
        navigatorRef: null,
        fetchRef: null
    });
    assert.equal(await service.showNotification('CainFlow', { body: 'done' }), true);
    assert.equal(shown.length, 1);
});

test('macOS desktop routes notifications to the native endpoint', async () => {
    const requests = [];
    const service = createSystemNotificationService({
        platformRef: 'MacIntel',
        desktopRef: { info: { platform: 'darwin' } },
        notificationRef: null,
        fetchRef: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, json: async () => ({ success: true, channel: 'macos-native' }) };
        }
    });
    assert.equal(service.getPermission(), 'granted');
    assert.equal(await service.showNotification('CainFlow', { body: 'done' }), true);
    assert.equal(requests.length, 1);
});
