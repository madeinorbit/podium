import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/browser.ts'],
  format: ['esm'],
  clean: true,
  sourcemap: true,
  treeshake: true,
})
