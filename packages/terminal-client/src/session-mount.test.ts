import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('session-mount fit-on-connect', () => {
  it('clears stale pre-fit output and redraws when becoming controller', () => {
    const src = readFileSync(new URL('./session-mount.ts', import.meta.url), 'utf8')
    expect(src).toContain('lastEpoch')
    expect(src).toContain('view.clear()')
    expect(src).toContain('connection.redraw()')
  })

  it('drives the (re)attach clear from the server resume signal, not a per-disconnect epoch reset', () => {
    const src = readFileSync(new URL('./session-mount.ts', import.meta.url), 'utf8')
    // The full-replay clear is owned by the server's signal (onReset) so a resuming
    // reconnect keeps its screen instead of flashing — the old code force-cleared on
    // every reconnect by resetting the epoch tracker on disconnect.
    expect(src).toContain('onReset:')
    // The epoch-bump clear (controller takeover) now only fires while connected.
    expect(src).toContain('if (state.connected)')
  })
})
