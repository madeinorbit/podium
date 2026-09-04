import { ABDUCO_SUN_PATH_MAX, CLIENT_TERMINAL_LABEL_TOKEN_MAX } from '@podium/runtime/abduco-socket'
import { describe, expect, it } from 'vitest'
import { CLIENT_TERMINAL_HARNESSES, clientTerminalFor } from './registry.js'

/**
 * POD-2853/POD-2777: A CLIENT TERMINAL'S LABEL IS IN THE SAME 108 BYTES.
 *
 * A named instance's abduco socket root is chosen at boot against the LONGEST
 * label the instance can mint, and that is not always the session's own:
 * `podium-<token>-attach-<uuid>` is 53 bytes and carries no instance prefix, so
 * below nine characters of instance id it is the long pole. Budget the session
 * label alone and the spawn succeeds while the native view silently overflows —
 * POD-2777 measured exactly that: a live session, a blank pane, and the cause
 * only in a daemon warning.
 *
 * `packages/runtime` reserves a width for the token and cannot see the
 * manifests (harness depends on runtime, not the other way round), so the check
 * has to live here. DERIVED FROM THE REGISTRY, never a hand-written list of the
 * three tokens that exist today: a fourth harness declaring a longer one is
 * precisely the change that would quietly re-open the bug, and a list would not
 * notice it.
 */
describe('client terminal labels fit the socket-path budget', () => {
  it('has harnesses to check', () => {
    // A registry that answered "nothing declares a client terminal" would make
    // every assertion below vacuous.
    expect(CLIENT_TERMINAL_HARNESSES.length).toBeGreaterThan(0)
  })

  it.each([...CLIENT_TERMINAL_HARNESSES])('keeps %s within the reserved token width', (kind) => {
    const token = clientTerminalFor(kind)?.labelToken
    expect(token).toBeDefined()
    expect(token?.length).toBeLessThanOrEqual(CLIENT_TERMINAL_LABEL_TOKEN_MAX)
  })

  it('leaves the composed label inside sun_path with room for a directory', () => {
    // Not just "the token is short" — the whole label, against the ceiling the
    // root has to share with it. A label alone at 53 of 108 leaves 55 bytes for
    // `<root>/abduco/<user>/` and the `@<host>` suffix.
    for (const kind of CLIENT_TERMINAL_HARNESSES) {
      const label = `podium-${clientTerminalFor(kind)?.labelToken}-attach-${'0'.repeat(36)}`
      expect(label.length).toBeLessThan(ABDUCO_SUN_PATH_MAX)
      expect(label).toHaveLength(53)
    }
  })
})
