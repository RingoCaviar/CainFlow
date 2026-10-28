/** Read the existing filename draft from this node's controls or retained fields. */
export function readImageSaveFilename(node, fallback = 'generated_image') {
    const selector = `#${node?.id || ''}-filename`;
    const control = node?.el?.querySelector?.(selector) || node?.parameterRoot?.querySelector?.(selector);
    return String(control?.value ?? node?.filename ?? node?.data?.filename ?? fallback);
}
