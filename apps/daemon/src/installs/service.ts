import {
  defaultHarnessesDir,
  type InstallProgress,
  readManagedInstalls,
  removeManagedInstall,
  requestManagedInstall,
} from '@podium/harness/inventory'
import { createLogger } from '@podium/logger'
import type { BuiltinHarnessKind, Inventory } from '@podium/model'
import type { HarnessActionResult, HarnessInstallAction } from '@podium/protocol'
import { HomeHarness } from '@podium/protocol'
import type { DaemonHarnessRuntime } from '../harness-runtime'
import { listHomeEditRecords, removeHomeEditRecords } from '../home-edit-service'
import type { PodiumHomes } from '../homes/podium-home'
import type { HomeRegistry } from '../homes/registry'
import { inspectPodiumHome, removePodiumHome } from './home'
import type { HarnessUpdater } from './updater'

const log = createLogger('daemon:install-actions')

export interface HarnessInstallsOptions {
  runtime: Pick<DaemonHarnessRuntime, 'refresh'>
  updater: Pick<HarnessUpdater, 'checkNow' | 'goBack' | 'setPaused'>
  podiumHomes?: Pick<PodiumHomes, 'takeMySettings' | 'reconcile'>
  homes?: Pick<HomeRegistry, 'get' | 'remove'>
  harnessesDir?: string
  report(): void | Promise<void>
  /**
   * A light report for install progress: the inventory as last observed with
   * the install overlay, no new probe wave. Default {@link report}.
   */
  reportProgress?(): void | Promise<void>
  /** Test seam; production always uses the shared section 4.7 admission. */
  install?: typeof requestManagedInstall
}

/** At most one progress report per this many milliseconds; a phase change goes at once. */
export const PROGRESS_REPORT_INTERVAL_MS = 500

interface RunningInstall {
  readonly abort: AbortController
  progress: InstallProgress
  /** The install action's answer, for a cancel to wait on. */
  done?: Promise<HarnessActionResult>
}

/** Machine-local actions. The server relays them and makes no release decision. */
export class HarnessInstalls {
  private readonly installing = new Map<BuiltinHarnessKind, RunningInstall>()
  private progressTimer: ReturnType<typeof setTimeout> | undefined
  private lastProgressReport = Number.NEGATIVE_INFINITY
  constructor(private readonly options: HarnessInstallsOptions) {}

  inventory(inventory: Inventory): Inventory {
    if (!this.installing.size) return inventory
    return {
      ...inventory,
      agents: inventory.agents.map((agent) => {
        const running = this.installing.get(agent.kind)
        if (!running) return agent
        return {
          ...agent,
          install: {
            ...agent.install,
            managed: {
              paused: false,
              ...agent.install?.managed,
              installing: {
                ...(agent.install?.managed?.latest
                  ? { version: agent.install.managed.latest }
                  : {}),
                progress: { ...running.progress },
              },
            },
          },
        }
      }),
    }
  }

