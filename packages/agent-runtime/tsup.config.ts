import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/metadata.ts', 'src/testing/index.ts'],
  format: ['esm'],
  clean: true,
  sourcemap: true,
  treeshake: true,
})
