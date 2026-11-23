/**
 * Grant sizes (POD-7311 acceptance 4): a client grant for 200 and for 1,000
 * sessions, measured on the encoding the package uses, with the plain JSON
 * encoding beside it for comparison. Session ids are random UUIDs, as the
 * server mints them; the screen also names 20 machines with three roots each.
 *
 * The budget is 64 KiB, a quarter of the smallest message limit a WebSocket
 * stack in our path sets by default (256 KiB), and well inside one TCP send
 * window. The test prints the numbers it measured.
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  type ClientGrantClaims,
  type LiveGrantAction,
  LiveGrantKeyRing,
  mintLiveGrantKey,
  signClientGrant,
  verifyLiveGrant,
} from './index'

const ring = new LiveGrantKeyRing([mintLiveGrantKey()])
const BUDGET_BYTES = 64 * 1024

function claimsFor(sessionCount: number): Omit<ClientGrantClaims, 'kind'> {
  const sessions: Record<string, LiveGrantAction[]> = {}
  for (let i = 0; i < sessionCount; i++) {
    // Most are the member's own and runnable; some sit on a machine they may not use.
    sessions[randomUUID()] = i % 10 === 0 ? ['view'] : ['view', 'use']
  }
  const machines: Record<string, LiveGrantAction[]> = {}
  const roots: Record<string, string[]> = {}
  for (let i = 0; i < 20; i++) {
    const machine = randomUUID()
    machines[machine] = ['view', 'use']
    roots[machine] = [`/home/dev/src/project-${i}`, `/home/dev/src/tools-${i}`, `/srv/repo-${i}`]
  }
  return {
    workspace: `ws_${randomUUID()}`,
    member: randomUUID(),
    role: 'member',
    sessions,
    machines,
    roots,
    logins: Object.keys(machines).slice(0, 5),
    connectionKey: 'x'.repeat(43),
    epoch: 12,
  }
}

/** The same claims as plain base64url JSON, the encoding we did not choose. */
function plainJsonBytes(claims: Omit<ClientGrantClaims, 'kind'>): number {
  return Buffer.from(JSON.stringify(claims)).toString('base64url').length + 100
}

describe('client grant size', () => {
  for (const count of [200, 1000]) {
    it(`stays within ${BUDGET_BYTES} bytes at ${count} sessions`, () => {
      const claims = claimsFor(count)
      const started = performance.now()
      const signed = signClientGrant(ring, claims)
      const signMs = performance.now() - started
      const verifyStarted = performance.now()
      const result = verifyLiveGrant(signed.token, {
        keys: ring.publicOnly(),
        workspace: claims.workspace,
      })
      const verifyMs = performance.now() - verifyStarted
      expect(result.ok).toBe(true)
      const bytes = Buffer.byteLength(signed.token)
      console.info(
        `[live-grant size] ${count} sessions + 20 machines: ${bytes} bytes ` +
          `(plain JSON would be ${plainJsonBytes(claims)}); ` +
          `sign ${signMs.toFixed(1)} ms, verify ${verifyMs.toFixed(1)} ms`,
      )
      expect(bytes).toBeLessThan(BUDGET_BYTES)
    })
  }
})