  async run(
    action: HarnessInstallAction,
    harness: BuiltinHarnessKind,
    confirmedConversations?: string[],
  ): Promise<HarnessActionResult> {
    const harnessesDir = this.options.harnessesDir ?? defaultHarnessesDir()
    try {
      switch (action) {
        case 'home-info':
        case 'remove-home': {
          const home = HomeHarness.safeParse(harness)
          if (!home.success || !this.options.homes)
            return { ok: false, error: 'This harness has no separate Podium home.' }
          if (action === 'home-info')
            return { ok: true, ...(await inspectPodiumHome(this.options.homes, home.data)) }
          await removePodiumHome(
            this.options.homes,
            home.data,
            harnessesDir,
            confirmedConversations,
          )
          return { ok: true, outcome: 'home-removed', homeExists: false }
        }
        case 'install': {
          if (this.installing.has(harness))
            return { ok: false, error: 'This harness is already being installed.' }
          const running: RunningInstall = {
            abort: new AbortController(),
            progress: { phase: 'download' },
          }
          this.installing.set(harness, running)
          running.done = this.install(harness, harnessesDir, running)
          return await running.done
        }
        case 'cancel-install': {
          const running = this.installing.get(harness)
          if (!running?.done)
            return {
              ok: false,
              outcome: 'not-installing',
              error: 'No install of this harness is running.',
            }
          running.abort.abort()
          const result = await running.done
          if (result.outcome === 'cancelled') return { ok: true, outcome: 'cancelled' }
          return {
            ok: false,
            ...(result.outcome ? { outcome: result.outcome } : {}),
            error: result.ok
              ? 'The install finished before it could be cancelled.'
              : (result.error ?? 'The install ended before it could be cancelled.'),
          }
        }
        case 'check': {
          const [result] = await this.options.updater.checkNow(harness)
          if (!result) return { ok: false, error: 'The machine returned no check result.' }
          return result.outcome === 'installed' ||
            result.outcome === 'no-update' ||
            result.outcome === 'vendor-updated'
            ? {
                ok: true,
                outcome: result.outcome,
                ...('version' in result ? { version: result.version } : {}),
              }
            : failure(result)
        }
        case 'back': {
          const result = await this.options.updater.goBack(harness)
          return result.outcome === 'went-back'
            ? { ok: true, outcome: result.outcome, version: result.version }
            : failure(result)
        }
        case 'pause':
        case 'resume': {
          const result = this.options.updater.setPaused(harness, action === 'pause')
          return result.outcome === 'set'
            ? { ok: true, outcome: action === 'pause' ? 'paused' : 'resumed' }
            : failure(result)
        }
        case 'take-settings': {
          if (!readManagedInstalls(harnessesDir).harnesses.has(harness))
            return { ok: false, error: 'Install this harness for Podium before taking settings.' }
          const home = HomeHarness.safeParse(harness)
          if (!home.success || !this.options.podiumHomes)
            return {
              ok: false,
              error: 'This harness cannot keep a separate Podium home on this machine.',
            }
          const result = await this.options.podiumHomes.takeMySettings(home.data)
          return 'error' in result
            ? { ok: false, error: result.error }
            : { ok: true, outcome: 'settings-taken' }
        }
        case 'changes':
          return { ok: true, changes: listHomeEditRecords(harness, harnessesDir) }
        case 'remove-changes': {
          const undone = await removeHomeEditRecords(harness, harnessesDir)
          return {
            ok: !undone.some((item) => item.status === 'failed'),
            changes: undone.map((item) => ({
              ...item.record,
              status: item.status,
              ...('reason' in item ? { reason: item.reason } : {}),
            })),
          }
        }
        case 'remove': {
          const result = removeManagedInstall(harness, harnessesDir)
          return result.outcome === 'busy' ? failure(result) : { ok: true, ...result }
        }
        default: {
          const unhandled: never = action
          throw new Error(`Unknown harness action: ${unhandled}`)
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      // A cancel's install reports its own end.
      if (action !== 'changes' && action !== 'home-info' && action !== 'cancel-install')
        await this.report(harness)
    }
  }

  private async install(
    harness: BuiltinHarnessKind,
    harnessesDir: string,
    running: RunningInstall,
  ): Promise<HarnessActionResult> {
    const { signal } = running.abort
    try {
      // A fresh wave also notices a personal copy installed since the last report.
      const snapshot = await this.options.runtime.refresh()
      void this.report(harness)
      if (signal.aborted) return CANCELLED
      const own = snapshot.executables.has(harness)
        ? true
        : snapshot.inventory.agents.find((agent) => agent.kind === harness)?.installed === null
          ? null
          : false
      const result = await (this.options.install ?? requestManagedInstall)(harness, own, {
        harnessesDir,
        commandEnv: snapshot.commandEnvironment.env,
        requestedBy: 'person',
        signal,
        onProgress: (progress) => this.progress(harness, progress),
      })
      if (result.outcome === 'cancelled') return CANCELLED
      if (result.outcome !== 'installed') return failure(result)
      // Published: too late to cancel. Making the Podium home ready is the last of setup.
      this.progress(harness, { phase: 'setup' })
      await this.options.podiumHomes?.reconcile((kind) => kind === harness)
      return { ok: true, outcome: result.outcome, version: result.version }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.installing.delete(harness)
      if (!this.installing.size) {
        clearTimeout(this.progressTimer)
        this.progressTimer = undefined
      }
    }
  }

  /** Record an install's progress; report it at once on a phase change, else throttled. */
  private progress(harness: BuiltinHarnessKind, progress: InstallProgress): void {
    const running = this.installing.get(harness)
    if (!running) return
    const phaseChanged = running.progress.phase !== progress.phase
    running.progress = { ...progress }
    const wait = this.lastProgressReport + PROGRESS_REPORT_INTERVAL_MS - Date.now()
    if (phaseChanged || wait <= 0) {
      this.flushProgress()
      return
    }
    this.progressTimer ??= setTimeout(() => this.flushProgress(), wait)
  }

  private flushProgress(): void {
    clearTimeout(this.progressTimer)
    this.progressTimer = undefined
    if (!this.installing.size) return
    this.lastProgressReport = Date.now()
    void (async () => {
      try {
        await (this.options.reportProgress ?? this.options.report)()
      } catch (error) {
        log.warn('install progress report failed', { error })
      }
    })()
  }

  private async report(harness: BuiltinHarnessKind): Promise<void> {
    try {
      await this.options.report()
    } catch (error) {
      log.warn('inventory after a harness action failed', { harness, error })
    }
  }
}

const CANCELLED: HarnessActionResult = {
  ok: false,
  outcome: 'cancelled',
  error: 'The install was cancelled.',
}

function failure(result: {
  outcome: string
  error?: string
  reason?: string
}): HarnessActionResult {
  return {
    ok: false,
    outcome: result.outcome,
    error:
      result.error ??
      result.reason ??
      {
        busy: 'Another harness install is in progress. Try again when it finishes.',
        'not-managed': 'Podium does not manage this harness on this machine.',
        'nothing-to-go-back-to': 'There is no previous release to go back to.',
      }[result.outcome] ??
      result.outcome,
  }
}
