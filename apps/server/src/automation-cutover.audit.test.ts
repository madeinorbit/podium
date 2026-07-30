/**
 * THE RUNTIME HALF of the 3.11 automation cutover gate (POD-735; POD-424's
 * criterion for this router).
 *
 * `scripts/audit-automation-commands.ts` is the other half, and the two are
 * instruments of DIFFERENT KINDS rather than two of the same kind agreeing:
 *
 *  - THE SCRIPT reads source TEXT and resolves no modules. It runs in a fresh
 *    checkout before anything is built, and it catches the textual regressions a
 *    runtime check cannot see — a `.mutation(` written back into the router
 *    literal, `automationInput`/`automationPatch` regrowing, a second cron parser
 *    appearing in `apps/server`, a contract added without its `visibility` line.
 *  - THIS FILE reads the RUNNING objects: the real `appRouter`, the real contract
 *    schemas, and the real `AgentRelayGate`. It is the only thing that can prove
 *    the derived surface EXISTS with the right verbs, and the only thing that can
 *    prove a gate actually REFUSES.
 *
 * The script is RUN as a subprocess, not imported: importing it would make
 * `apps/server` (L4) import UP into `scripts` (L5), which `check-boundaries`
 * refuses. Spawning keeps the layer order AND puts the gate in `bun run test`
 * rather than in a command someone has to remember.
 */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUTOMATION_CONTRACTS, AUTOMATION_QUERY_NAMES } from '@podium/commands'
import type { SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { Capability } from './issue-authz'
import { AUTOMATION_COMMANDS } from './modules/automations/registry'
import { AgentRelayGate } from './modules/issues/relay-gate'
import { appRouter } from './router'

/** The repo root, from this file's location — `process.cwd()` is the vitest
 *  invocation directory and is not the same thing when a lane runs from a package. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

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
  it('the source audit is clean — no hand-written mutation, no resurrected schema, one cron parser', () => {
    // `--probe` first, inside the script: it exits 2 when a check cannot find its
    // planted fixture, so a green run here cannot mean "the scan broke". The JSON
    // arm is parsed rather than the exit code alone, so a failure NAMES the finding.
    // `node:child_process` and not `Bun.spawnSync`: the Bun global is not in this
    // package's ambient types, so it would typecheck RED while the vitest lane
    // stayed green.
    const audit = (...args: string[]) =>
      spawnSync('bun', ['scripts/audit-automation-commands.ts', ...args], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
    const probe = audit('--probe')
    expect(probe.status, probe.stderr).toBe(0)
    expect(JSON.parse(audit('--json').stdout)).toEqual({ ok: true, findings: [] })
  })

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
  it('the wire verb matches the declaration: four mutations, two queries', () => {
    const verbs = Object.fromEntries(
      Object.entries(procedures()).map(([name, proc]) => [name, proc._def.type]),
    )
    for (const name of Object.keys(AUTOMATION_COMMANDS)) {
      expect(verbs[name], `automations.${name} is a declared command`).toBe('mutation')
    }
    for (const name of AUTOMATION_QUERY_NAMES) {
      expect(verbs[name], `automations.${name} is a declared query`).toBe('query')
    }
    expect(Object.values(verbs).filter((v) => v === 'mutation')).toHaveLength(4)
    expect(Object.values(verbs).filter((v) => v === 'query')).toHaveLength(2)
  })

  /**
   * DERIVED, not merely EQUIVALENT — asserted by object IDENTITY (`toBe`).
   *
   * A router that restated each schema beside the contract would satisfy every
   * check above and would pass a deep-equality assertion too, right up until
   * someone edited one copy. `toBe` can only pass if the procedure validates with
   * the CONTRACT'S OWN INSTANCE, which is what makes a second declaration
   * impossible rather than merely discouraged. Asserted PER ARM (POD-305), not on
   * arm 0, because a restatement of one contract is invisible in an any-of check.
   */
  it("each mutation validates with its CONTRACT's own schema instance, not a copy", () => {
    const served = procedures()
    for (const [name, contract] of Object.entries(AUTOMATION_CONTRACTS)) {
      expect(served[name]?._def.inputs, `automations.${name} input schema`).toEqual([
        contract.input,
      ])
      expect(served[name]?._def.inputs[0], `automations.${name} input identity`).toBe(
        contract.input,
      )
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
    await gate.run('machine-1', {
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
