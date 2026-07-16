// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const viteConfig = readFileSync(
  fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  'utf8',
)

describe('workspace source resolution', () => {
  it('resolves domain source without requiring a generated workspace link', () => {
    expect(viteConfig).toContain("'@podium/domain': fileURLToPath(")
    expect(viteConfig).toContain("new URL('../../packages/domain/src/index.ts', import.meta.url)")
  })
})
