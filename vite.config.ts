import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The OpenTopography key comes from .env (VITE_OPENTOPO_KEY), which is gitignored, and
// is appended by the dev proxy server-side so requests from the browser never carry it.
// See .env.example.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const key = env.VITE_OPENTOPO_KEY ?? ''
  if (!key) {
    console.warn('[terrain-builder] VITE_OPENTOPO_KEY is not set — DEM requests will fail.')
  }

  return {
    plugins: [react()],
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
