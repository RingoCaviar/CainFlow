// Evaluate in the browser to run the whole workflow through the canvas shortcut.
export const runWorkflowShortcut = `(() => {
    const canvas = document.getElementById('canvas-container');
    canvas.focus({ preventScroll: true });
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
})()`;
