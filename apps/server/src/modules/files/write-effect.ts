/**
 * SAVING A FILE AS AN EFFECT RECORD (ADR 12 D5 E2, POD-6395).
 *
 * A save from the app's editor is a one-shot effect on a machine: the record is
 * created, the executor writes the file through the machine's daemon, and the
 * outcome comes back as status. A save whose daemon reply timed out is no longer
 * a guess: the executor reads the file back and says whether it landed.
 *
 *  - TARGET: the session a session-addressed save names, or the machine a
 *    root-addressed one names (the host when it names none). `admit` holds the
 *    input to that target and keeps the shipped root allowlist: a root that is
 *    not a registered repository is refused at create, and again at the run,
 *    because the repo set can change in between.
 *  - OUTCOME: written → `succeeded` with the new `baseHash`; the file changed on
 *    disk since it was opened → `failed`, code `conflict`; the daemon's own
 *    error → `failed` with that text; a timeout → read back.
 *  - READ BACK (a timeout, and the recovery after a stop): the file holds the
 *    saved text → `succeeded`; it still has the snapshot the save was made
 *    against → `failed`, nothing written; anything else → `unknown`.
 *  - THE FEED never carries the text: the record publishes the path, the size
 *    and the base hash. The whole input stays on the server.
 *  - `files.write` is an adapter (`files/trpc.ts`): it creates the record through
 *    `sync.submit` as its caller, waits for it, and answers
 *    `{ ok, baseHash?, conflict?, error? }` as before.
 */

import { FILE_CONTRACTS } from '@podium/commands'
import { asMachineId, asSessionId, type MachineId, mintDeviceId } from '@podium/model'
import type { z } from 'zod'
import { privateResourceAccess } from '../../private-resources'
import type { RegistryModules } from '../../relay'
import { isAllowedRoot } from '../../root-allowlist'
import type { EffectRow } from '../../store/effects'
import type { EffectOutcome, EffectRunContext } from '../effects/registry'
import { NO_TARGET } from '../sync-write/registry'

export const FILE_WRITE_EFFECT_KIND = 'file.write'

/** A save that could not start within this is stale: the editor has moved on. */
export const FILE_WRITE_DEADLINE_MS = 60_000

/** How long `files.write` waits for its record: past the daemon's 10 s, plus a read-back. */
export const FILE_WRITE_WAIT_MS = 30_000

export type FileWriteInput = z.infer<(typeof FILE_CONTRACTS)['write']['input']>

/** What `files.write` has always answered. */
export interface FileWriteAnswer {
  ok: boolean
  baseHash?: string
  conflict?: boolean
  error?: string
}

export interface FileWriteEffectDeps {
  modules(): RegistryModules
  /** The registered repository roots (the root allowlist), read per call. */
  repoPaths(machineId: MachineId): Promise<string[]>
  /** The machine a root-addressed save without a machine names. */
  readonly hostMachineId: MachineId
}

/** The target an input addresses. */
export function fileWriteTarget(input: FileWriteInput, hostMachineId: MachineId) {
  return 'sessionId' in input
    ? ({ kind: 'session', id: input.sessionId } as const)
    : ({ kind: 'machine', id: input.machineId ?? hostMachineId } as const)
}

const conflict = (baseHash?: string): EffectOutcome => ({
  status: 'failed',
  error: { code: 'conflict', message: 'The file changed on disk since it was opened.' },
  result: { conflict: true, ...(baseHash ? { baseHash } : {}) },
})

