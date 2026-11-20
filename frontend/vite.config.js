import { defineConfig } from 'vite';

export default defineConfig({
  // '/' for Vercel and local dev; the Pages workflow sets VITE_BASE=/search-comete/
  base: process.env.VITE_BASE || '/',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});