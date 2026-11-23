/**
 * THE PODIUM HOME OF EACH HARNESS ON THIS MACHINE (managed installs §4.3 to
 * §4.6).
 *
 * A machine uses Podium's side for a harness once it has a managed install of
 * it. From then on every credential Podium passes in runs in one home,
 * `<stateDir>/homes/podium/<harness>/`, and the sign-in folders link their
 * settings from it. This module does what happens when that side appears and
 * what a person can ask of it:
 *
 * - `reconcile`, after each inventory wave: for a harness that has a managed
 *   install and a Podium home never filled, make the home, fill it from the
 *   person's folder, and point the sign-in folders' links at it.
 * - `takeMySettings`: fill it again on request.
 *
 * Without a managed install nothing here runs, and credential management's
 * homes stay exactly as it built them.
 */

import { join } from 'node:path'
import { type HarnessEnvironment, harnessAccount } from '@podium/harness'
import { createLogger } from '@podium/logger'
import { HOME_HARNESSES, type HomeHarness } from '@podium/protocol'
import { type FillReport, fillPodiumHome, type PersonFolder, wasFilled } from './fill'
import type { HarnessHome, HomeRegistry } from './registry'
import { isPodiumHome } from './registry'
import { type RepointReport, repointSignInFolders } from './share'

const log = createLogger('daemon:podium-home')

export interface PodiumHomeDeps {
  homes: Pick<HomeRegistry, 'ensurePodiumHome' | 'list'>
  /** The person's own folder for `harness`, read only; undefined when the
   *  machine has no account home to read it from. */
  personFolder(harness: HomeHarness): Promise<PersonFolder | undefined>
}

export interface PodiumHomeReady {
  home: HarnessHome
  /** Present when this call filled it. */
  fill?: FillReport
  /** Present when this call pointed sign-in folders at it. */
  repointed?: RepointReport[]
}

export class PodiumHomes {
  /** One reconcile per harness at a time: a fill is not run twice at once. */
  private readonly running = new Map<HomeHarness, Promise<PodiumHomeReady | undefined>>()

  constructor(private readonly deps: PodiumHomeDeps) {}

  /**
   * After an inventory wave: make ready the Podium home of every harness that
   * has a managed install (`managed`). A home already filled is left alone,
   * so a wave with nothing new does nothing.
   */
  async reconcile(managed: (harness: HomeHarness) => boolean): Promise<PodiumHomeReady[]> {
    const ready: PodiumHomeReady[] = []
    for (const harness of HOME_HARNESSES) {
      if (!managed(harness)) continue
      const result = await this.once(harness, () => this.appear(harness))
      if (result) ready.push(result)
    }
    return ready
  }

  /** "Take my settings": copy the person's settings into the Podium home again. */
  async takeMySettings(harness: HomeHarness): Promise<FillReport | { error: string }> {
    const person = await this.deps.personFolder(harness)
    if (!person) return { error: 'this machine has no account home to take settings from' }
    const { home } = this.deps.homes.ensurePodiumHome(harness)
    const fill = fillPodiumHome(harness, person, home.dir)
    logFill(fill)
    return fill
  }

  private async appear(harness: HomeHarness): Promise<PodiumHomeReady | undefined> {
    const { home } = this.deps.homes.ensurePodiumHome(harness)
    if (wasFilled(home.dir)) return undefined
    const person = await this.deps.personFolder(harness)
    const fill = person ? fillPodiumHome(harness, person, home.dir) : undefined
    if (fill) logFill(fill)
    const signInFolders = this.deps.homes.list().filter((other) => !isPodiumHome(other))
    const repointed = repointSignInFolders(signInFolders, harness, home.dir)
    for (const folder of repointed) {
      if (folder.repointed.length + folder.unlinked.length + folder.leftInPlace.length === 0) {
        continue
      }
      log.info('pointed a sign-in folder at the Podium home', {
        homeId: folder.homeId,
        repointed: folder.repointed,
        unlinked: folder.unlinked,
        // A real file of the folder's own: left as it is, never replaced.
        leftInPlace: folder.leftInPlace,
      })
    }
    return { home, ...(fill ? { fill } : {}), repointed }
  }

  private async once<T extends PodiumHomeReady | undefined>(
    harness: HomeHarness,
    run: () => Promise<T>,
  ): Promise<T> {
    const active = this.running.get(harness)
    if (active) return (await active) as T
    const next = run().finally(() => this.running.delete(harness))
    this.running.set(harness, next)
    return await next
  }
}

/**
 * The person's own folder of `harness` for an account HOME and machine env:
 * the adapter's state root (`~/.claude` or `CLAUDE_CONFIG_DIR`, `~/.codex` or
 * `CODEX_HOME`) and, for Claude Code, the state file beside it.
 */
export function personFolderOf(
  harness: HomeHarness,
  account: { home: string; env: HarnessEnvironment },
): PersonFolder {
  const scope = harnessAccount(harness, account.home, account.env)
  if (harness !== 'claude-code') return { dir: scope.roots.state }
  const configDir = scope.env.CLAUDE_CONFIG_DIR?.trim()
  return {
    dir: scope.roots.state,
    claudeState: configDir ? join(configDir, '.claude.json') : join(account.home, '.claude.json'),
  }
}

function logFill(fill: FillReport): void {
  log.info('filled the Podium home from the person’s folder', {
    harness: fill.harness,
    copied: fill.copied,
    left: fill.left,
  })
}
