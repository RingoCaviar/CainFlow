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

function getPortTransitionDistances(options = {}) {
    const fallback = Number(options.portTransition ?? options.transition ?? 0);
    const outputRaw = Number(options.outputTransition ?? fallback);
    const inputRaw = Number(options.inputTransition ?? fallback);
    return {
        output: Number.isFinite(outputRaw) ? Math.max(0, outputRaw) : 0,
        input: Number.isFinite(inputRaw) ? Math.max(0, inputRaw) : 0
    };
}

function getLaneOffset(options = {}) {
    const raw = Number(options.laneOffset ?? 0);
    return Number.isFinite(raw) ? raw : 0;
}

function getPortTransitionPoints(x1, y1, x2, y2, options = {}) {
    const distances = getPortTransitionDistances(options);
    return {
        start: { x: x1 + distances.output, y: y1 },
        end: { x: x2 - distances.input, y: y2 },
        outputDistance: distances.output,
        inputDistance: distances.input
    };
}

function getBezierCurveGeometry(x1, y1, x2, y2, options = {}) {
    const distances = getPortTransitionDistances(options);
    const laneOffset = getLaneOffset(options);
    const span = Math.abs(x2 - x1);
    const defaultHandle = Math.max(60, span * 0.5);
    const outputHandle = Math.max(defaultHandle, distances.output);
    const inputHandle = Math.max(defaultHandle, distances.input);

    return {
        start: { x: x1, y: y1 },
        control1: { x: x1 + outputHandle, y: y1 + laneOffset },
        control2: { x: x2 - inputHandle, y: y2 + laneOffset },
        end: { x: x2, y: y2 }
    };
}

function isSamePoint(a, b) {
    return Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001;
}

function isAxisAligned(a, b, c) {
    return (Math.abs(a.x - b.x) < 0.001 && Math.abs(b.x - c.x) < 0.001) ||
        (Math.abs(a.y - b.y) < 0.001 && Math.abs(b.y - c.y) < 0.001);
}

function isPointBetween(a, b, c) {
    return b.x >= Math.min(a.x, c.x) - 0.001 &&
        b.x <= Math.max(a.x, c.x) + 0.001 &&
        b.y >= Math.min(a.y, c.y) - 0.001 &&
        b.y <= Math.max(a.y, c.y) + 0.001;
}

function pushWaypoint(points, point) {
    const last = points[points.length - 1];
    if (last && isSamePoint(last, point)) return;

    const prev = points[points.length - 2];
    if (prev && last && isAxisAligned(prev, last, point) && isPointBetween(prev, last, point)) {
        points[points.length - 1] = point;
        return;
    }

    points.push(point);
}

const ORTHOGONAL_PORT_GUARD = 5;
const ORTHOGONAL_CORNER_RADIUS = 8;

function buildOrthogonalWaypoints(x1, y1, x2, y2) {
    const points = [];
    const turnGuard = ORTHOGONAL_PORT_GUARD + ORTHOGONAL_CORNER_RADIUS;
    const startGuard = { x: x1 + turnGuard, y: y1 };
    const endGuard = { x: x2 - turnGuard, y: y2 };

    pushWaypoint(points, { x: x1, y: y1 });
    pushWaypoint(points, startGuard);

    if (startGuard.x > endGuard.x) {
        const midY = y1 + (y2 - y1) / 2;
        pushWaypoint(points, { x: startGuard.x, y: midY });
        pushWaypoint(points, { x: endGuard.x, y: midY });
        pushWaypoint(points, endGuard);
        pushWaypoint(points, { x: x2, y: y2 });
        return points;
    }

    const midX = startGuard.x + (endGuard.x - startGuard.x) / 2;
    pushWaypoint(points, { x: midX, y: startGuard.y });
    pushWaypoint(points, { x: midX, y: endGuard.y });
    pushWaypoint(points, endGuard);
    pushWaypoint(points, { x: x2, y: y2 });
    return points;
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

        const inX = (current.x - prev.x) / lenIn;
        const inY = (current.y - prev.y) / lenIn;
        const outX = (next.x - current.x) / lenOut;
        const outY = (next.y - current.y) / lenOut;
        if (inX * outX + inY * outY < -0.999) {
            path += ` L ${current.x} ${current.y}`;
            continue;
        }

        const radius = Math.min(radiusLimit, lenIn / 2, lenOut / 2);
        const start = {
            x: current.x - inX * radius,
            y: current.y - inY * radius
        };
        const end = {
            x: current.x + outX * radius,
            y: current.y + outY * radius
        };

        path += ` L ${start.x} ${start.y} Q ${current.x} ${current.y} ${end.x} ${end.y}`;
    }

    return path;
}

function sampleBezierPoints(x1, y1, x2, y2, steps = 18, options = {}) {
    const { start, control1, control2, end } = getBezierCurveGeometry(x1, y1, x2, y2, options);
    const points = [];

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const it = 1 - t;
        const x = it * it * it * start.x + 3 * it * it * t * control1.x + 3 * it * t * t * control2.x + t * t * t * end.x;
        const y = it * it * it * start.y +
            3 * it * it * t * control1.y +
            3 * it * t * t * control2.y +
            t * t * t * end.y;
        points.push({
            x,
            y
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
        : sampleBezierPoints(x1, y1, x2, y2, 18, options);
}

export function createBezierPath(x1, y1, x2, y2, options = {}) {
    const { type = 'bezier' } = normalizeConnectionPathOptions(options);

    if (type === 'orthogonal') {
        const waypoints = buildOrthogonalWaypoints(x1, y1, x2, y2);
        return createRoundedPolylinePath(waypoints, ORTHOGONAL_CORNER_RADIUS);
    }

    const { start, control1, control2, end } = getBezierCurveGeometry(x1, y1, x2, y2, options);
    return `M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`;
}
