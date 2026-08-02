/**
 * The pack format — the contract between whatever writes terrain and whatever
 * renders it.
 *
 * Versioned from the first write. The lesson is already in this repo: the road cache
 * carries an `OSM_QUERY_VERSION` because an entry that cannot say what shape it is
 * has to be thrown away rather than migrated, and throwing away a cache entry costs
 * one refetch. A pack written by somebody else cannot be thrown away, so the version
 * has to be there before the first one exists rather than after the first one breaks.
 */
export const PACK_FORMAT_VERSION = 1;
/** Canonical filenames inside a pack. */
export const PACK_MANIFEST_FILE = 'pack.json';
export const PACK_VECTORS_FILE = 'vectors.json';
// ---- quantisation ----------------------------------------------------------
/**
 * Pack a float plane into `Uint16` across a known range.
 *
 * At 16 bits an entire Himalayan box resolves to about 13 cm and a typical one to
 * under 5 cm, which is far inside the noise of any elevation source worth packing —
 * so this is lossless in every way that matters and halves the file.
 */
export function quantise(data, min, max) {
    const out = new Uint16Array(data.length);
    const s = max > min ? 65535 / (max - min) : 0;
    for (let i = 0; i < data.length; i++) {
        const v = Math.round((data[i] - min) * s);
        out[i] = v < 0 ? 0 : v > 65535 ? 65535 : v;
    }
    return out;
}
export function dequantise(q, min, max) {
    const out = new Float32Array(q.length);
    const s = (max - min) / 65535;
    for (let i = 0; i < q.length; i++)
        out[i] = min + q[i] * s;
    return out;
}
/**
 * Decimal places kept on normalised vector coordinates.
 *
 * Six places is 1e-6 of the box: about 2.5 cm across 25 km, and under a metre across
 * the widest box the elevation sources will serve. Well below the positional accuracy
 * of the survey data itself, and it keeps the file from filling with float noise.
 */
const VECTOR_DP = 6;
function roundFlat(a) {
    const f = 10 ** VECTOR_DP;
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++)
        out[i] = Math.round(a[i] * f) / f;
    return out;
}
export function serialiseVectors(v) {
    const wire = {
        roads: v.roads.map((r) => ({ cls: r.cls, pts: roundFlat(r.pts) })),
        areas: v.areas.map((a) => ({
            kind: a.kind,
            outer: a.outer.map(roundFlat),
            inner: a.inner.map(roundFlat),
        })),
        places: v.places,
    };
    return JSON.stringify(wire);
}
export function parseVectors(json) {
    const wire = JSON.parse(json);
    return {
        roads: (wire.roads ?? []).map((r) => ({ cls: r.cls, pts: Float32Array.from(r.pts) })),
        areas: (wire.areas ?? []).map((a) => ({
            kind: a.kind,
            outer: (a.outer ?? []).map((r) => Float32Array.from(r)),
            inner: (a.inner ?? []).map((r) => Float32Array.from(r)),
        })),
        places: wire.places ?? [],
    };
}
// ---- validation ------------------------------------------------------------
/**
 * Check a manifest before anything trusts it.
 *
 * Returns every problem rather than throwing on the first, because the caller is
 * usually a person looking at a pack that somebody else made and the useful answer
 * is the whole list. An empty array means it is structurally sound — not that the
 * data in it is any good.
 */
export function validateManifest(m) {
    const errs = [];
    if (typeof m !== 'object' || m === null)
        return ['manifest is not an object'];
    const p = m;
    if (p.formatVersion !== PACK_FORMAT_VERSION) {
        errs.push(`formatVersion ${String(p.formatVersion)} — this reader understands ${PACK_FORMAT_VERSION}`);
    }
    if (!p.id)
        errs.push('missing id');
    if (!p.name)
        errs.push('missing name');
    const b = p.bounds;
    if (!b)
        errs.push('missing bounds');
    else if (b.north <= b.south || b.east <= b.west) {
        errs.push('bounds are empty or inverted');
    }
    if (!(p.width > 0) || !(p.height > 0))
        errs.push('width and height must be positive');
    if (!Array.isArray(p.layers) || p.layers.length === 0) {
        errs.push('no raster layers');
    }
    else {
        if (!p.layers.some((l) => l.id === 'elevation'))
            errs.push('no elevation layer');
        for (const l of p.layers) {
            if (!l.file)
                errs.push(`layer ${l.id}: missing file`);
            if (!(l.channels > 0))
                errs.push(`layer ${l.id}: channels must be positive`);
            if (l.format !== 'float32' && l.min === undefined) {
                // Not fatal — a class index or a flag legitimately has no range — but a
                // quantised measurement without one is unreadable, and that is the common slip.
                if (l.id === 'elevation')
                    errs.push('elevation layer has no min/max to dequantise with');
            }
        }
    }
    if (!Array.isArray(p.attribution) || p.attribution.length === 0) {
        errs.push('no attribution — every source this is derived from requires credit');
    }
    return errs;
}
/** A layer's own dimensions, falling back to the manifest's. */
export function layerSize(layer, manifest) {
    return {
        width: layer.width ?? manifest.width,
        height: layer.height ?? manifest.height,
    };
}
/** Bytes one plane of a layer occupies, for sizing a read. */
export function layerByteLength(layer, width, height) {
    const bytes = layer.format === 'uint8' ? 1 : layer.format === 'uint16' ? 2 : 4;
    return width * height * layer.channels * bytes;
}
//# sourceMappingURL=pack.js.map