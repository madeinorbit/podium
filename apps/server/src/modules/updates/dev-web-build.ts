/**
 * THE WEB + MOBILE BUNDLES, BUILT BY THE SERVER THAT NEEDS THEM.
 *
 * This replaces `podium-web.service`, a dev-profile-only systemd oneshot that
 * ran the two vite builds at boot, on every redeploy, and whenever the server
 * asked it to restart. Retiring it is not only one less unit to install on every
 * development host — it removes a RACE that was costing real builds.
 *
 * The headless bundle build refuses to pack a `dev+<sha>` tarball unless
 * `apps/web/dist` is stamped at that same commit (`assertDevWebDistMatchesVersion`
 * in `scripts/build-bun.ts`): packing yesterday's website under today's sha is
 * the same lie the source-identity gate exists to prevent. But producing that
 * dist was owned by a SEPARATE unit nothing sequenced against the build. Measured
 * on ludovico over the seven days to 2026-08-13: 28 of 112 build attempts were
 * refused on the web-dist stamp, and because `/version` re-asks every 60 s a
 * stale dist spun that loop — 29 attempts in one hour on 2026-08-13 alone.
 *
 * WHAT THIS BUILDER IS FOR NOW, WHICH IS NARROWER THAN IT ONCE WAS (POD-3054).
 *
 * The RELEASE build no longer comes through here. `scripts/release.ts
 * --prepare-cross` — the one coordinator the development publisher and the CI
 * release job both run — builds or restores web and mobile through the Turbo lane
 * inside the approved commit's snapshot worktree, and packages every platform from
 * that one output. It never touches the live `apps/web/dist`.
 *
 * That is what retired the refuse/rebuild decision this file used to own. The
 * server SERVES this dist to browsers AND desktop webviews (all-in-one / client /
 * daemon shells load the connected server's origin — updater-convergence spec §2.1
 * / gap 22), so writing it changes what every open consumer loads next while the
 * server keeps running the commit it booted with. The first version of this
 * sequenced the web build on the `/version` path, which asked for a build on every
 * read: the website was rebuilt each time main moved, the page ran AHEAD of the
 * server, wire schema digests disagreed, and the out-of-sync banner appeared on a
 * host where nothing automatically restarts the server (one server on dev+e10795a
 * was measured rebuilding the website six times for five commits it was not
 * running). Packing a release no longer asks, so there is nothing left to refuse.
 *
 * What remains is the LIVE dist, and only an operator moves it. Both steps run in
 * the batch tier (see `build-scope.ts`), which the unit never did — it sat at the
 * systemd default of CPUWeight=100 and outranked every agent session 2:1.
 *
 * WHAT COVERS WHAT THE UNIT COVERED:
 * - Boot (`WantedBy=default.target`): observes the existing dist and starts no
 *   build. A watchdog recovery must not turn a stall into a compile storm.
 * - The Update panel's "rebuild the website" (`createSourceWebRebuildRequest`):
 *   `requestRebuild()` below. It rebuilds for a stale PHONE export as readily as
 *   for a stale desktop one — see `phoneDistBehindHead` (POD-1989).
 * - Legibility (`RemainAfterExit=yes` made `systemctl status` answer "did the web
 *   build succeed?"): `state()` answers it in the publisher readiness the update
 *   read model already shows, and the transient units keep DETERMINISTIC names,
 *   so `systemctl --user status podium-dev-web-build.scope` answers it while a
 *   build runs and `journalctl` after.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@podium/logger'
import { type ServedWebIdentity, servedWebIdentity } from '../../web-bundle-stamp'
import { devBuildCommand, devBuildScopeUnit, runLowTierBuild } from './build-scope'

const log = createLogger('server:updates')

/** The two commands `podium-web.service` ran, in the order it ran them. */
export const DEV_WEB_BUILD_STEPS = [
  {
    role: 'dev-web-build',
    label: 'apps/web',
    // One build script per client, and it is a Turbo task (POD-3053): an unchanged
    // client is restored from the shared cache instead of rebuilt. The landing size
    // ratchet is part of `build` now, so a red ratchet is a red build here too — the
    // dest-rebuild exemption `build:dist` used to grant is gone. The floor lives in
    // scripts/web-bundle-budget.ts and is raised by that script's own process; a dest
    // that trips it is telling the truth about what it would land.
    args: ['run', '--filter', '@podium/web', 'build'],
  },
  {
    role: 'dev-mobile-build',
    label: 'apps/mobile',
    args: ['run', '--filter', '@podium/mobile', 'build'],
  },
] as const

export interface DevWebBuildStamp {
  sourceSha?: string
  appVersion?: string
}

