/**
 * Everything about the builder that belongs to the host rather than to the builder.
 *
 * Storage names, service endpoints and the asset base all used to be hardcoded across
 * a dozen files, each reaching for `import.meta.env` on its own. That is fine while
 * this is the whole application and fatal the moment it is a component inside
 * something else: two copies would fight over one IndexedDB database, the localStorage
 * keys would collide, and the endpoints would assume a dev proxy the host does not run.
 *
 * So there is one place to change, and `import.meta.env` is read here and nowhere else.
 * Defaults reproduce the standalone behaviour exactly, so a host that configures
 * nothing gets what this app has always done.
 */

export interface BuilderEndpoints {
  /**
   * OpenTopography's global DEM API, given the query string.
   *
   * A function rather than a base URL because the key handling differs by deployment:
   * the dev proxy appends it server-side so it never reaches the browser, while a
   * static build has to send it. A host with its own proxy overrides this outright.
   */
  openTopography: (queryString: string) => string
  /** AWS Terrain Tiles, `z/x/y`. */
  terrarium: (z: number, x: number, y: number) => string
  /** Esri World Imagery. Served `z/y/x` — note the order. */
  imagery: (z: number, y: number, x: number) => string
  /**
   * TileJSON endpoint for OpenMapTiles-schema vector tiles — the road/water/wood/
   * built-up/place source. Resolved once per session for the tile URL template.
   * The default is OpenFreeMap: keyless, CORS-open, no stated limits. A host that
   * wants its own weather can point this at any OpenMapTiles-compatible server or a
   * self-hosted PMTiles-backed endpoint.
   */
  osmTiles: string
  /**
   * Overpass instances, tried in order.
   *
   * Several, because slots are counted per client IP and a busy instance answers 429
   * rather than failing outright — a mirror is the difference between a map and an
   * error. Never add one without checking it serves a certificate for its own
   * hostname; one added from memory here did not, and cost an evening.
   */
  overpass: string[]
}

export interface BuilderConfig {
  /**
   * Namespace for the IndexedDB database and every localStorage key.
   *
   * Changing it orphans an existing cache rather than migrating it, and those entries
   * cost API allowance to refetch — so a host that wants isolation should set it once,
   * at startup, before anything reads.
   */
  storagePrefix: string
  /** Where bundled runtime assets live. The Köppen raster is served from here. */
  assetBase: string
  /**
   * Publish `window.__terrain` and `window.__viewer` for console driving.
   *
   * Off outside dev by default. A host embedding this should generally leave it off:
   * the hooks are globals, and two builders on one page would overwrite each other's.
   */
  devHooks: boolean
  endpoints: BuilderEndpoints
}

const dev = import.meta.env.DEV

const DEFAULTS: BuilderConfig = {
  storagePrefix: 'terrain-builder',
  assetBase: import.meta.env.BASE_URL,
  devHooks: dev,
  endpoints: {
    openTopography: (qs) => {
      // In dev the Vite proxy appends API_Key server-side; a static build must send it.
      if (dev) return `/api/opentopo/globaldem?${qs}`
      const key = import.meta.env.VITE_OPENTOPO_KEY ?? ''
      return `https://portal.opentopography.org/API/globaldem?${qs}&API_Key=${key}`
    },
    // Both tile sources are proxied in dev so the canvas we read pixels back from is
    // never tainted — a tainted canvas cannot be read, which breaks the DEM decode and
    // the imagery drape alike.
    terrarium: (z, x, y) =>
      dev
        ? `/api/terrarium/${z}/${x}/${y}.png`
        : `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    imagery: (z, y, x) =>
      dev
        ? `/api/imagery/${z}/${y}/${x}`
        : `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    osmTiles: 'https://tiles.openfreemap.org/planet',
    overpass: [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ],
  },
}

let current: BuilderConfig = DEFAULTS

/**
 * Override what the host owns. Call once, before the builder mounts.
 *
 * Shallow over the top level and one deep into `endpoints`, so a host can replace a
 * single service without restating the others.
 */
export function configureBuilder(patch: Partial<Omit<BuilderConfig, 'endpoints'>> & {
  endpoints?: Partial<BuilderEndpoints>
}): void {
  current = {
    ...current,
    ...patch,
    endpoints: { ...current.endpoints, ...(patch.endpoints ?? {}) },
  }
}

export function builderConfig(): BuilderConfig {
  return current
}

/** A namespaced localStorage key. Every one in the builder goes through here. */
export function storageKey(name: string): string {
  return `${current.storagePrefix}.${name}`
}
