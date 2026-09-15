import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/pty.ts', 'src/durable.ts', 'src/screen.ts'],
  format: ['esm'],
  clean: true,
  sourcemap: true,
  treeshake: true,
})
