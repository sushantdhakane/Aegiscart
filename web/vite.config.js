import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built output lands in ../public so the existing Express server serves the
// production build from one process. `npm run dev` starts Vite on 5173 and
// proxies API calls to the Express server (PORT env or 3526).
const apiPort = Number(process.env.PORT) || 3526;

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: '../public', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/v1': { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
});
