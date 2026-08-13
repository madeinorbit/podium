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
 * Here the web build is a STEP the publisher awaits, so "the dist is at HEAD" is
 * established by the same code path that then depends on it, rather than hoped
 * for. Both steps run in the batch tier (see `build-scope.ts`), which the unit
 * never did — it sat at the systemd default of CPUWeight=100 and outranked every
 * agent session 2:1.
 *
 * WHAT COVERS WHAT THE UNIT COVERED:
 * - Boot (`WantedBy=default.target`): the server calls `requestBuild(true)` when
 *   it starts listening, and that path now ensures the dist first. A reboot
 *   therefore still ends with a current website, without a unit to install.
 * - Redeploy (the redeploy unit restarted the web unit): a redeploy restarts the
 *   server, which is the same boot path.
 * - The Update panel's "rebuild the website" (`createSourceWebRebuildRequest`):
 *   `requestRebuild()` below.
 * - Legibility (`RemainAfterExit=yes` made `systemctl status` answer "did the web
 *   build succeed?"): `state()` answers it in the publisher readiness the update
 *   read model already shows, and the transient units keep DETERMINISTIC names,
 *   so `systemctl --user status podium-dev-web-build.scope` answers it while a
 *   build runs and `journalctl` after.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@podium/logger'
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
   * Resolves once `apps/web/dist` is stamped at `headSha`, building it if it is
   * not. Concurrent callers share one build; a current dist costs one small
   * file read and no process at all, which is what makes it safe on the
   * `/version` path.
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
  /** Seam for tests; defaults to one batch-tier scope per step. */
  runStep?: (step: { role: string; label: string; args: readonly string[] }) => Promise<void>
}

export function createDevWebBuilder(deps: DevWebBuilderDeps): DevWebBuilder {
  const readStamp = deps.readStamp ?? readDevWebStamp
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

  const build = async (headSha: string): Promise<void> => {
    log.info('building the development web bundles', { headSha, units })
    for (const step of DEV_WEB_BUILD_STEPS) {
      await runStep(step)
    }
    // The build stamps the dist itself, so re-reading it is the only honest
    // confirmation that this build produced the website for THIS commit. HEAD
    // moving mid-build is the case that would otherwise pass here and fail
    // later, deep inside the compile, having spent it.
    if (!webDistMatchesHead(readStamp(deps.root), headSha)) {
      throw new Error(
        `the web build finished but apps/web/dist is not stamped at ${headSha} ` +
          '(HEAD moved during the build, or the stamp step did not run)',
      )
    }
  }

  const ensure = (headSha: string): Promise<void> => {
    if (webDistMatchesHead(readStamp(deps.root), headSha)) {
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