/**
 * Whether `apps/web/dist` is the website for this commit. The stamp is written
 * by `scripts/write-web-build-stamp.ts` from `git rev-parse --short=7 HEAD` at
 * build time, which is the same string `dev+<sha>` names — so this is the exact
 * question `assertDevWebDistMatchesVersion` will later ask, asked early enough
 * to do something about it.
 */
export function webDistMatchesHead(stamp: DevWebBuildStamp | null, headSha: string): boolean {
  return typeof stamp?.sourceSha === 'string' && stamp.sourceSha === headSha
}

/**
 * BOTH STEPS PRODUCE A WEBSITE, SO BOTH ANSWER "IS IT BUILT?" (POD-1989).
 *
 * The steps below build two dists, and `apps/web/dist` is only the first of
 * them. Reading its stamp alone made "the website is at HEAD" a claim about the
 * desktop half, which is wrong in the exact case Update exists for: a phone
 * export left on an older commit beside a current desktop dist. `startUpdate`
 * calls that behind (POD-1980) and offers the button; asking only the desktop
 * made the button's own rebuild return without spawning anything, so the export
 * never ran and the page waited out its deadline for a build that never started.
 *
 * ABSENT IS NOT BEHIND, the same distinction `servedWebIdentity` draws and the
 * same one `websiteDigestReader` acts on: an installation that never exported a
 * phone website has nothing stale about it, and treating its silence as work
 * would put this builder in a loop `/version` pays for every 60 s. A dist that
 * IS on disk and names no commit reads as behind — a check that reports "fine"
 * for what it cannot inspect is not a check (POD-1610).
 */
export function phoneDistBehindHead(phone: ServedWebIdentity, headSha: string): boolean {
  return phone.present && phone.digest !== headSha
}

/** The phone export as the steps below write it, under the source root. */
export function readDevPhoneDist(root: string): ServedWebIdentity {
  return servedWebIdentity(join(root, 'apps', 'mobile', 'dist'))
}

export function readDevWebStamp(root: string): DevWebBuildStamp | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(root, 'apps', 'web', 'dist', 'podium-build.json'), 'utf8'),
    ) as { sourceSha?: unknown; appVersion?: unknown }
    return {
      ...(typeof raw.sourceSha === 'string' ? { sourceSha: raw.sourceSha } : {}),
      ...(typeof raw.appVersion === 'string' ? { appVersion: raw.appVersion } : {}),
    }
  } catch {
    return null
  }
}

/** Answerable state, for the readiness a client may be shown. */
export type DevWebBuildState =
  | { state: 'idle' }
  | { state: 'building'; headSha: string; units: string[] }
  | { state: 'ready'; headSha: string }
  | { state: 'failed'; headSha: string; reason: string }

export interface DevWebBuilder {
  /**
   * Resolves once the website — `apps/web/dist` AND the phone export beside it
   * — is stamped at `headSha`, building it if it is not. Concurrent callers
   * share one build; a current website costs two small file reads and no
   * process at all.
   *
   * ONLY FOR A REQUEST THAT MOVES THE SERVER TOO (its start-up, or an operator
   * update that restarts it). The browser loads what this writes, so calling it
   * on a poll marches the page ahead of the server it is talking to.
   */
  ensure(headSha: string, appVersion?: string): Promise<void>
  /** The Update panel's explicit "rebuild the website". */
  requestRebuild(): void
  state(): DevWebBuildState
}

export interface DevWebBuilderDeps {
  root: string
  instanceId: string
  /**
   * Only for `requestRebuild`, which has no caller to take the sha from.
   *
   * Asynchronous because reading HEAD spawns `git` and this runs in the server
   * process, which serves every client of the instance (POD-2048).
   */
  headSha: () => string | Promise<string>
  /** Seam for tests; defaults to reading `apps/web/dist/podium-build.json`. */
  readStamp?: (root: string) => DevWebBuildStamp | null
  /** Seam for tests; defaults to reading `apps/mobile/dist`. */
  readPhone?: (root: string) => ServedWebIdentity
  /** Seam for tests; defaults to one batch-tier scope per step. */
  runStep?: (
    step: { role: string; label: string; args: readonly string[] },
    appVersion?: string,
  ) => Promise<void>
}

