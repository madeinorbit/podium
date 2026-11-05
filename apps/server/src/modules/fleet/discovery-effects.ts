/**
 * SCANS AND CLONES AS EFFECT RECORDS (ADR 12 D5 E2, POD-6396).
 *
 * Three one-off actions on a machine, each an effect record whose TARGET is
 * the machine and whose INPUT is the rest of the old route's input:
 *
 *  - `folder.scan`: walk one folder on the machine for repositories
 *    (`discovery.scanFolder`). Read only.
 *  - `machine.scan`: the tiered per-machine discovery (`discovery.scanMachine`,
 *    `repo-discovery.ts`), which auto-registers origin matches. The newest
 *    succeeded record IS the machine's last scan (`discovery.lastMachineScan`);
 *    the in-memory `running` / `lastResults` maps are gone. A scan asked for
 *    while the same scan already runs there joins that record.
 *  - `repo.clone`: `gh repo clone` on the machine, then the checkout is
 *    registered (`repos.cloneGithub`).
 *
 * PERMISSION: the caller needs machine `use` (the fleet contracts' verb),
 * checked live at create, cancel and dismiss. The server's own connect scan
 * runs as a system principal. The machine must be able to host repositories,
 * checked again when the record runs.
 *
 * RESULT: bounded. A scan keeps at most {@link MAX_KEPT} repositories and
 * diagnostics on the record and says how many it left out in one more
 * diagnostic, so the record (which every device of its creator receives) stays
 * small however big the disk.
 *
 * RECOVERY after a server stop:
 *  - a scan writes nothing that matters if repeated, so it is `failed`
 *    (`interrupted`): scan again;
 *  - a clone checks the destination: a checkout there whose origin is the
 *    repository is registered and the record succeeds (a timed-out clone used
 *    to leave an unregistered checkout); anything else is `unknown`. A clone
 *    that runs again for an existing checkout of that repository does the same
 *    instead of failing on the occupied folder.
 *
 * THE OLD ROUTES are adapters (`handlers.ts`): they create the record through
 * `sync.submit` as their caller, wait for it, and answer their old shapes.
 */

