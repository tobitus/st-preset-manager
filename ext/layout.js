/**
 * ext/layout.js — pure geometry for remembered window rects (fix round 1,
 * item 5) and the floating button's position (item 10): a saved value is
 * clamped back on screen before it is applied. No DOM, no imports.
 */

/** @param {any} v @returns {boolean} */
const num = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Clamp a saved window rect into the viewport: size between `min` and the
 * viewport, then the position so the whole rect is on screen.
 * @param {{ left: number, top: number, width: number, height: number }|null|undefined} rect
 * @param {{ width: number, height: number }} viewport
 * @param {{ width: number, height: number }} [min]
 * @returns {{ left: number, top: number, width: number, height: number }|null} null for malformed input
 */
export function clampRect(rect, viewport, min = { width: 360, height: 220 }) {
    if (!rect || typeof rect !== 'object') return null;
    const { left, top, width, height } = rect;
    if (![left, top, width, height].every(num)) return null;
    const w = Math.min(Math.max(width, min.width), viewport.width);
    const h = Math.min(Math.max(height, min.height), viewport.height);
    return {
        left: Math.min(Math.max(left, 0), viewport.width - w),
        top: Math.min(Math.max(top, 0), viewport.height - h),
        width: w,
        height: h,
    };
}

/**
 * Clamp a saved top-left point so a box of `size` stays fully on screen.
 * @param {{ left: number, top: number }|null|undefined} point
 * @param {{ width: number, height: number }} size
 * @param {{ width: number, height: number }} viewport
 * @returns {{ left: number, top: number }|null} null for malformed input
 */
export function clampPoint(point, size, viewport) {
    if (!point || typeof point !== 'object') return null;
    const { left, top } = point;
    if (!num(left) || !num(top)) return null;
    return {
        left: Math.min(Math.max(left, 0), Math.max(0, viewport.width - size.width)),
        top: Math.min(Math.max(top, 0), Math.max(0, viewport.height - size.height)),
    };
}
