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

function getOrthogonalRouteMetrics(start, end, laneOffset) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const forwardGap = end.x - start.x;
    const verticalSpan = Math.abs(dy);
    const lateralShift = Math.abs(laneOffset);
    return {
        dx,
        dy,
        forwardGap,
        verticalSpan,
        lateralShift,
        distance: Math.hypot(dx, dy)
    };
}

function buildOrthogonalForwardRoute(start, end, laneOffset) {
    const points = [];
    const channelYStart = start.y + laneOffset;
    const channelYEnd = end.y + laneOffset;
    const trunkX = start.x + (end.x - start.x) / 2;

    pushWaypoint(points, start);
    if (Math.abs(channelYStart - start.y) > 0.001) {
        pushWaypoint(points, { x: start.x, y: channelYStart });
    }
    pushWaypoint(points, { x: trunkX, y: channelYStart });
    pushWaypoint(points, { x: trunkX, y: channelYEnd });
    if (Math.abs(channelYEnd - end.y) > 0.001) {
        pushWaypoint(points, { x: end.x, y: channelYEnd });
    }
    pushWaypoint(points, end);
    return points;
}

function buildOrthogonalOuterRoute(start, end, laneOffset) {
    const points = [];
    const dy = end.y - start.y;
    const spread = Math.max(24, Math.min(72, Math.abs(dy) * 0.4 + Math.abs(laneOffset) * 0.6 + 20));
    const direction = Math.abs(laneOffset) > 0.001
        ? Math.sign(laneOffset)
        : (dy >= 0 ? 1 : -1);
    const detourY = direction > 0
        ? Math.max(start.y, end.y) + spread
        : Math.min(start.y, end.y) - spread;

    pushWaypoint(points, start);
    pushWaypoint(points, { x: start.x, y: detourY });
    pushWaypoint(points, { x: end.x, y: detourY });
    pushWaypoint(points, end);
    return points;
}

function buildOrthogonalWaypoints(x1, y1, x2, y2, options = {}) {
    const transition = getPortTransitionPoints(x1, y1, x2, y2, options);
    const start = transition.start;
    const end = transition.end;
    const laneOffset = getLaneOffset(options);
    const waypoints = [];
    const metrics = getOrthogonalRouteMetrics(start, end, laneOffset);
    const minimumForwardGap = Math.max(20, Math.min(52, metrics.verticalSpan * 0.12 + metrics.lateralShift * 0.35 + 20));
    const canUseForwardRoute = metrics.forwardGap >= minimumForwardGap;

    pushWaypoint(waypoints, { x: x1, y: y1 });

    if (metrics.distance < 24) {
        pushWaypoint(waypoints, { x: x2, y: y2 });
        return waypoints;
    }

    if (metrics.forwardGap >= 0 && metrics.verticalSpan < 0.001 && metrics.lateralShift < 0.001) {
        pushWaypoint(waypoints, { x: x2, y: y2 });
        return waypoints;
    }

    if (transition.outputDistance > 0) pushWaypoint(waypoints, start);

    const route = canUseForwardRoute
        ? buildOrthogonalForwardRoute(start, end, laneOffset)
        : buildOrthogonalOuterRoute(start, end, laneOffset);

    route.slice(1).forEach((point) => pushWaypoint(waypoints, point));
    if (transition.inputDistance > 0) pushWaypoint(waypoints, end);
    pushWaypoint(waypoints, { x: x2, y: y2 });
    return waypoints;
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

function sampleOrthogonalPoints(x1, y1, x2, y2, options = {}) {
    const waypoints = buildOrthogonalWaypoints(x1, y1, x2, y2, options);
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
        ? sampleOrthogonalPoints(x1, y1, x2, y2, options)
        : sampleBezierPoints(x1, y1, x2, y2, 18, options);
}

export function createBezierPath(x1, y1, x2, y2, options = {}) {
    const { type = 'bezier' } = normalizeConnectionPathOptions(options);

    if (type === 'orthogonal') {
        const waypoints = buildOrthogonalWaypoints(x1, y1, x2, y2, options);
        const dx = Math.abs(x2 - x1);
        const dy = Math.abs(y2 - y1);
        const radius = Math.min(18, Math.max(6, Math.min(dx, dy) * 0.22));
        return createRoundedPolylinePath(waypoints, radius);
    }

    const { start, control1, control2, end } = getBezierCurveGeometry(x1, y1, x2, y2, options);
    return `M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`;
}
