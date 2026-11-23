/**
 * PODIUM'S HARNESS HOMES ON THIS MACHINE (credential management §10 "Homes";
 * epic plan Task 8).
 *
 * A home is the configuration directory a harness reads its login from, made
 * by Podium for one credential: `<stateDir>/homes/<credentialId>/<harness>/`.
 * A session on that credential starts with the harness's directory variable
 * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) pointed at it, so the login stays there
 * and the harness renews it there: the home is the login's one keeper.
 *
 * THE DIRECTORY IS THE RECORD. `list` reads the homes directory; nothing else
 * remembers which homes exist, so a home a restart, a crash or a person's
 * `rm` took away is simply gone, and there is no second copy to disagree.
 *
 * Owner-only (0700) all the way down from the homes directory: a home holds a
 * login, and other users on the machine have no business listing whose.
 *
 * THE PODIUM HOME (managed installs §4.3) sits beside them,
 * `<stateDir>/homes/podium/<harness>/`: one per harness, for every credential
 * Podium passes in once the machine has a managed install. It belongs to no
 * credential (`credentialId` is `podium`), so credential removal never names
 * it, and `remove` refuses it unless the caller says the person confirmed
 * removing it on its own.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { harnessHomeVariable, manifestFor } from '@podium/harness'
import {
  DEFAULT_HOME_ID,
  HOME_HARNESSES,
  type HomeHarness,
  homeIdFor,
  PODIUM_HOME_OWNER,
  parseHomeId,
  parsePodiumHomeId,
  podiumHomeId,
} from '@podium/protocol'

/** One home Podium created. */
export interface HarnessHome {
  /** `<credentialId>:<harness>`, or `podium:<harness>` for the Podium home. */
  readonly homeId: string
  /** The credential the home keeps the login of; `podium` for the Podium home. */
  readonly credentialId: string
  readonly harness: HomeHarness
  /** The directory the harness's variable names. */
  readonly dir: string
}

export interface HomeRegistryOptions {
  /** `<stateDir>/homes`. */
  root: string
  /**
   * Awaited before a home's directory is deleted: stop what runs in it (the
   * engines of its sessions, Codex's own app-server daemon). A failure here
   * aborts the removal and the home stays.
   */
  beforeRemove?: (home: HarnessHome) => Promise<void>
}

const OWNER_ONLY = 0o700

export class HomeRegistry {
  constructor(private readonly options: HomeRegistryOptions) {}

  /** The directory homes live under. */
  get root(): string {
    return this.options.root
  }

  /** Make sure the home for `credentialId` and `harness` exists. */
  async ensure(
    credentialId: string,
    harness: HomeHarness,
  ): Promise<{ home: HarnessHome; created: boolean }> {
    if (!(HOME_HARNESSES as readonly string[]).includes(harness)) {
      throw new Error(`${harness} keeps no login in a home Podium can make`)
    }
    // Throws for a credential id that could name a path outside `root`.
    const homeId = homeIdFor(credentialId, harness)
    const home = this.homeFor(credentialId, harness, homeId)
    const created = !existsSync(home.dir)
    for (const dir of [this.options.root, join(this.options.root, credentialId), home.dir]) {
      await mkdir(dir, { recursive: true, mode: OWNER_ONLY })
      // `mode` is masked by the umask and ignored for a directory that was
      // already there: set it outright.
      await chmod(dir, OWNER_ONLY)
    }
    return { home, created }
  }

  /**
   * Make sure the Podium home of `harness` exists. Synchronous: the place that
   * decides a session's home (`sessionHomeFor`) is.
   */
  ensurePodiumHome(harness: HomeHarness): { home: HarnessHome; created: boolean } {
    if (!(HOME_HARNESSES as readonly string[]).includes(harness)) {
      throw new Error(`${harness} has no home a variable can move, so it has no Podium home`)
    }
    const home = this.podiumHomeFor(harness)
    const created = !existsSync(home.dir)
    for (const dir of [this.options.root, join(this.options.root, PODIUM_HOME_OWNER), home.dir]) {
      mkdirSync(dir, { recursive: true, mode: OWNER_ONLY })
      chmodSync(dir, OWNER_ONLY)
    }
    return { home, created }
  }

