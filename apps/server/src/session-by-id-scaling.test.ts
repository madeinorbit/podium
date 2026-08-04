/**
 * AN AUTHORIZATION CHECK MUST NOT COST A PASS OVER EVERY SESSION [POD-1646].
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG, STATED AS A MECHANISM
 * ---------------------------------------------------------------------------
 *
 * `resolvePrincipal` walks the `spawnedBy` chain of the acting session, and
 * every composition root that builds a principal — the four authz modules
 * (layout, fleet, settings, read-position), the session command context, the
 * issue dispatcher, the machine-use gate — supplied `parentSessionOf` as:
 *
 *     spawnedByParentSessionId(
 *       sessions.listSessions().find((s) => s.sessionId === id)?.spawnedBy,
 *     )
 *
 * `listSessions()` is `SessionView.list()`: it visibility-checks and WIRES
 * every session on the machine (1119 on the live corpus) so that one of them
 * can be kept. Authorization runs on essentially every request, and the walk
 * calls `parentSessionOf` once per LINK — so a 3-deep agent chain paid four
 * full projections per request.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ASSERTS A COUNT AND NOT A DURATION
 * ---------------------------------------------------------------------------
 *
 * Same reasoning as feed-bootstrap-scaling.test.ts (POD-1614): a wall-clock
 * bound measures this repo's load, not the change. The defect is "does work
 * proportional to the whole table for a single-row question", and a count of
 * the per-session visibility check states exactly that at any corpus size.
 *
 * It can say NO. Before the fix, `sessionsProjected` reads CORPUS x (chain+1)
 * — 20 x 4 = 80 for the first case — and the two corpus sizes in the second
 * case differ instead of matching. Reverting `sessionSpawnedBy` back to
 * `listSessions().find(...)` in modules/sessions/command-ctx.ts turns both red.
 */

import { asSessionId, spawnedByTag } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { sessionCommandCtx } from './modules/sessions/command-ctx'
import { SessionView } from './modules/sessions/view'
import { SessionRegistry } from './relay'

/** Capability shape a session-actor command arrives with — the relay builds it
 *  from the authenticated transport, never from a payload. */
const actorCapability = (sessionId: string) =>
  ({ actorSessionId: asSessionId(sessionId), scopes: [] }) as never

/**
 * Seed `count` sessions, the last `chainDepth + 1` of them a spawn chain, and
 * return the leaf's id — the session a command would arrive as.
 */
function seedChain(reg: SessionRegistry, count: number, chainDepth: number): string {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const parent = i > 0 && i > count - 1 - chainDepth ? ids[i - 1] : undefined
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: `/p/${i}`,
      ...(parent ? { spawnedBy: spawnedByTag({ kind: 'session', id: asSessionId(parent) }) } : {}),
    } as never)
    ids.push(sessionId)
  }
  const leaf = ids[ids.length - 1]
  if (!leaf) throw new Error('seedChain: empty corpus')
  return leaf
}

/**
 * How many SESSIONS the reader-scoped projection visits while one command
 * context resolves its principal. Counted at `SessionView.wire` — the per-
 * session half of the pass, so the number is "sessions projected", not "passes".
 */
function sessionsProjectedResolvingPrincipal(reg: SessionRegistry, leaf: string): number {
  const proto = SessionView.prototype as unknown as { wire: (...a: unknown[]) => unknown }
  const original = proto.wire
  let wired = 0
  proto.wire = function patched(...args: unknown[]) {
    wired++
    return original.apply(this, args)
  }
  try {
    sessionCommandCtx(reg.modules, actorCapability(leaf))
  } finally {
    proto.wire = original
  }
  return wired
}

describe('POD-1646 — resolving a principal does not project every session', () => {
  it('projects nothing at all: the chain walk is a by-id read', () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    const CORPUS = 20
    const leaf = seedChain(reg, CORPUS, 3)

    // CONTROL: the corpus really exists and the chain really links, so a count
    // of 0 below cannot pass against an empty or unlinked world — the one way
    // this assertion could be satisfied for the wrong reason.
    expect(reg.modules.sessions.listSessions().length).toBe(CORPUS)
    expect(reg.modules.sessions.sessionSpawnedBy(asSessionId(leaf))).toBeDefined()

    // Before the fix: CORPUS x (chain links + 1) = 80.
    expect(sessionsProjectedResolvingPrincipal(reg, leaf)).toBe(0)
  })

  it('costs the same whether the machine holds 8 sessions or 64', () => {
    const small = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    const smallLeaf = seedChain(small, 8, 3)
    const large = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    const largeLeaf = seedChain(large, 64, 3)

    // The property, stated directly: growing the corpus 8x must not grow the
    // per-request work at all. Before the fix these read 32 and 256.
    expect(sessionsProjectedResolvingPrincipal(large, largeLeaf)).toBe(
      sessionsProjectedResolvingPrincipal(small, smallLeaf),
    )
  })
})
