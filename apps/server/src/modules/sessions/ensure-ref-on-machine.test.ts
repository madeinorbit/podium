/**
 * ensureRefOnMachine: an up-to-date target is not a transport failure (POD-1542).
 *
 * The three cases that matter together — a skip is only safe if it can still say NO:
 *  1. target already holds the tip → skip the bundle entirely, report transferred:false.
 *  2. target is genuinely missing commits → the bundle is still built and shipped.
 *  3. the target cannot be asked at all (daemon down) → NOT read as "nothing to send";
 *     the transfer is attempted and its failure is raised.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import { SessionStore } from '../../store'

const TIP = 'a'.repeat(40)
const MAIN = 'b'.repeat(40)
const REF = 'issue/279-integration'
const SOURCE = '/src/podium'
const TARGET = '/tgt/podium'

interface OpCall {
  op: string
  cwd: string
  args: Record<string, string>
  machineId?: string
}

/** revParseVerify answers keyed by `${machineId}:${ref}`; anything absent is unknown. */
function makeRig(
  known: Record<string, string>,
  overrides?: Record<string, () => unknown>,
  /** revParseVerify answers that only exist once a bundle has actually landed. */
  afterFetch: Record<string, string> = {},
) {
  const store = new SessionStore(':memory:')
  store.machines.upsertMachine({ id: 'src', name: 'src', hostname: 'src', tokenHash: 'x' })
  store.machines.upsertMachine({ id: 'tgt', name: 'tgt', hostname: 'tgt', tokenHash: 'y' })
  store.repos.addRepo(SOURCE, 'src')
  store.repos.addRepo(TARGET, 'tgt')
  const reg = new SessionRegistry(store)
  const calls: OpCall[] = []
  const rpc = {
    repoOp: (op: string, cwd: string, args: Record<string, string> = {}, machineId?: string) => {
      calls.push({ op, cwd, args, ...(machineId ? { machineId } : {}) })
      const override = overrides?.[op]
      if (override) return Promise.resolve(override())
      if (op === 'revParseVerify') {
        const sha = known[`${machineId}:${args.ref}`]
        return Promise.resolve(
          sha
            ? { ok: true, output: `${sha}\n` }
            : { ok: false, output: 'Needed a single revision' },
        )
      }
      if (op === 'bundleCreate')
        return Promise.resolve({
          ok: true,
          output: JSON.stringify({ path: '/s/b.bundle', sizeBytes: 4 }),
        })
      if (op === 'bundleFetch') {
        // What the fetch DOES: the objects become resolvable on the target.
        for (const [key, sha] of Object.entries(afterFetch)) known[key] = sha
        return Promise.resolve({ ok: true, output: '' })
      }
      return Promise.resolve({ ok: false, output: `unexpected op ${op}` })
    },
    handoffReadChunk: (_p: string, offset: number, length: number) =>
      Promise.resolve({ ok: true, data: Buffer.alloc(length).toString('base64'), offset }),
    handoffWriteChunk: (_id: string, offset: number, data: Buffer) =>
      Promise.resolve({ ok: true, sizeBytes: offset + data.length }),
  }
  ;(reg.modules.sessions as unknown as { rpc: unknown }).rpc = rpc
  return { reg, calls }
}

let stateDir: string
let priorStateDir: string | undefined

beforeEach(() => {
  priorStateDir = process.env.PODIUM_STATE_DIR
  stateDir = mkdtempSync(join(tmpdir(), 'pod-ensureref-'))
  process.env.PODIUM_STATE_DIR = stateDir
})

afterEach(() => {
  if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
  else process.env.PODIUM_STATE_DIR = priorStateDir
  rmSync(stateDir, { recursive: true, force: true })
})

const call = (reg: SessionRegistry, ref = REF) =>
  reg.modules.sessions.ensureRefOnMachine({
    sourceRepoPath: SOURCE,
    targetRepoPath: TARGET,
    targetMachineId: 'tgt',
    ref,
  })

describe('ensureRefOnMachine', () => {
  it('skips the bundle when the target already holds the tip', async () => {
    // The target fetched the branch: it has the COMMIT but no ref by that name.
    const { reg, calls } = makeRig({
      [`src:${REF}`]: TIP,
      'src:main': MAIN,
      [`tgt:${TIP}`]: TIP,
      [`tgt:${MAIN}`]: MAIN,
    })
    await expect(call(reg)).resolves.toEqual({ transferred: false, startPoint: TIP })
    expect(calls.map((c) => c.op)).not.toContain('bundleCreate')
  })

  it('still ships commits the target is missing', async () => {
    const { reg, calls } = makeRig(
      { [`src:${REF}`]: TIP, 'src:main': MAIN, [`tgt:${MAIN}`]: MAIN },
      undefined,
      // The tip only resolves on the target AFTER the bundle lands.
      { [`tgt:${TIP}`]: TIP },
    )
    await expect(call(reg)).resolves.toEqual({ transferred: true, startPoint: TIP })
    const bundled = calls.find((c) => c.op === 'bundleCreate')
    expect(bundled?.args.bases).toBe(MAIN)
    expect(calls.map((c) => c.op)).toContain('bundleFetch')
  })

  it('does not mistake an unreachable target for "nothing to send"', async () => {
    // No tgt: answers at all — every revParseVerify on the target fails.
    const { reg, calls } = makeRig({ [`src:${REF}`]: TIP, 'src:main': MAIN })
    await expect(call(reg)).rejects.toThrow(/does not resolve on the target/u)
    expect(calls.map((c) => c.op)).toContain('bundleCreate')
  })

  /**
   * A SHARED NAME RESOLVING IS NOT THE SAME COMMIT RESOLVING (POD-1572).
   *
   * Both machines have a `main`. The pair below is the whole bug: the stale target must
   * NOT be taken as ready, and the up-to-date one must still skip the bundle — a guard
   * that fires on both is just "always bundle".
   */
  it('does not start from the target’s own stale copy of a shared branch name', async () => {
    const STALE = 'c'.repeat(40)
    const { reg, calls } = makeRig(
      // src:main is the tip the operator meant; tgt:main is 455 commits behind.
      { 'src:main': TIP, 'src:origin/main': TIP, [`src:${STALE}`]: STALE, 'tgt:main': STALE },
      undefined,
      { [`tgt:${TIP}`]: TIP },
    )
    // The start point is the SOURCE's commit, not the name the target would have resolved.
    await expect(call(reg, 'main')).resolves.toEqual({ transferred: true, startPoint: TIP })
    const bundled = calls.find((c) => c.op === 'bundleCreate')
    expect(bundled).toBeDefined()
    // Bundled from the target's own tip: the gap, not the repository's whole history.
    expect(bundled?.args.bases).toBe(STALE)
  })

  it('still skips the transfer when the shared name is already the same commit', async () => {
    const { reg, calls } = makeRig({ 'src:main': TIP, 'src:origin/main': TIP, 'tgt:main': TIP })
    await expect(call(reg, 'main')).resolves.toEqual({ transferred: false, startPoint: TIP })
    expect(calls.map((c) => c.op)).not.toContain('bundleCreate')
  })

  it('fails loudly when the transfer itself breaks', async () => {
    const { reg } = makeRig(
      { [`src:${REF}`]: TIP, 'src:main': MAIN, [`tgt:${MAIN}`]: MAIN },
      { bundleFetch: () => ({ ok: false, output: 'bundle verify failed' }) },
    )
    await expect(call(reg)).rejects.toThrow(/could not fetch/u)
  })
})
