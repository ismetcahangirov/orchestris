import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const SERVER = 'http://127.0.0.1:4319'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5319,
    // Proxy sayəsində frontend eyni origin-dən danışır — CORS lazım deyil.
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER, ws: true, changeOrigin: true },
    },
  },
})
