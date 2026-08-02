/**
 * The vector layers a pack carries.
 *
 * Vectors rather than rasters, deliberately. A rasterised road mask is a picture of
 * the roads at whatever resolution the tool that drew it happened to be set to —
 * baking one into a pack freezes somebody's slider position into somebody else's
 * data. The geometry is resolution-independent, is a fraction of the size, and is
 * what a consumer doing anything other than drawing (routing, mobility, snapping)
 * actually needs.
 *
 * All coordinates are normalised box coordinates — see `BoxPoint` in `geo.ts`.
 * `Float32Array` because 0..1 at single precision resolves to a few millimetres on
 * the ground at any box size worth packing.
 */
export const ROAD_CLASSES = [
    'track',
    'minor',
    'secondary',
    'primary',
    'motorway',
];
/** Typical carriageway width in metres, by class. Reference data, not a style. */
export const ROAD_WIDTH_METRES = {
    motorway: 24,
    primary: 12,
    secondary: 9,
    minor: 6,
    track: 3.5,
};
//# sourceMappingURL=vector.js.map