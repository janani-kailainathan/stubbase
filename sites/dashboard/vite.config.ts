import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Same-origin paths for the two Bun backends in dev (avoids CORS).
    proxy: {
      '/api/app': {
        target: process.env.APP_API_TARGET ?? 'http://127.0.0.1:3001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/app/, ''),
      },
      '/api/core': {
        target: process.env.CORE_API_TARGET ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/core/, ''),
      },
    },
  },
})