  /** The Podium home of `harness`, when it exists here. */
  podiumHome(harness: HomeHarness): HarnessHome | undefined {
    const home = this.podiumHomeFor(harness)
    return isDirectory(home.dir) ? home : undefined
  }

  /** The home `homeId` names, when it exists here. Never `default`. */
  get(homeId: string): HarnessHome | undefined {
    const podium = parsePodiumHomeId(homeId)
    if (podium) return this.podiumHome(podium)
    const parsed = parseHomeId(homeId)
    if (!parsed) return undefined
    const home = this.homeFor(parsed.credentialId, parsed.harness, homeId)
    return isDirectory(home.dir) ? home : undefined
  }

  /** Every home that exists here, the Podium homes included. */
  list(): HarnessHome[] {
    const homes: HarnessHome[] = []
    for (const credentialId of readNames(this.options.root)) {
      for (const harness of readNames(join(this.options.root, credentialId))) {
        const homeId = `${credentialId}:${harness}`
        const home = this.get(homeId)
        if (home) homes.push(home)
      }
    }
    return homes
  }

  /**
   * Stop what runs in the home, then delete it. `removed: false` when there
   * was no such home: the caller asked for it to be gone, and it is.
   * `default` is refused: Podium never removes the harness's own directory.
   * The Podium home is refused too, unless `podiumHomeConfirmed`: it holds
   * every passed-in session's conversations, and removing it is its own
   * confirmed request, never a side effect of removing a credential.
   */
  async remove(
    homeId: string,
    options: { podiumHomeConfirmed?: boolean; beforeDelete?: () => Promise<void> } = {},
  ): Promise<{ removed: boolean; freedBytes: number }> {
    if (homeId === DEFAULT_HOME_ID) {
      throw new Error('The default home is the harness’s own directory; Podium never removes it.')
    }
    const podium = parsePodiumHomeId(homeId)
    if (podium && !options.podiumHomeConfirmed) {
      throw new Error(
        'The Podium home holds the conversations of every session on a credential Podium passes in; it is removed only on its own confirmed request.',
      )
    }
    const parsed = podium
      ? { credentialId: PODIUM_HOME_OWNER, harness: podium }
      : parseHomeId(homeId)
    if (!parsed) throw new Error(`not a home id: ${homeId}`)
    const home = this.get(homeId)
    if (!home) return { removed: false, freedBytes: 0 }
    await this.options.beforeRemove?.(home)
    await options.beforeDelete?.()
    const freedBytes = sizeOf(home.dir)
    await rm(home.dir, { recursive: true, force: true })
    const credentialDir = join(this.options.root, home.credentialId)
    if (readNames(credentialDir).length === 0)
      await rm(credentialDir, { recursive: true, force: true })
    return { removed: true, freedBytes }
  }

  private podiumHomeFor(harness: HomeHarness): HarnessHome {
    return this.homeFor(PODIUM_HOME_OWNER, harness, podiumHomeId(harness))
  }

  private homeFor(credentialId: string, harness: HomeHarness, homeId: string): HarnessHome {
    return {
      homeId,
      credentialId,
      harness,
      dir: join(this.options.root, credentialId, harness),
    }
  }
}

function readNames(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Whether `home` is the Podium home of its harness (§4.3), not a credential's. */
export function isPodiumHome(home: Pick<HarnessHome, 'homeId'>): boolean {
  return parsePodiumHomeId(home.homeId) !== null
}

/** Bytes under `path`, links not followed: what deleting it gives back. */
function sizeOf(path: string): number {
  let total = 0
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.size
  for (const name of readNames(path)) total += sizeOf(join(path, name))
  return total
}

/**
 * The conversation roots Podium's homes add to discovery: each home's
 * directory is its harness's state root, the folder the scanner walks for
 * that harness (`projects/` for Claude Code, `sessions/` for Codex).
 */
export function homeDiscoveryRoots(
  homes: readonly HarnessHome[],
): Partial<Record<HomeHarness, string[]>> {
  const roots: Partial<Record<HomeHarness, string[]>> = {}
  for (const home of homes) {
    const variable = harnessHomeVariable(home.harness)
    const root = variable
      ? manifestFor(home.harness)?.roots(home.dir, { [variable]: home.dir }).state
      : home.dir
    if (root) roots[home.harness] = [...(roots[home.harness] ?? []), root]
  }
  return roots
}
