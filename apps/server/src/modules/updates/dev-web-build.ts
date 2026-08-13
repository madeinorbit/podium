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
 * Here the web build is a STEP the publisher awaits — on the requests where it
 * may run at all, see below — so "the dist is at HEAD" is established by the
 * same code path that then depends on it, rather than hoped for. Both steps run
 * in the batch tier (see `build-scope.ts`), which the unit never did — it sat at
 * the systemd default of CPUWeight=100 and outranked every agent session 2:1.
 *
 * WHEN IT MAY RUN, which is narrower than "whenever the website is stale".
 *
 * The server SERVES this dist to browsers, so writing it changes what every open
 * tab will load next — while the server itself keeps running the commit it
 * booted with. The first version of this sequenced the web build on the
 * `/version` path, which asks for a build on every read: the website was then
 * rebuilt each time main moved and the page ran AHEAD of the server, wire schema
 * digests disagreed, and the out-of-sync banner appeared on a host where nothing
 * automatically restarts the server (one server on dev+e10795a was measured
 * rebuilding the website six times for five commits it was not running).
 *
 * So the website only moves when the SERVER can move with it: its own start-up,
 * and an operator-driven update that restarts it. On the polling path a stale
 * website merely blocks the tarball — see `prepareWebDist` in `dev-bundle.ts`. A
 * refused artifact costs nothing and heals at the next restart; a page ahead of
 * its server costs every open tab.
 *
 * WHAT COVERS WHAT THE UNIT COVERED:
 * - Boot (`WantedBy=default.target`): the server calls `requestBuild(true)` when
 *   it starts listening — explicit, and the moment it IS the commit it is
 *   building for. A reboot therefore still ends with a current website, without
 *   a unit to install.
 * - Redeploy (the redeploy unit restarted the web unit): a redeploy restarts the
 *   server, which is the same boot path.
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
import { devBuildScopeUnit, runLowTierBuild } from './build-scope'

const log = createLogger('server:updates')

/** The two commands `podium-web.service` ran, in the order it ran them. */
export const DEV_WEB_BUILD_STEPS = [
  { role: 'dev-web-build', label: 'apps/web', args: ['run', '--filter', '@podium/web', 'build'] },
  {
    role: 'dev-mobile-build',
    label: 'apps/mobile',
    args: ['run', '--filter', '@podium/mobile', 'build:web'],
  },
] as const

export interface DevWebBuildStamp {
  sourceSha?: string
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

/**
 * WHETHER A BUILD REQUEST MAY WRITE THE SERVED WEBSITE.
 *
 * A table rather than a judgement at the call site, because the wrong answer is
 * invisible on this machine and catastrophic in the browser: `rebuild` on a
 * polling request is what put the page ahead of the server (see the note at the
 * top of this file). `refuse` is not a failure of the website — it is a refusal
 * to pack a TARBALL for a commit this server is not running, and it heals the
 * moment something restarts it.
 */
export type DevWebDistDecision = 'ready' | 'rebuild' | 'refuse'

export function decideWebDist(input: { current: boolean; explicit: boolean }): DevWebDistDecision {
  if (input.current) return 'ready'
  return input.explicit ? 'rebuild' : 'refuse'
}

export function readDevWebStamp(root: string): DevWebBuildStamp | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(root, 'apps', 'web', 'dist', 'podium-build.json'), 'utf8'),
    ) as { sourceSha?: unknown }
    return typeof raw.sourceSha === 'string' ? { sourceSha: raw.sourceSha } : {}
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
   * Is the served website already this commit's — BOTH halves? Two small file
   * reads, so it is safe to ask on every `/version`. The caller decides what a
   * NO means (see `decideWebDist`); it must be this same question the build
   * itself asks, or a refusal and a rebuild would disagree about what "current"
   * is.
   */
  isCurrent(headSha: string): boolean
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
  ensure(headSha: string): Promise<void>
  /** The Update panel's explicit "rebuild the website". */
  requestRebuild(): void
  state(): DevWebBuildState
}

export interface DevWebBuilderDeps {
  root: string
  instanceId: string
  /** Only for `requestRebuild`, which has no caller to take the sha from. */
  headSha: () => string
  /** Seam for tests; defaults to reading `apps/web/dist/podium-build.json`. */
  readStamp?: (root: string) => DevWebBuildStamp | null
  /** Seam for tests; defaults to reading `apps/mobile/dist`. */
  readPhone?: (root: string) => ServedWebIdentity
  /** Seam for tests; defaults to one batch-tier scope per step. */
  runStep?: (step: { role: string; label: string; args: readonly string[] }) => Promise<void>
}

export function createDevWebBuilder(deps: DevWebBuilderDeps): DevWebBuilder {
  const readStamp = deps.readStamp ?? readDevWebStamp
  const readPhone = deps.readPhone ?? readDevPhoneDist
  const units = DEV_WEB_BUILD_STEPS.map((step) => devBuildScopeUnit(step.role, deps.instanceId))
  const runStep =
    deps.runStep ??
    ((step: { role: string; label: string; args: readonly string[] }) =>
      runLowTierBuild({
        unit: devBuildScopeUnit(step.role, deps.instanceId),
        description: `Podium development web build (${step.label})`,
        command: process.env.BUN_BIN ?? 'bun',
        args: step.args,
        cwd: deps.root,
        env: process.env,
      }))

  let state: DevWebBuildState = { state: 'idle' }
  let inFlight: { headSha: string; promise: Promise<void> } | null = null

  /**
   * Is the WEBSITE this commit's — both halves of it? Cheap by construction:
   * one small file read, and a second only when the first says yes.
   */
  const websiteAtHead = (headSha: string): boolean =>
    webDistMatchesHead(readStamp(deps.root), headSha) &&
    !phoneDistBehindHead(readPhone(deps.root), headSha)

  const build = async (headSha: string): Promise<void> => {
    log.info('building the development web bundles', { headSha, units })
    for (const step of DEV_WEB_BUILD_STEPS) {
      await runStep(step)
    }
    // The build stamps each dist itself, so re-reading them is the only honest
    // confirmation that this build produced the website for THIS commit. HEAD
    // moving mid-build is the case that would otherwise pass here and fail
    // later, deep inside the compile, having spent it. Both halves are named
    // separately because the operator's next move differs: the vite log and the
    // expo log are different logs.
    if (!webDistMatchesHead(readStamp(deps.root), headSha)) {
      throw new Error(
        `the web build finished but apps/web/dist is not stamped at ${headSha} ` +
          '(HEAD moved during the build, or the stamp step did not run)',
      )
    }
    if (phoneDistBehindHead(readPhone(deps.root), headSha)) {
      throw new Error(
        `the web build finished but apps/mobile/dist is not stamped at ${headSha} ` +
          '(HEAD moved during the build, or the phone export did not stamp itself)',
      )
    }
  }

  const ensure = (headSha: string): Promise<void> => {
    if (websiteAtHead(headSha)) {
      state = { state: 'ready', headSha }
      return Promise.resolve()
    }
    if (inFlight && inFlight.headSha === headSha) return inFlight.promise
    state = { state: 'building', headSha, units }
    const promise = build(headSha).then(
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
    inFlight = { headSha, promise }
    return promise
  }

  return {
    isCurrent: websiteAtHead,
    ensure,
    requestRebuild: () => {
      let headSha: string
      try {
        headSha = deps.headSha()
      } catch (error) {
        log.warn('could not determine HEAD for a web rebuild', { err: error })
        return
      }
      void ensure(headSha).catch(() => {})
    },
    state: () => state,
  }
}