export function createDevWebBuilder(deps: DevWebBuilderDeps): DevWebBuilder {
  const readStamp = deps.readStamp ?? readDevWebStamp
  const readPhone = deps.readPhone ?? readDevPhoneDist
  const units = DEV_WEB_BUILD_STEPS.map((step) => devBuildScopeUnit(step.role, deps.instanceId))
  const runStep =
    deps.runStep ??
    ((step: { role: string; label: string; args: readonly string[] }, appVersion?: string) =>
      runLowTierBuild({
        unit: devBuildScopeUnit(step.role, deps.instanceId),
        description: `Podium development web build (${step.label})`,
        command: devBuildCommand(process.env),
        args: step.args,
        cwd: deps.root,
        env: { ...process.env, ...(appVersion ? { PODIUM_APP_VERSION: appVersion } : {}) },
      }))

  let state: DevWebBuildState = { state: 'idle' }
  let inFlight: { identity: string; promise: Promise<void> } | null = null

  /**
   * Is the WEBSITE this commit's — both halves of it? Cheap by construction:
   * one small file read, and a second only when the first says yes.
   */
  const websiteAtHead = (headSha: string, appVersion?: string): boolean => {
    const web = readStamp(deps.root)
    const phone = readPhone(deps.root)
    return (
      webDistMatchesHead(web, headSha) &&
      !phoneDistBehindHead(phone, headSha) &&
      (!appVersion || (web?.appVersion === appVersion && phone.appVersion === appVersion))
    )
  }

  /**
   * THE ARTIFACT DECIDES, NOT THE EXIT CODE — and one step's failure does not
   * cancel the other's.
   *
   * Both were learned from the same wedge. The two steps build two INDEPENDENT
   * dists, so `&&` between them meant a complaint about the desktop bundle's
   * SIZE stopped the phone export ever running. And because the caller then saw
   * a rejection, the website stayed "not this commit" for good: every poll
   * refused, every restart re-ran the same failing step, and no update could be
   * published — over a build whose desktop half was already correct on disk
   * (measured on the dev host at 54d2dc7).
   *
   * So: run every step, then ask the DISTS whether the website is this commit's.
   * That is the question the caller actually has, and the stamps are written by
   * the builds themselves — a truer answer than an exit status. A step that
   * failed is still reported: loudly in the log when the website came out right
   * anyway, and as the diagnosis when it did not.
   *
   * This does not weaken the mid-build HEAD-move check. If HEAD moves while
   * building, the stamps do not name it and this still fails — before the
   * compile that would otherwise have spent a minute discovering the same thing.
   */
  const build = async (headSha: string, appVersion?: string): Promise<void> => {
    log.info('building the development web bundles', { headSha, units })
    const failures: string[] = []
    for (const step of DEV_WEB_BUILD_STEPS) {
      try {
        await runStep(step, appVersion)
      } catch (error) {
        failures.push(`${step.label}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // Both halves are named separately because the operator's next move differs:
    // the vite log and the expo log are different logs.
    const wrong: string[] = []
    if (!webDistMatchesHead(readStamp(deps.root), headSha)) {
      wrong.push(`apps/web/dist is not stamped at ${headSha}`)
    }
    if (phoneDistBehindHead(readPhone(deps.root), headSha)) {
      wrong.push(`apps/mobile/dist is not stamped at ${headSha}`)
    }
    if (appVersion) {
      if (readStamp(deps.root)?.appVersion !== appVersion) {
        wrong.push(`apps/web/dist is not stamped at release ${appVersion}`)
      }
      if (readPhone(deps.root).appVersion !== appVersion) {
        wrong.push(`apps/mobile/dist is not stamped at release ${appVersion}`)
      }
    }
    if (wrong.length > 0) {
      throw new Error(
        `the web build finished but ${wrong.join(' and ')} ` +
          '(HEAD moved during the build, or a step did not stamp its dist)' +
          (failures.length > 0 ? `. Steps that failed — ${failures.join('; ')}` : ''),
      )
    }
    if (failures.length > 0) {
      // The website IS this commit's, so updates are not blocked — but something
      // failed and saying nothing would hide it until it broke something else.
      log.warn('the website is current, but a build step failed', { headSha, failures })
    }
  }

  const ensure = (headSha: string, appVersion?: string): Promise<void> => {
    if (websiteAtHead(headSha, appVersion)) {
      state = { state: 'ready', headSha }
      return Promise.resolve()
    }
    const identity = `${headSha}\0${appVersion ?? ''}`
    if (inFlight && inFlight.identity === identity) return inFlight.promise
    state = { state: 'building', headSha, units }
    const promise = build(headSha, appVersion).then(
      () => {
        inFlight = null
        state = { state: 'ready', headSha }
      },
      (error: unknown) => {
        inFlight = null
        const reason = error instanceof Error ? error.message : String(error)
        state = { state: 'failed', headSha, reason }
        log.warn('development web build failed', { headSha, reason })
        throw error
      },
    )
    inFlight = { identity, promise }
    return promise
  }

  return {
    ensure,
    requestRebuild: () => {
      const start = async (): Promise<void> => {
        let headSha: string
        try {
          headSha = await deps.headSha()
        } catch (error) {
          log.warn('could not determine HEAD for a web rebuild', { err: error })
          return
        }
        await ensure(headSha)
      }
      void start().catch(() => {})
    },
    state: () => state,
  }
}
