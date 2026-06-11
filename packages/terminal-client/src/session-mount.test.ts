import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('session-mount fit-on-connect', () => {
  it('clears stale pre-fit output and redraws when becoming controller', () => {
    const src = readFileSync(new URL('./session-mount.ts', import.meta.url), 'utf8')
    expect(src).toContain('lastEpoch')
    expect(src).toContain('view.clear()')
    expect(src).toContain('connection.redraw()')
  })

  it('resets the epoch tracker on disconnect so a reconnect replay repaints clean', () => {
    const src = readFileSync(new URL('./session-mount.ts', import.meta.url), 'utf8')
    expect(src).toContain('if (!state.connected)')
    expect(src).toContain('lastEpoch = -1')
  })
})
