import { defineConfig } from 'vite'

const allowedHosts = ['podium-host.example.com']

export default defineConfig({
  server: {
    allowedHosts,
  },
  preview: {
    allowedHosts,
  },
})
