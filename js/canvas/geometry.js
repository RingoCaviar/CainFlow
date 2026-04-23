/**
 * 提供画布连线与选区计算所需的几何工具函数，例如贝塞尔路径和线段相交判断。
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

export function createBezierPath(x1, y1, x2, y2) {
    const dx = Math.abs(x2 - x1);
    const c1x = x1 + Math.max(60, dx * 0.5);
    const c2x = x2 - Math.max(60, dx * 0.5);
    return `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`;
}
/**
 * 提供画布连线和坐标相关的几何计算工具。
 */