import {
  discoveryScanFolderInput,
  discoveryScanMachineInput,
  FLEET_CONTRACTS,
} from '@podium/commands'
import {
  asMachineId,
  type EffectTarget,
  type GitDiscoveryDiagnosticWire,
  HOST_REPOS,
  type MachineId,
  machinePathsEqual,
  mintDeviceId,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import { checkMachineUse, ownershipSnapshotFromMachines } from '../../machine-access'
import type { RegistryModules } from '../../relay'
import type { MachineDiscoveryResult, MachineRepoDiscovery } from '../../repo-discovery'
import { canonicalizeRepoOrigin } from '../../repo-id'
import { normalizeRepoPath } from '../../store'
import type { EffectRow } from '../../store/effects'
import type { Context } from '../../trpc'
import { familyState } from '../derived-family'
import type { EffectExecutor, EffectOutcome } from '../effects/registry'
import type { ScanReposResult } from '../machines/rpc'
import { NO_TARGET } from '../sync-write/registry'
import { refusalAsTrpcError, submitFromRoute } from '../sync-write/route-adapter'

export const FOLDER_SCAN_KIND = 'folder.scan'
export const MACHINE_SCAN_KIND = 'machine.scan'
export const REPO_CLONE_KIND = 'repo.clone'

/** A scan or clone that could not start within this is stale. */
export const MACHINE_EFFECT_DEADLINE_MS = 60_000

/** How long the old routes wait: one folder walk; four tiers; a clone plus its check. */
export const FOLDER_SCAN_WAIT_MS = 30_000
export const MACHINE_SCAN_WAIT_MS = 120_000
export const REPO_CLONE_WAIT_MS = 180_000

/** The most repositories (and, apart, diagnostics) a scan keeps on its record. */
export const MAX_KEPT = 500

/** The most worktrees one repository of a folder scan keeps. */
const MAX_WORKTREES = 50

export const FolderScanInput = discoveryScanFolderInput.omit({ machineId: true }).strict()
export type FolderScanInput = z.infer<typeof FolderScanInput>

export const MachineScanInput = discoveryScanMachineInput
  .omit({ machineId: true, deep: true })
  .extend({ deep: z.boolean() })
  .strict()
export type MachineScanInput = z.infer<typeof MachineScanInput>

export const RepoCloneInput = FLEET_CONTRACTS['repos.cloneGithub'].input
  .omit({ machineId: true })
  .strict()
export type RepoCloneInput = z.infer<typeof RepoCloneInput>

export interface RepoCloneResult {
  readonly path: string
  readonly output?: string
}

export interface DiscoveryEffectDeps {
  modules(): RegistryModules
  discovery: MachineRepoDiscovery
  /** Register a clone (`RepoRegistry.addKnownOrigin`: the row, then the repo list's push). */
  addKnownOrigin(path: string, machineId: MachineId, originUrl: string): Promise<void>
}

/** The diagnostic that says what a bounded list left out. */
const leftOut = (count: number, what: string): GitDiscoveryDiagnosticWire => ({
  severity: 'warning',
  path: '',
  message: `${count} more ${what} not kept; scan a narrower folder to see them`,
})

function boundDiagnostics(
  diagnostics: readonly GitDiscoveryDiagnosticWire[],
  dropped: readonly GitDiscoveryDiagnosticWire[],
): GitDiscoveryDiagnosticWire[] {
  const kept = diagnostics.slice(0, MAX_KEPT)
  const out = [...kept, ...dropped]
  if (diagnostics.length > kept.length)
    out.push(leftOut(diagnostics.length - kept.length, 'diagnostics'))
  return out
}

/** A folder scan's result, bounded for its record. */
export function boundFolderScan(result: ScanReposResult): ScanReposResult {
  const repositories = result.repositories
    .slice(0, MAX_KEPT)
    .map((repo) =>
      repo.worktrees.length > MAX_WORKTREES
        ? { ...repo, worktrees: repo.worktrees.slice(0, MAX_WORKTREES) }
        : repo,
    )
  const dropped =
    result.repositories.length > MAX_KEPT
      ? [leftOut(result.repositories.length - MAX_KEPT, 'repositories')]
      : []
  return { repositories, diagnostics: boundDiagnostics(result.diagnostics, dropped) }
}

/** A machine scan's result, bounded for its record. */
export function boundMachineScan(result: MachineDiscoveryResult): MachineDiscoveryResult {
  const dropped =
    result.repos.length > MAX_KEPT ? [leftOut(result.repos.length - MAX_KEPT, 'repositories')] : []
  return {
    ...result,
    repos: result.repos.slice(0, MAX_KEPT),
    diagnostics: boundDiagnostics(result.diagnostics, dropped),
  }
}

const githubOrigin = (repository: string) => `https://github.com/${repository}.git`

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const INTERRUPTED_SCAN: EffectOutcome = {
  status: 'failed',
  error: { code: 'interrupted', message: 'The server stopped during the scan; scan again.' },
}

export function registerDiscoveryEffects(deps: DiscoveryEffectDeps): void {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('discovery effects: no effects module')
  const machines = () => deps.modules().machines
  const rpc = () => deps.modules().rpc

  /** Machine `use`, live. The server's own scans are a system principal. */
  const target = async (t: EffectTarget, principal: CommandPrincipal) => {
    if (t.kind !== 'machine') return undefined
    if (principal.kind === 'system') return NO_TARGET
    const ownership = await ownershipSnapshotFromMachines(machines())
    return checkMachineUse(principal, asMachineId(t.id), ownership) === undefined
      ? NO_TARGET
      : undefined
  }

  /** The machine can host repositories, asked when the record runs. */
  const hostRefusal = async (machineId: MachineId, action: string) => {
    try {
      await machines().requireCapability(machineId, HOST_REPOS, action)
      return undefined
    } catch (error) {
      return {
        status: 'failed',
        error: { code: 'refused', message: errorText(error) },
      } as const satisfies EffectOutcome
    }
  }

  const machineOf = (record: EffectRow) => asMachineId(record.target.id)

  effects.executors.register<FolderScanInput>({
    kind: FOLDER_SCAN_KIND,
    input: FolderScanInput,
    target,
    deadlineMs: MACHINE_EFFECT_DEADLINE_MS,
    run: async (ctx) => {
      const machineId = machineOf(ctx.record)
      const refused = await hostRefusal(machineId, 'scan for repositories')
      if (refused) return refused
      await ctx.stage('scanning')
      const result = await rpc().scanRepos(
        [ctx.input.path],
        { includeHome: false, maxDepth: ctx.input.maxDepth ?? 6 },
        machineId,
      )
      return { status: 'succeeded', result: boundFolderScan(result) }
    },
    recover: async () => INTERRUPTED_SCAN,
  })

  effects.executors.register<MachineScanInput>({
    kind: MACHINE_SCAN_KIND,
    input: MachineScanInput,
    target,
    deadlineMs: MACHINE_EFFECT_DEADLINE_MS,
    run: async (ctx) => {
      const machineId = machineOf(ctx.record)
      const refused = await hostRefusal(machineId, 'scan for repositories')
      if (refused) return refused
      await ctx.stage('scanning')
      const result = await deps.discovery.scan(machineId, {
        deep: ctx.input.deep,
        ...(ctx.input.atPath === undefined ? {} : { atPath: ctx.input.atPath }),
      })
      return { status: 'succeeded', result: boundMachineScan(result) }
    },
    recover: async () => INTERRUPTED_SCAN,
  })

  /**
   * Is there a checkout of this repository at the destination? Asked of the
   * machine; registers it when there is. `false` when it cannot tell.
   */
  const registerExistingClone = async (machineId: MachineId, input: RepoCloneInput) => {
    const destination = normalizeRepoPath(input.destination)
    const found = await rpc().scanRepos(
      [destination],
      { includeHome: false, maxDepth: 0 },
      machineId,
    )
    const origin = canonicalizeRepoOrigin(githubOrigin(input.repository))
    const clone = found.repositories.find(
      (repo) =>
        repo.kind === 'repository' &&
        machinePathsEqual(normalizeRepoPath(repo.path), destination) &&
        canonicalizeRepoOrigin(repo.originUrl ?? null) === origin,
    )
    if (clone === undefined) return false
    await deps.addKnownOrigin(destination, machineId, githubOrigin(input.repository))
    return true
  }

  const LOST_CLONE = (destination: string): EffectOutcome => ({
    status: 'unknown',
    error: {
      code: 'lost-track',
      message: `The machine did not confirm the clone; check ${destination} before cloning again.`,
    },
  })

  effects.executors.register<RepoCloneInput>({
    kind: REPO_CLONE_KIND,
    input: RepoCloneInput,
    target,
    deadlineMs: MACHINE_EFFECT_DEADLINE_MS,
    run: async (ctx) => {
      const machineId = machineOf(ctx.record)
      const refused = await hostRefusal(machineId, 'clone repositories')
      if (refused) return refused
      // Keyed by the destination: a checkout of this repository already there
      // (an earlier run, or a clone whose answer was lost) is registered, not
      // cloned over.
      if (await registerExistingClone(machineId, ctx.input)) {
        return {
          status: 'succeeded',
          result: { path: normalizeRepoPath(ctx.input.destination), output: 'already cloned' },
        }
      }
      await ctx.stage('cloning')
      const r = await rpc().githubCli('clone', machineId, {
        repository: ctx.input.repository,
        destination: ctx.input.destination,
      })
      if (r.path) {
        await ctx.stage('registering')
        await deps.addKnownOrigin(r.path, machineId, githubOrigin(ctx.input.repository))
        return { status: 'succeeded', result: { path: r.path } satisfies RepoCloneResult }
      }
      if (r.error === GITHUB_CLI_TIMEOUT) {
        await ctx.stage('checking')
        return (await registerExistingClone(machineId, ctx.input))
          ? { status: 'succeeded', result: { path: normalizeRepoPath(ctx.input.destination) } }
          : LOST_CLONE(ctx.input.destination)
      }
      const message =
        r.error ??
        (r.status.state === 'missing'
          ? 'GitHub CLI is not installed on this machine'
          : r.status.state === 'logged-out'
            ? 'GitHub CLI is not signed in on this machine'
            : 'GitHub clone failed')
      return { status: 'failed', error: { code: 'clone', message } }
    },
    recover: async (ctx) =>
      (await registerExistingClone(machineOf(ctx.record), ctx.input))
        ? { status: 'succeeded', result: { path: normalizeRepoPath(ctx.input.destination) } }
        : LOST_CLONE(ctx.input.destination),
  })
}

/** What `rpc.githubCli` answers when the daemon did not reply in time. */
export const GITHUB_CLI_TIMEOUT = 'GitHub CLI request timed out'

/** A fresh effect id for one scan or clone. */
export const newMachineEffectId = (): string => mintDeviceId('eff_')

/**
 * The server's own machine scan (the janitor's connect scan), as an effect
 * record with no caller behind it. Joins the same scan when one already runs
 * there. Answers once the record has settled.
 */
export async function connectScanThroughEffect(
  modules: RegistryModules,
  machineId: MachineId,
): Promise<void> {
  const effects = modules.effects
  if (effects === undefined) throw new Error('connect scan: no effects module')
  const target = { kind: 'machine', id: machineId } as const
  const input: MachineScanInput = { deep: false }
  const running = await effects.newestOnTarget(MACHINE_SCAN_KIND, target, 'active')
  const id =
    running !== undefined && sameScan(running, input)
      ? running.id
      : (
          await effects.createAsSystem({
            id: newMachineEffectId(),
            kind: MACHINE_SCAN_KIND,
            target,
            input,
            job: 'repo-discovery.connect-scan',
          })
        ).id
  const settled = await effects.awaitSettled(id, MACHINE_SCAN_WAIT_MS)
  if (settled?.status === 'failed' || settled?.status === 'unknown') {
    throw new Error(`connect scan of ${machineId}: ${settled.error?.message ?? settled.status}`)
  }
}

/** Whether a running record is the same scan as this input (so a new one joins it). */
export function sameScan(row: EffectRow, input: MachineScanInput): boolean {
  const parsed = MachineScanInput.safeParse(row.input)
  return (
    parsed.success &&
    parsed.data.deep === input.deep &&
    (parsed.data.atPath ?? '') === (input.atPath ?? '')
  )
}

/**
 * An old route's record: created through `sync.submit` as its caller (or the
 * same scan already running there, for `machine.scan`), then waited for.
 * Throws the refusal the route always threw; answers the settled record.
 */
export async function runMachineEffect(
  ctx: Context,
  call: {
    readonly command: string
    readonly kind: string
    readonly machineId: MachineId
    readonly input: unknown
    readonly waitMs: number
    /** A record of this kind already running on the machine that this call may join. */
    readonly joins?: (row: EffectRow) => boolean
  },
): Promise<EffectRow> {
  const effects = familyState(ctx).modules.effects
  if (effects === undefined) throw new Error(`${call.command}: the effect path is not wired`)
  const target = { kind: 'machine', id: call.machineId } as const
  const running =
    call.joins === undefined ? undefined : await effects.newestOnTarget(call.kind, target, 'active')
  let id = running !== undefined && call.joins?.(running) === true ? running.id : undefined
  if (id === undefined) {
    id = newMachineEffectId()
    const { reply, cause } = await submitFromRoute(ctx, {
      command: 'effects.create',
      input: { id, kind: call.kind, target, input: call.input },
    })
    if (reply.outcome !== 'applied') {
      if (cause !== undefined) throw cause
      throw refusalAsTrpcError(call.command, reply.refusal)
    }
  }
  const row = await effects.awaitSettled(id, call.waitMs)
  if (row === undefined) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `${call.command}: effect ${id} is gone`,
    })
  }
  switch (row.status) {
    case 'succeeded':
      return row
    case 'pending':
    case 'running':
      throw new TRPCError({
        code: 'TIMEOUT',
        message: `${call.command} is still running as effect ${id}; its status shows on your devices`,
      })
    case 'failed':
      throw new TRPCError({
        // The machine's own refusals (cannot host repositories, no GitHub CLI) are
        // the precondition answers the routes always gave.
        code: 'PRECONDITION_FAILED',
        message: row.error?.message ?? `${call.command} failed`,
      })
    default:
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `${call.command} ${row.status}: ${row.error?.message ?? ''}`.trim(),
      })
  }
}
