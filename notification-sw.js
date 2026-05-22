self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    event.waitUntil((async () => {
        const clientList = await clients.matchAll({
            type: 'window',
            includeUncontrolled: true
        });

        if (clientList.length > 0) {
            await clientList[0].focus();
        }
    })());
});