export function registerFileWriteEffect(deps: FileWriteEffectDeps): void {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('file write effect: no effects module')
  const rpc = () => deps.modules().rpc
  const rootAllowed = async (input: FileWriteInput) =>
    !('root' in input) || isAllowedRoot(await deps.repoPaths(input.machineId ?? deps.hostMachineId), input.root)
  const resolvedInput = (input: FileWriteInput): FileWriteInput =>
    'root' in input ? { ...input, machineId: input.machineId ?? deps.hostMachineId } : input

  /** Did the save land? Reads the file back through the same daemon. */
  const readBack = async (raw: FileWriteInput): Promise<EffectOutcome> => {
    const input = resolvedInput(raw)
    const read = await rpc().readFile(
      'sessionId' in input
        ? { sessionId: input.sessionId, path: input.path }
        : {
            root: input.root,
            path: input.path,
            ...(input.machineId ? { machineId: input.machineId } : {}),
          },
    )
    if (read.ok && read.content === input.content) {
      return { status: 'succeeded', result: read.baseHash ? { baseHash: read.baseHash } : {} }
    }
    if (read.ok && input.baseHash !== undefined && read.baseHash === input.baseHash) {
      return {
        status: 'failed',
        error: { code: 'interrupted', message: 'The save did not reach the file.' },
      }
    }
    return {
      status: 'unknown',
      error: {
        code: 'lost-track',
        message: 'The machine did not confirm the save; open the file to check it.',
      },
    }
  }

  effects.executors.register<FileWriteInput>({
    kind: FILE_WRITE_EFFECT_KIND,
    input: FILE_CONTRACTS.write.input,
    // Direct sync submissions must pass the same live private-class gate as the
    // route adapter. Use on a machine never grants another human's session.
    target: async (target, principal) => {
      const modules = deps.modules()
      const access = privateResourceAccess({
        sessionOwnerUserId: async (sessionId) => (await modules.sessions.sessionOwner(sessionId))?.owner,
        machines: modules.machines,
      }, principal)
      if (target.kind === 'session') {
        return await access.ownsSession(asSessionId(target.id)) ? NO_TARGET : undefined
      }
      if (target.kind === 'machine') {
        return await access.mayReadMachineFiles(asMachineId(target.id)) ? NO_TARGET : undefined
      }
      return undefined
    },
    admit: async (input, target) => {
      const addressed = fileWriteTarget(input, deps.hostMachineId)
      if (addressed.kind !== target.kind || addressed.id !== target.id) {
        return { kind: 'invalid', details: ['target'] }
      }
      return (await rootAllowed(input)) ? undefined : { kind: 'unauthorized' }
    },
    deadlineMs: FILE_WRITE_DEADLINE_MS,
    publish: (input) => ({
      path: input.path,
      size: input.content.length,
      ...('root' in input ? { root: input.root } : {}),
      ...(input.baseHash ? { baseHash: input.baseHash } : {}),
    }),
    run: async (ctx: EffectRunContext<FileWriteInput>) => {
      const input = resolvedInput(ctx.input)
      if (!(await rootAllowed(input))) {
        return {
          status: 'failed',
          error: { code: 'refused', message: 'root is not a known repository path' },
        }
      }
      await ctx.stage('writing')
      const r = await rpc().writeFile(input)
      if (r.ok) return { status: 'succeeded', result: r.baseHash ? { baseHash: r.baseHash } : {} }
      if (r.conflict) return conflict(r.baseHash)
      if (r.error === 'timeout') {
        await ctx.stage('checking')
        return await readBack(input)
      }
      return { status: 'failed', error: { code: 'error', message: r.error ?? 'write failed' } }
    },
    recover: async (ctx) => await readBack(ctx.input),
  })
}

/** `files.write`'s answer for a settled (or still running) record. */
export function fileWriteAnswer(row: EffectRow | undefined): FileWriteAnswer {
  const result = (row?.result ?? {}) as { baseHash?: string; conflict?: boolean }
  switch (row?.status) {
    case 'succeeded':
      return { ok: true, ...(result.baseHash ? { baseHash: result.baseHash } : {}) }
    case 'failed':
      if (row.error?.code === 'conflict') {
        return {
          ok: false,
          conflict: true,
          ...(result.baseHash ? { baseHash: result.baseHash } : {}),
        }
      }
      return { ok: false, error: row.error?.message ?? 'write failed' }
    case 'pending':
    case 'running':
    case undefined:
      return { ok: false, error: 'timeout' }
    default:
      return { ok: false, error: `${row?.status}: ${row?.error?.message ?? ''}`.trim() }
  }
}

/** A fresh effect id for one save. */
export const newFileEffectId = (): string => mintDeviceId('eff_')
