import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // The host already dedupes react because it has been bitten by duplicate React
  // instances before — mirroring the real consumer's config exactly.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
})
