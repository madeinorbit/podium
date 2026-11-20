import {
  defaultHarnessesDir,
  removeManagedInstall,
  requestManagedInstall,
} from '@podium/harness/inventory'
import type { BuiltinHarnessKind, Inventory } from '@podium/model'
import type { HarnessActionResult, HarnessInstallAction } from '@podium/protocol'
import { HomeHarness } from '@podium/protocol'
import type { DaemonHarnessRuntime } from '../harness-runtime'
import { listHomeEditRecords, removeHomeEditRecords } from '../home-edit-service'
import type { PodiumHomes } from '../homes/podium-home'
import type { HomeRegistry } from '../homes/registry'
import { inspectPodiumHome, removePodiumHome } from './home'
import type { HarnessUpdater } from './updater'

export interface HarnessInstallsOptions {
  runtime: Pick<DaemonHarnessRuntime, 'refresh'>
  updater: Pick<HarnessUpdater, 'checkNow' | 'goBack' | 'setPaused'>
  podiumHomes?: Pick<PodiumHomes, 'takeMySettings' | 'reconcile'>
  homes?: Pick<HomeRegistry, 'get' | 'remove'>
  harnessesDir?: string
  report(): void
  /** Test seam; production always uses the shared section 4.7 admission. */
  install?: typeof requestManagedInstall
}

/** Machine-local actions. The server relays them and makes no release decision. */
export class HarnessInstalls {
  private readonly installing = new Set<BuiltinHarnessKind>()
  constructor(private readonly options: HarnessInstallsOptions) {}

  inventory(inventory: Inventory): Inventory {
    if (!this.installing.size) return inventory
    return {
      ...inventory,
      agents: inventory.agents.map((agent) =>
        !this.installing.has(agent.kind)
          ? agent
          : {
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
                  },
                },
              },
            },
      ),
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
          this.installing.add(harness)
          try {
            // A fresh wave also notices a personal copy installed since the last report.
            const snapshot = await this.options.runtime.refresh()
            this.options.report()
            const own = snapshot.executables.has(harness)
              ? true
              : snapshot.inventory.agents.find((agent) => agent.kind === harness)?.installed ===
                  null
                ? null
                : false
            const result = await (this.options.install ?? requestManagedInstall)(harness, own, {
              harnessesDir,
              commandEnv: snapshot.commandEnvironment.env,
              requestedBy: 'person',
            })
            if (result.outcome !== 'installed') return failure(result)
            await this.options.podiumHomes?.reconcile((kind) => kind === harness)
            return { ok: true, outcome: result.outcome, version: result.version }
          } finally {
            this.installing.delete(harness)
          }
        }
        case 'check': {
          const [result] = await this.options.updater.checkNow(harness)
          if (!result) return { ok: false, error: 'The machine returned no check result.' }
          return result.outcome === 'installed' || result.outcome === 'no-update'
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
      if (action !== 'changes') this.options.report()
    }
  }
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
