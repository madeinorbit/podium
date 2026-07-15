import { describe, expect, it } from 'vitest'
import { CodexReadinessBoundary } from './codex-readiness'

describe('CodexReadinessBoundary', () => {
  it('opens only after one ready screen stays quiet for the configured interval', () => {
    const boundary = new CodexReadinessBoundary(1_500)
    expect(boundary.observe({ ready: true, hash: 'composer' }, 1_000)).toBe(false)
    expect(boundary.observe({ ready: true, hash: 'composer' }, 2_499)).toBe(false)
    expect(boundary.observe({ ready: true, hash: 'composer' }, 2_500)).toBe(true)
  })

  it('restarts the quiet interval when MCP startup redraws the composer', () => {
    const boundary = new CodexReadinessBoundary(1_500)
    expect(boundary.observe({ ready: true, hash: 'early-composer' }, 1_000)).toBe(false)
    expect(boundary.observe({ ready: true, hash: 'post-mcp-composer' }, 2_400)).toBe(false)
    expect(boundary.observe({ ready: true, hash: 'post-mcp-composer' }, 3_899)).toBe(false)
    expect(boundary.observe({ ready: true, hash: 'post-mcp-composer' }, 3_900)).toBe(true)
  })

  it('resets when the composer disappears between otherwise identical screens', () => {
    const boundary = new CodexReadinessBoundary(1_500)
    boundary.observe({ ready: true, hash: 'composer' }, 1_000)
    expect(boundary.observe({ ready: false, hash: 'composer' }, 2_000)).toBe(false)
    expect(boundary.observe({ ready: true, hash: 'composer' }, 2_500)).toBe(false)
    expect(boundary.observe({ ready: true, hash: 'composer' }, 4_000)).toBe(true)
  })
})
