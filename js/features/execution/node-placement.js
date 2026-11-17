/** All dimensions are canvas units, never screen pixels. */
export function nodeBounds(node, zoom = 1) {
    const rect = node.el?.getBoundingClientRect?.();
    const measuredWidth = Number(node.el?.offsetWidth) || rect?.width / zoom;
    const measuredHeight = Number(node.el?.offsetHeight) || rect?.height / zoom;
    return { x: Number(node.x) || 0, y: Number(node.y) || 0,
        width: measuredWidth || Number(node.width) || 300,
        height: measuredHeight || Number(node.height) || 340 };
}

export function setNodePosition(node, { x, y }) {
    node.x = x;
    node.y = y;
    if (node.el) {
        node.el.style.left = `${x}px`;
        node.el.style.top = `${y}px`;
    }
}

export function findNearbyNodePosition({ x, y, width = 300, height = 340, occupied = [], gap = 40, preferredArea }) {
    const overlaps = (px, py, box) => px < box.x + box.width + gap && px > box.x - width - gap
        && py < box.y + box.height + gap && py > box.y - height - gap;
    const isInView = (px, py) => Boolean(preferredArea && px >= preferredArea.left && px <= preferredArea.right
        && py >= preferredArea.top && py <= preferredArea.bottom);
    if ((!preferredArea || isInView(x, y)) && !occupied.some(box => overlaps(x, y, box))) return { x, y };
    const xs = new Set([x]);
    const ys = new Set([y]);
    if (preferredArea) {
        xs.add(preferredArea.left).add(preferredArea.right);
        ys.add(preferredArea.top).add(preferredArea.bottom);
    }
    for (const box of occupied) {
        const right = box.x + box.width + gap;
        if (right >= x || preferredArea) xs.add(right);
        if (preferredArea) xs.add(box.x - width - gap);
        ys.add(box.y - height - gap).add(box.y + box.height + gap);
    }
    let best = null, distance = Infinity, bestInView = false;
    for (const px of xs) for (const py of ys) {
        const inView = isInView(px, py);
        const score = (px - x) ** 2 + (py - y) ** 2;
        if ((!inView && bestInView) || (inView === bestInView && score >= distance)
            || occupied.some(box => overlaps(px, py, box))) continue;
        best = { x: px, y: py };
        distance = score;
        bestInView = inView;
    }
    return best || { x, y };
}

export function findViewportNodePosition({ viewport, width = 300, height = 340,
    visibleWidth = width, visibleHeight = height, occupied = [], gap }) {
    const { x: left, y: top, width: viewportWidth = 0, height: viewportHeight = 0 } = viewport;
    const right = left + Math.max(0, viewportWidth - visibleWidth);
    const bottom = top + Math.max(0, viewportHeight - visibleHeight);
    const placement = { x: (left + right) / 2, y: (top + bottom) / 2, width, height, occupied, gap,
        preferredArea: { left, right, top, bottom } };
    const position = findNearbyNodePosition(placement);
    const panel = viewport.blockedSpan;
    if (panel && width <= viewportWidth && height <= viewportHeight
        && position.x < panel.x + panel.width && position.x + width > panel.x
        && position.y < panel.y + panel.height && position.y + height > panel.y) {
        return findNearbyNodePosition({ ...placement, occupied: [...occupied, panel] });
    }
    return position;
}
