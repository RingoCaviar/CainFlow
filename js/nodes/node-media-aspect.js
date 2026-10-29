import { isImageFirstCardNode } from './image-first-presentation.js';

const surfaces = '.image-node-result-preview, .file-drop-zone, .preview-container, .save-preview-container, .image-compare-container, .camera-control-node-preview';
const mediaSelector = surfaces.split(', ').map(surface => `${surface} img, ${surface} video`).join(', ');
const mediaEvents = ['load', 'error', 'loadedmetadata', 'resize'];
const activeSurfaces = new WeakMap();

/** Only decoded primary previews determine geometry; reference thumbnails never do. */
export function syncNodeMediaAspect(node) {
    if (!node?.el?.querySelectorAll || !isImageFirstCardNode(node) && node.type !== 'VideoGenerate') return null;
    const candidates = node.type === 'VideoGenerate'
        ? node.el.querySelectorAll('.node-video-result-field video')
        : node.el.querySelectorAll(mediaSelector);
    let selected = null;
    for (const media of candidates) {
        if (!['IMG', 'VIDEO'].includes(media.tagName)) continue;
        if (node.type === 'ImageCompare' && !media.classList.contains('image-compare-b')) continue;
        if (media.error || media.closest('[hidden], .hidden') || !media.getClientRects().length) continue;
        const width = media.videoWidth || media.naturalWidth;
        const height = media.videoHeight || media.naturalHeight;
        if (!(width > 0 && height > 0)) continue;
        selected = { surface: media.closest(surfaces) || media, ratio: `${width} / ${height}` };
        break;
    }
    const previous = activeSurfaces.get(node);
    if (previous && previous !== selected?.surface) {
        previous.classList.remove('node-media-aspect-surface');
        previous.style.removeProperty('--node-media-aspect');
    }
    if (!selected || node.collapsed === true) {
        if (node.el.classList.contains('node-media-aspect')) node.el.classList.remove('node-media-aspect');
        activeSurfaces.delete(node);
        return null;
    }
    if (!node.el.classList.contains('node-media-aspect')) node.el.classList.add('node-media-aspect');
    if (!selected.surface.classList.contains('node-media-aspect-surface')) selected.surface.classList.add('node-media-aspect-surface');
    if (selected.surface.style.getPropertyValue('--node-media-aspect') !== selected.ratio) selected.surface.style.setProperty('--node-media-aspect', selected.ratio);
    activeSurfaces.set(node, selected.surface);
    return selected.surface;
}

export function bindNodeMediaAspect(node, { fitNode, windowRef }) {
    if (!node?.el || !windowRef?.requestAnimationFrame || !isImageFirstCardNode(node) && node.type !== 'VideoGenerate') return;
    let frame = null;
    const schedule = event => {
        if (event && !['IMG', 'VIDEO'].includes(event.target?.tagName)) return;
        if (event && !event.target.closest(surfaces) && !event.target.matches('.node-video-result-field video')) return;
        if (frame !== null) return;
        frame = windowRef.requestAnimationFrame(() => {
            frame = null;
            if (node.el.isConnected) fitNode(node.id, { reason: 'element-resize', preserveCurrentWidth: true });
        });
    };
    for (const name of mediaEvents) node.el.addEventListener(name, schedule, true);
    (node.el._cleanupFns ||= []).push(() => {
        for (const name of mediaEvents) node.el.removeEventListener(name, schedule, true);
        if (frame !== null) windowRef.cancelAnimationFrame(frame);
        activeSurfaces.delete(node);
    });
    schedule();
}
