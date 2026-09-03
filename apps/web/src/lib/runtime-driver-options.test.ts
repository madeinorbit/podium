import { describe, expect, it } from 'vitest'
import { runtimeDriverLabel } from './runtime-driver-options.js'

describe('runtime driver labels', () => {
  it('distinguishes both OpenCode headless generations', () => {
    expect(runtimeDriverLabel('opencode-server')).toBe('OpenCode 1 (headless)')
    expect(runtimeDriverLabel('opencode2-server')).toBe('OpenCode 2 (headless)')
    expect(runtimeDriverLabel('codex-app-server')).toBe('codex-app-server')
  })
})
