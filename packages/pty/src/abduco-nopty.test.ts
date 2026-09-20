/**
 * abduco refuses headless spawns (POD-4433).
 *
 * `AbducoSpawnOptions` widened for the host's pty-less mode (`noPty`, optional
 * geometry) is shared with abduco's own spawn — so the refusal must be proven
 * at runtime, before any binary resolves, rather than trusted to the type.
 * Both guards below throw hermetically: no abduco binary is consulted.
 */
import { describe, expect, it } from 'vitest'
import { spawnAbducoAgent } from './abduco.js'

describe('abduco refuses headless spawns', () => {
  it('rejects noPty instead of forking a pty the engine did not ask for', async () => {
    await expect(spawnAbducoAgent({ label: 'engine-x', cmd: 'sh', noPty: true })).rejects.toThrow(
      /no pty-less mode/,
    )
  })

  it('rejects a pty spawn without geometry rather than forking at a junk size', async () => {
    await expect(spawnAbducoAgent({ label: 'shell-x', cmd: 'sh' })).rejects.toThrow(
      /needs --cols\/--rows/,
    )
  })
})
