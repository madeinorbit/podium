/**
 * THE RUNTIME HALF of the 3.11 automation cutover gate (POD-735; POD-424's
 * criterion for this router).
 *
 * This file reads the RUNNING objects: the real `appRouter`, the real contract
 * schemas, and the real `AgentRelayGate`. It is the only thing that can prove the
 * derived surface EXISTS with the right verbs, and the only thing that can prove a
 * gate actually REFUSES. The source-text half it used to pair with is deleted
 * (POD-6595): a module cannot build a write route by type
 * (`modules/write-routes/write-routes.typecheck.ts`), every contract's class is
 * checked on the running objects (`packages/commands/src/classification-totality.test.ts`),
 * and the one cron parser is the contracts' own (`packages/commands/src/automations/cron.test.ts`).
 */

import { AUTOMATION_CONTRACTS, AUTOMATION_QUERY_NAMES } from '@podium/commands'
import type { SessionId } from '@podium/model'
import { asMachineId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import type { Capability } from './issue-authz'
import { AUTOMATION_COMMANDS } from './modules/automations/registry'
import { AUTOMATION_SYNC_FAMILY } from './modules/automations/sync-write'
import { AgentRelayGate } from './modules/issues/relay-gate'
import { registerSyncFamily } from './modules/sync-write/family'
import { SyncWriteRegistry } from './modules/sync-write/registry'
import { appRouter } from './router'

/** The tRPC internals the router exposes for introspection. */
function procedures(): Record<string, { _def: { type: string; inputs: unknown[] } }> {
  const record = (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures
  const out: Record<string, { _def: { type: string; inputs: unknown[] } }> = {}
  for (const [path, proc] of Object.entries(record)) {
    if (path.startsWith('automations.')) {
      out[path.slice('automations.'.length)] = proc as { _def: { type: string; inputs: unknown[] } }
    }
  }
  return out
}

describe('POD-735 automation cutover gate', () => {
  /**
   * MECHANISM PRESENCE IS NOT COVERAGE. The audit above is an ABSENCE claim and an
   * empty router satisfies it perfectly. This asserts the surface is TOTAL: every
   * declared command and every declared query is served, and nothing else is.
   */
  it('every declared command and query is served, and nothing else is', () => {
    expect(Object.keys(procedures()).sort()).toEqual(
      [...Object.keys(AUTOMATION_COMMANDS), ...AUTOMATION_QUERY_NAMES].sort(),
    )
  })

  /**
   * The VERB is read off the declaration, so a write cannot hide among the reads by
   * being served as a query — the one way a derived surface can pass a `.mutation(`
   * audit while still having a hand-shaped hole in it.
   */
  it('the wire verb matches the declaration on every declared name', () => {
    const verbs = Object.fromEntries(
      Object.entries(procedures()).map(([name, proc]) => [name, proc._def.type]),
    )
    for (const name of Object.keys(AUTOMATION_COMMANDS)) {
      expect(verbs[name], `automations.${name} is a declared command`).toBe('mutation')
    }
    for (const name of AUTOMATION_QUERY_NAMES) {
      expect(verbs[name], `automations.${name} is a declared query`).toBe('query')
    }
    // NON-VACUITY, not a census (POD-521). Both loops are satisfied by an empty
    // declaration table, so both arms are asserted populated — but the remembered
    // `4` and `2` are gone. The test above already pins the served set to the
    // declared set in BOTH directions, so the totals added no refusing condition
    // and charged an edit to every legitimate command addition.
    expect(Object.keys(AUTOMATION_COMMANDS).length).toBeGreaterThan(0)
    expect(AUTOMATION_QUERY_NAMES.length).toBeGreaterThan(0)
  })

  /**
   * DERIVED, not merely EQUIVALENT — asserted by object IDENTITY (`toBe`).
   *
   * Since POD-6418 every automation write goes through the sync write entry
   * point, and the old route is a thin adapter that does NOT parse: the entry
   * point parses, after its coarse check, with the schema of the command it
   * looked up. So the identity that makes a second declaration impossible is
   * the REGISTERED command's schema, and the route must carry no schema of its
   * own (a restated copy there would be the second declaration).
   */
  it("each write validates with its CONTRACT's own schema instance, on the entry point", () => {
    const registry = new SyncWriteRegistry()
    registerSyncFamily(registry, AUTOMATION_SYNC_FAMILY, {
      modules: () => {
        throw new Error('not called while registering')
      },
      roleOf: async () => undefined,
    })
    const served = procedures()
    for (const [name, contract] of Object.entries(AUTOMATION_CONTRACTS)) {
      const registered = registry.lookup(`automations.${name}`)
      expect(registered?.input, `automations.${name} input identity`).toBe(contract.input)
      const inputs = served[name]?._def.inputs ?? []
      expect(inputs, `automations.${name} route`).toHaveLength(1)
      expect(
        typeof (inputs[0] as { safeParse?: unknown }).safeParse,
        `automations.${name} route restates no schema`,
      ).toBe('undefined')
    }
  })

  /**
   * The payloads `apps/web/src/features/automations/*` actually send, run against
   * the real contracts that now validate them — including the ONE-OFF WAKE arm and
   * its four refusals (f3423088). A typecheck proves the call sites compile; this
   * proves the shapes they send are accepted, and that the schema still refuses
   * what it always refused.
   */
  it('accepts what the composer sends and refuses what it always refused', () => {
    const create = (payload: unknown) => AUTOMATION_CONTRACTS.create.input.safeParse(payload)
    const cron = {
      name: 'Nightly',
      agentKind: 'claude-code',
      prompt: 'sweep',
      cron: '0 3 * * *',
      repoPath: '/tmp/repo',
      sessionMode: 'fresh',
      enabled: true,
    }
    const once = {
      name: 'Wake me',
      agentKind: 'claude-code',
      prompt: 'check the deploy',
      scheduleKind: 'once',
      runAt: '2099-01-01T09:00:00.000Z',
      targetSessionId: 'ses_1',
      sessionMode: 'resume',
    }
    expect(create(cron).success).toBe(true)
    expect(create(once).success).toBe(true)
    // The counterfactuals — the schema REFUSES, so the trues above are the contract
    // accepting rather than a schema that accepts anything.
    expect(create({ ...once, runAt: undefined }).success).toBe(false)
    expect(create({ ...once, cron: '0 3 * * *' }).success).toBe(false)
    expect(create({ ...cron, runAt: '2099-01-01T09:00:00.000Z' }).success).toBe(false)
    expect(create({ ...cron, cron: 'nonsense' }).success).toBe(false)
    expect(
      AUTOMATION_CONTRACTS.update.input.safeParse({ id: 'aut_1', patch: { enabled: false } })
        .success,
    ).toBe(true)
    expect(AUTOMATION_CONTRACTS.setEnabled.input.safeParse({ id: 'aut_1' }).success).toBe(false)
  })
})

/**
 * THE OPERATOR-ONLY CLAIM, AGAINST THE REAL GATE.
 *
 * The failure this run kept paying for is a refusal test whose refusing arm was
 * unreachable, or one that would pass against an implementation that refuses
 * everything. Both are addressed here deliberately:
 *
 *  - The gate's `dispatch` port is wired to a HANDLER THAT ANSWERS ANY ROUTER,
 *    including `automations`. So if the relay allowlist were widened, the call
 *    would SUCCEED and this test would go red — the refusal below is the
 *    allowlist's doing and not a missing dispatch arm.
 *  - The POSITIVE CONTROL runs the identical path for `features.state`, which the
 *    allowlist permits. A gate that refused everything fails it.
 */
describe('POD-735 operator-only — the relay refuses automations, and can still say yes', () => {
  const SESSION = 'ses_probe' as SessionId

  /** One relayed call through the REAL gate; returns the reply frame. */
  async function relay(router: string, proc: string): Promise<{ ok: boolean; error?: string }> {
    const replies: Array<{ ok: boolean; error?: string; result?: unknown }> = []
    const gate = new AgentRelayGate({
      // Answers EVERY router — see the describe comment. This is what makes the
      // refusal below attributable to the allowlist.
      dispatch: () => Promise.resolve({ served: true }),
      capabilityForSession: () => ({}) as Capability,
      toMachine: (_machineId, msg) => {
        const frame = msg as unknown as { type: string; ok: boolean; error?: string }
        if (frame.type === 'agentRelayResult') replies.push(frame)
      },
    })
    await gate.run(asMachineId('machine-1'), {
      type: 'agentRelayRequest',
      requestId: 'req-1',
      sessionId: SESSION,
      router,
      proc,
      input: {},
    } as Extract<DaemonMessage, { type: 'agentRelayRequest' }>)
    return replies[0] ?? { ok: false, error: 'no reply' }
  }

  it('refuses every automation write over the agent transport', async () => {
    for (const proc of Object.keys(AUTOMATION_COMMANDS)) {
      const reply = await relay('automations', proc)
      expect([proc, reply.ok]).toEqual([proc, false])
      expect([proc, reply.error]).toEqual([proc, `automations.${proc} is not permitted via relay`])
    }
    // The reads are refused by the same rule — the allowlist is keyed on the
    // ROUTER, so this is not a per-proc list that could be filled in one entry at
    // a time.
    for (const proc of AUTOMATION_QUERY_NAMES) {
      expect((await relay('automations', proc)).ok).toBe(false)
    }
  })

  it('POSITIVE CONTROL: the same gate, same dispatch, serves a router the allowlist permits', async () => {
    const allowed = await relay('features', 'state')
    expect(allowed.ok, 'the gate must be able to say YES, or its NO proves nothing').toBe(true)
  })

  it('the contracts declare that refusal rather than inheriting it from the allowlist', () => {
    for (const [name, contract] of Object.entries(AUTOMATION_CONTRACTS)) {
      expect([name, contract.operatorOnly]).toEqual([name, true])
      expect([name, [...contract.exposure]]).toEqual([name, ['trpc']])
    }
  })
})
