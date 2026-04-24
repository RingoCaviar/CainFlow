/**
 * 提供画布连线与选区计算所需的几何工具，例如连线路径生成与线段相交判断。
 */
export function checkLineIntersection(p1, p2, p3, p4) {
    const den = (p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y);
    if (den === 0) return null;
    const ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / den;
    const ub = ((p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x)) / den;
    if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) {
        return { x: p1.x + ua * (p2.x - p1.x), y: p1.y + ua * (p2.y - p1.y) };
    }
    return null;
}

function normalizeConnectionPathOptions(options = {}) {
    if (typeof options === 'string') return { type: options };
    return options && typeof options === 'object' ? options : {};
}

function buildOrthogonalWaypoints(x1, y1, x2, y2) {
    const dx = x2 - x1;
    if (dx >= 0) {
        const midX = x1 + dx / 2;
        return [
            { x: x1, y: y1 },
            { x: midX, y: y1 },
            { x: midX, y: y2 },
            { x: x2, y: y2 }
        ];
    }

    const channelOffset = Math.max(56, Math.min(120, Math.abs(dx) * 0.35 + 28));
    const channelX = Math.max(x1, x2) + channelOffset;
    return [
        { x: x1, y: y1 },
        { x: channelX, y: y1 },
        { x: channelX, y: y2 },
        { x: x2, y: y2 }
    ];
}

function createRoundedPolylinePath(points, radiusLimit = 18) {
    if (!points.length) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

    let path = `M ${points[0].x} ${points[0].y}`;

    for (let i = 1; i < points.length; i++) {
        const current = points[i];
        const prev = points[i - 1];
        const next = points[i + 1];

        if (!next) {
            path += ` L ${current.x} ${current.y}`;
            continue;
        }

        const lenIn = Math.hypot(current.x - prev.x, current.y - prev.y);
        const lenOut = Math.hypot(next.x - current.x, next.y - current.y);
        if (lenIn < 0.001 || lenOut < 0.001) {
            path += ` L ${current.x} ${current.y}`;
            continue;
        }

        const radius = Math.min(radiusLimit, lenIn / 2, lenOut / 2);
        const start = {
            x: current.x - ((current.x - prev.x) / lenIn) * radius,
            y: current.y - ((current.y - prev.y) / lenIn) * radius
        };
        const end = {
            x: current.x + ((next.x - current.x) / lenOut) * radius,
            y: current.y + ((next.y - current.y) / lenOut) * radius
        };

        path += ` L ${start.x} ${start.y} Q ${current.x} ${current.y} ${end.x} ${end.y}`;
    }

    return path;
}

function sampleBezierPoints(x1, y1, x2, y2, steps = 18) {
    const dx = Math.abs(x2 - x1);
    const c1x = x1 + Math.max(60, dx * 0.5);
    const c2x = x2 - Math.max(60, dx * 0.5);
    const points = [];

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const it = 1 - t;
        points.push({
            x: it * it * it * x1 + 3 * it * it * t * c1x + 3 * it * t * t * c2x + t * t * t * x2,
            y: it * it * it * y1 + 3 * it * it * t * y1 + 3 * it * t * t * y2 + t * t * t * y2
        });
    }

    return points;
}

function sampleOrthogonalPoints(x1, y1, x2, y2) {
    const waypoints = buildOrthogonalWaypoints(x1, y1, x2, y2);
    const points = [waypoints[0]];

    for (let i = 1; i < waypoints.length; i++) {
        const prev = waypoints[i - 1];
        const current = waypoints[i];
        const segmentLength = Math.hypot(current.x - prev.x, current.y - prev.y);
        const steps = Math.max(1, Math.ceil(segmentLength / 28));

        for (let step = 1; step <= steps; step++) {
            const t = step / steps;
            points.push({
                x: prev.x + (current.x - prev.x) * t,
                y: prev.y + (current.y - prev.y) * t
            });
        }
    }

    return points;
}

export function getConnectionSamplePoints(x1, y1, x2, y2, options = {}) {
    const { type = 'bezier' } = normalizeConnectionPathOptions(options);
    return type === 'orthogonal'
        ? sampleOrthogonalPoints(x1, y1, x2, y2)
        : sampleBezierPoints(x1, y1, x2, y2);
}

export function createBezierPath(x1, y1, x2, y2, options = {}) {
    const { type = 'bezier' } = normalizeConnectionPathOptions(options);

    if (type === 'orthogonal') {
        const waypoints = buildOrthogonalWaypoints(x1, y1, x2, y2);
        const dx = Math.abs(x2 - x1);
        const dy = Math.abs(y2 - y1);
        const radius = Math.min(18, Math.max(6, Math.min(dx, dy) * 0.22));
        return createRoundedPolylinePath(waypoints, radius);
    }

    const dx = Math.abs(x2 - x1);
    const c1x = x1 + Math.max(60, dx * 0.5);
    const c2x = x2 - Math.max(60, dx * 0.5);
    return `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`;
}
