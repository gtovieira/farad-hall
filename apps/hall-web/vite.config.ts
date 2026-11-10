// `pnpm --filter @hall/web dev` serves the UI with hot reload and forwards /api to a running
// hall-api (HALL_API_URL, default http://localhost:8080). `vite build` writes dist/, which Caddy
// (deploy/) or hall-api (HALL_WEB_DIR) serves.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env['HALL_API_URL'] ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: { proxy: { '/api': { target: api, changeOrigin: false } } },
});
