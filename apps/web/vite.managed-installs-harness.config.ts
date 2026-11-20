import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { standardDecorators } from '../../scripts/vite-standard-decorators'
export default defineConfig({
  plugins: [standardDecorators(), react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 55658, strictPort: true, host: '127.0.0.1', fs: { strict: false } },
})
