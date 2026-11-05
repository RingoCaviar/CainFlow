// Encode large local-save payloads away from the canvas input thread.
self.addEventListener('message', ({ data: { id, json } }) => {
    self.postMessage({ id, body: new Blob([json], { type: 'application/json' }) });
});
