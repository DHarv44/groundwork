import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The OpenTopography key comes from .env (VITE_OPENTOPO_KEY), which is gitignored, and
// is appended by the dev proxy server-side so requests from the browser never carry it.
// See .env.example.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const key = env.VITE_OPENTOPO_KEY ?? ''
  if (!key) {
    console.warn('[groundwork] VITE_OPENTOPO_KEY is not set — DEM requests will fail.')
  }

  return {
    plugins: [react()],
    resolve: {
      // The packages' `exports` point at `dist`, because that is what a published
      // consumer must get. Locally that would mean the app stops seeing source edits
      // until someone rebuilds dist — so dev and the in-repo demos resolve the three
      // packages straight to source here instead. Chosen over an `exports` "source"
      // condition because npm ignores `publishConfig.exports` swapping (that is a pnpm
      // feature), and over a watch build because a second compiler invalidates HMR.
      // Exact-match regexes so the styles.css subpath keeps its own mapping.
      alias: [
        {
          find: /^@dharv44\/groundwork-core$/,
          replacement: resolve(__dirname, 'packages/core/src/index.ts'),
        },
        {
          find: /^@dharv44\/groundwork-engine$/,
          replacement: resolve(__dirname, 'packages/engine/src/index.ts'),
        },
        {
          find: /^@dharv44\/groundwork-builder$/,
          replacement: resolve(__dirname, 'packages/builder/src/index.ts'),
        },
        {
          find: /^@dharv44\/groundwork-builder\/styles\.css$/,
          replacement: resolve(__dirname, 'packages/builder/src/styles.css'),
        },
      ],
    },
    build: {
      rollupOptions: {
        input: {
          // The builder.
          main: resolve(__dirname, 'index.html'),
          // The engine's portability test. Built alongside on purpose: if the boundary
          // ever leaks, this entry starts pulling React and the store into its chunk,
          // and the build output says so without anyone having to remember to check.
          engine: resolve(__dirname, 'demo/engine/index.html'),
          // The builder's equivalent: a pretend host with hostile global CSS, its own
          // storage namespace, and the builder confined to a box it does not own.
          host: resolve(__dirname, 'demo/builder/index.html'),
        },
      },
    },
    server: {
      port: 5190,
      strictPort: true,
      proxy: {
        // /api/opentopo/globaldem?... -> portal.opentopography.org/API/globaldem?...&API_Key=...
        '/api/opentopo': {
          target: 'https://portal.opentopography.org',
          changeOrigin: true,
          rewrite: (path) => {
            const rewritten = path.replace(/^\/api\/opentopo/, '/API')
            return rewritten + (rewritten.includes('?') ? '&' : '?') + 'API_Key=' + key
          },
        },
        // AWS Terrain Tiles — keyless, unquotaed elevation. Proxied so the canvas we
        // read pixels back from is never tainted.
        '/api/terrarium': {
          target: 'https://s3.amazonaws.com',
          changeOrigin: true,
          rewrite: (path) =>
            path.replace(/^\/api\/terrarium/, '/elevation-tiles-prod/terrarium'),
        },
        // Esri World Imagery, proxied so the composited canvas is never tainted.
        '/api/imagery': {
          target: 'https://services.arcgisonline.com',
          changeOrigin: true,
          rewrite: (path) =>
            path.replace(
              /^\/api\/imagery/,
              '/ArcGIS/rest/services/World_Imagery/MapServer/tile',
            ),
        },
      },
    },
  }
})
