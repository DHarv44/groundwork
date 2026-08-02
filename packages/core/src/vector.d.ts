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
/**
 * Road classes, kept at OpenStreetMap's granularity.
 *
 * A consumer that wants three classes can collapse five; a consumer handed three
 * cannot recover five. The pack keeps what was observed and lets the far end decide.
 */
export type RoadClass = 'motorway' | 'primary' | 'secondary' | 'minor' | 'track';
export declare const ROAD_CLASSES: readonly RoadClass[];
/** Typical carriageway width in metres, by class. Reference data, not a style. */
export declare const ROAD_WIDTH_METRES: Record<RoadClass, number>;
/** One road centreline: a polyline as flat `[x, y, x, y, …]` box coordinates. */
export interface PackRoad {
    cls: RoadClass;
    pts: Float32Array;
}
export type AreaKind = 'water' | 'wood' | 'built';
/**
 * One mapped area: its outline, and anything cut out of it.
 *
 * A feature rather than a bare ring, because a hole only means anything relative to
 * the outline it belongs to. A lake with an island is one area with one outer ring
 * and one inner; keeping the pair together is what lets a rasteriser fill them with
 * an even-odd rule and get the island back instead of flooding it.
 */
export interface PackArea {
    kind: AreaKind;
    /** Closed rings, flat `[x, y, …]`. Usually one; a relation may have several. */
    outer: Float32Array[];
    /** Rings cut out of the outer ones — islands, clearings, courtyards. */
    inner: Float32Array[];
}
/**
 * A named point.
 *
 * Carried because names are what anything built on a pack anchors human-readable
 * references to, and there is no way to recover them from geometry. The kinds are
 * OpenStreetMap's `place` values; a consumer that only cares about size can read
 * `population` or ignore the distinction.
 */
export interface PackPlace {
    kind: 'city' | 'town' | 'village' | 'hamlet' | 'locality' | 'peak' | 'water';
    name: string;
    x: number;
    y: number;
    /** Metres, where the source had it — peaks and named summits. */
    elevation?: number;
    population?: number;
}
export interface PackVectors {
    roads: PackRoad[];
    areas: PackArea[];
    places: PackPlace[];
}
//# sourceMappingURL=vector.d.ts.map