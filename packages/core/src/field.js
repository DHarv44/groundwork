/**
 * Bilinear sample of the height field in fractional grid coordinates.
 *
 * Anything that needs to know where the surface *is* — placing a mesh vertex,
 * standing an object on the ground, walking a camera over it — has to sample it
 * this way, half-cell offset and all. Reimplementing it elsewhere is how a mesh and
 * the things standing on it drift apart.
 */
export function sampleBilinear(hf, fx, fy) {
    const { width, height, data } = hf;
    const x = Math.max(0, Math.min(width - 1, fx));
    const y = Math.max(0, Math.min(height - 1, fy));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const a = data[y0 * width + x0];
    const b = data[y0 * width + x1];
    const c = data[y1 * width + x0];
    const d = data[y1 * width + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
/**
 * Elevation in metres at a normalised box coordinate.
 *
 * The form an object registry wants: something is placed at a fraction across the
 * box and needs to sit on the ground, without knowing the raster's resolution.
 */
export function sampleBox(hf, x, y) {
    return sampleBilinear(hf, x * (hf.width - 1), y * (hf.height - 1));
}
//# sourceMappingURL=field.js.map