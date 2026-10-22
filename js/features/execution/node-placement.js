/** All dimensions are canvas units, never screen pixels. */
export function nodeBounds(node, zoom = 1) {
    const rect = node.el?.getBoundingClientRect?.();
    return { x: Number(node.x) || 0, y: Number(node.y) || 0,
        width: Number(node.width) || node.el?.offsetWidth || rect?.width / zoom || 300,
        height: Number(node.height) || node.el?.offsetHeight || rect?.height / zoom || 340 };
}

export function findNearbyNodePosition({ x, y, width = 300, height = 340, occupied = [], gap = 40 }) {
    const overlaps = (px, py, box) => px < box.x + box.width + gap && px + width + gap > box.x
        && py < box.y + box.height + gap && py + height + gap > box.y;
    // Rectangle edges provide finite candidates on both sides of every obstacle.
    const xs = [...new Set([x, ...occupied.map(box => box.x + box.width + gap)])].filter(px => px >= x);
    const ys = [...new Set([y, ...occupied.flatMap(box => [box.y - height - gap, box.y + box.height + gap])])];
    let best = null, distance = Infinity;
    for (const px of xs) for (const py of ys) {
        const score = (px - x) ** 2 + (py - y) ** 2;
        if (score >= distance || occupied.some(box => overlaps(px, py, box))) continue;
        best = { x: px, y: py }; distance = score;
    }
    return best || { x, y };
}
