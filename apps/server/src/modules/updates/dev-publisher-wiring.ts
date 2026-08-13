/**
 * DEVELOPMENT BUNDLE PUBLISHER, wired.
 *
 * A server running FROM SOURCE can hand its own daemons the code it is actually
 * running, through the same download/verify/swap path production uses (POD-1670
 * spec §9). That is deliberate: development use becomes the continuous test of
 * the release mechanism, which is otherwise exercised only at release, which is
 * the worst possible moment to discover it is broken.
 *
 * Extracted from `server.ts` because that file crossed its reviewed 800-line
 * budget (POD-1385's god-object audit) as this epic added to it, and this block
 * is a self-contained unit that has nothing to do with server bootstrap. The
 * audit's own remedy is decompose-or-raise-deliberately; this is the decompose.
 *
 * INERT ON AN INSTALLED SERVER. `PODIUM_HOME` is set by the headless launcher
 * shim, so its presence means "installed" and the publisher is not created at
 * all. Every function here then no-ops, which is why `/version` can call
 * `requestBuild` unconditionally without an installed server ever doing work.
 * Callers that do not await a compile must still catch the returned promise.
 */

import { createLogger } from '@podium/logger'
import type { UpdateTarget } from '@podium/protocol'
import type { Hono } from 'hono'
import { registerDevArtifactRoute } from './artifact-route'
import {
  createDevBundlePublisher,
  DevBundleUnavailableError,
  developmentHeadSha,
} from './dev-bundle'
import { createServerDevBundleLock, type DevBundleLockService } from './dev-bundle-lock'
import { createDevWebBuilder, type DevWebBuildState, decideWebDist } from './dev-web-build'

const log = createLogger('server:updates')

export interface DevPublisherWiring {
  /** Publish the current development target, if there is one. */
  readonly publishTarget: () => UpdateTarget | undefined
  /**
   * Ask for a build. `/version` voids the promise so a compile never blocks a
   * read. Update awaits it. `explicit` bypasses the debounce for a
   * human-initiated request.
   */
  readonly requestBuild: (explicit: boolean) => Promise<unknown>
  /** Mount the authenticated artifact route, when a publisher exists. */
  readonly registerRoute: (app: Hono) => void
  /** True when this server can publish a development bundle at all. */
  readonly enabled: boolean
  /**
   * Rebuild `apps/web/dist` + the mobile web bundle without touching the server
   * — what restarting `podium-web.service` used to do. Absent on an installed
   * server, which has no sources to build from.
   */
  readonly requestWebRebuild: (() => void) | undefined
  /**
   * "Did the web build succeed?", which `RemainAfterExit=yes` used to answer
   * through `systemctl status`. Also names the transient units, so an operator
   * can follow the running build or read its journal afterwards.
   */
  readonly webBuildState: () => DevWebBuildState
}

export function developmentArtifactUrl(
  origin: string,
  version: string,
  artifactToken: string,
): string {
  return `${origin}/updates/dev-bundle/${encodeURIComponent(version)}?token=${encodeURIComponent(artifactToken)}`
}

export function selectDevelopmentArtifactOrigin(input: {
  externalOrigin: string | undefined
  localOrigin: string
  hasRemoteManagedMachines: boolean
}): string {
  if (input.externalOrigin) return input.externalOrigin
  if (input.hasRemoteManagedMachines) {
    throw new Error(
      'development artifact publishing requires PODIUM_DEV_ARTIFACT_BASE_URL or ' +
        'config.publicUrl while remote managed machines are registered',
    )
  }
  return input.localOrigin
}

export function wireDevBundlePublisher(deps: {
  /** Absent (an installed server) disables the whole thing. */
  readonly sourceRoot: string | undefined
  /** Validated external origin. Absent is allowed only for same-host publication. */
  readonly artifactOrigin: string | undefined
  /** Loopback origin used only when the registered managed fleet is same-host. */
  readonly localArtifactOrigin: () => string
  /** Read at publication time so a newly joined remote machine fails closed immediately. */
  readonly hasRemoteManagedMachines: () => boolean
  readonly artifactToken: string
  readonly signingKey: string
  readonly setTarget: (target: UpdateTarget) => void
  /**
   * Retract the `dev` target and record a reason a client may be shown. Called
   * whenever this HEAD has no publishable bundle, so the read model never keeps
   * offering an older commit's.
   */
  readonly setTargetUnavailable?: (reason: string) => void
  readonly locks: DevBundleLockService
  /** Names the transient build units. Defaults to the default instance. */
  readonly instanceId?: string
}): DevPublisherWiring {
  const sourceRoot = deps.sourceRoot
  const artifactOrigin = deps.artifactOrigin
  const instanceId = deps.instanceId ?? 'default'
  /**
   * The website the compile will demand. Owned here rather than in `server.ts`
   * because it is one half of the same job: the publisher awaits it before the
   * expensive work, and the Update panel drives it directly when only the dist
   * is behind.
   */
  const webBuilder = sourceRoot
    ? createDevWebBuilder({
        root: sourceRoot,
        instanceId,
        headSha: () => developmentHeadSha(sourceRoot),
      })
    : undefined
  const publisher = sourceRoot
    ? createDevBundlePublisher({
        isSourceRun: true,
        root: sourceRoot,
        instanceId,
        headSha: () => developmentHeadSha(sourceRoot),
        signingKey: deps.signingKey,
        lock: createServerDevBundleLock(sourceRoot, deps.locks),
        prepareWebDist: (headSha, explicit) => {
          if (!webBuilder) return Promise.resolve()
          const decision = decideWebDist({
            current: webBuilder.isCurrent(headSha),
            explicit,
          })
          if (decision === 'ready') return Promise.resolve()
          // `refuse` is the `/version` poll. The browser is served
          // `apps/web/dist` by THIS process, which is still running the commit
          // it booted with, so rebuilding the dist here would put the page
          // ahead of the server and desynchronise every open tab. No tarball
          // for this commit until something restarts the server onto it —
          // which is also what rebuilds the website.
          if (decision === 'refuse') {
            return Promise.reject(
              new DevBundleUnavailableError(
                `development bundle unavailable: apps/web/dist is not the website for ${headSha}, and ` +
                  'rebuilding it outside a restart would leave open browser tabs ahead of this server. ' +
                  'It is rebuilt when the server starts on this commit, or from Update Podium.',
                `The website has not been built for HEAD (${headSha}) yet. It is rebuilt when this ` +
                  'server restarts onto that commit, or when you update Podium.',
              ),
            )
          }
          // A web-build failure must arrive as a REFUSAL with its own words, not
          // as a nameless compile error: the operator's next move (look at the
          // vite output) is different from the one a failed compile calls for.
          return webBuilder.ensure(headSha).catch((error: unknown) => {
            throw new DevBundleUnavailableError(
              `development bundle unavailable: the web bundles could not be rebuilt for dev+${headSha}: ` +
                (error instanceof Error ? error.message : String(error)),
              `The website could not be rebuilt for HEAD (${headSha}), so dev+${headSha} cannot be packed.`,
            )
          })
        },
        artifactUrl: (version) =>
          developmentArtifactUrl(
            selectDevelopmentArtifactOrigin({
              externalOrigin: artifactOrigin,
              localOrigin: deps.localArtifactOrigin(),
              hasRemoteManagedMachines: deps.hasRemoteManagedMachines(),
            }),
            version,
            deps.artifactToken,
          ),
      })
    : undefined

  let unavailableDiagnostic: string | undefined
  let publishedReason: string | undefined

  /**
   * Push the publisher's readiness into the shared read model.
   *
   * A dev identity (web digest, no tarball) is still a target. Retracting it
   * because the headless compile failed hides Update — operators then have no
   * button to rebuild yesterday's website.
   */
  const publishReadiness = (): void => {
    if (!publisher || !artifactOrigin) return
    const identity = publisher.target()
    if (identity) {
      deps.setTarget(identity)
      publishedReason = undefined
      return
    }
    if (!deps.setTargetUnavailable) return
    const readiness = publisher.readiness()
    const reason =
      readiness.state === 'failed'
        ? readiness.publicReason
        : readiness.state === 'preparing'
          ? // Name the step actually running. The website is built first and takes
            // the best part of a minute, so "building the bundle" would be wrong
            // for most of the wait and leaves an operator watching the wrong log.
            webBuilder?.state().state === 'building'
            ? `Rebuilding the website for dev+${readiness.headSha}.`
            : `Building the development bundle for dev+${readiness.headSha}.`
          : 'No development bundle has been built for the current commit yet.'
    if (reason === publishedReason) return
    publishedReason = reason
    deps.setTargetUnavailable(reason)
  }

  const publishTarget = (): UpdateTarget | undefined => {
    try {
      const target = publisher?.target()
      // A loopback target is useful to the same host through /version, but must never enter the
      // shared update service where a later remote grant could receive it.
      if (target && artifactOrigin) {
        deps.setTarget(target)
        publishedReason = undefined
      } else {
        publishReadiness()
      }
      unavailableDiagnostic = undefined
      return target
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error)
      if (diagnostic !== unavailableDiagnostic) {
        log.warn('development bundle target unavailable', { diagnostic })
        unavailableDiagnostic = diagnostic
      }
      return undefined
    }
  }

  return {
    enabled: publisher !== undefined,
    requestWebRebuild: webBuilder ? () => webBuilder.requestRebuild() : undefined,
    webBuildState: () => webBuilder?.state() ?? { state: 'idle' },
    publishTarget,
    requestBuild: (explicit) => {
      if (!publisher) return Promise.resolve()
      const requested = publisher.requestBuild(explicit)
      // Before awaiting anything: if that admitted a build, the state is now
      // `preparing` and the read model should say so rather than sit on the
      // previous commit's target for the length of a compile.
      publishReadiness()
      return requested.then(
        (built) => {
          publishTarget()
          return built
        },
        (error: unknown) => {
          // The failure must reach the read model, or a stale target stays
          // published while the only trace of the problem is this log line.
          publishReadiness()
          // A refused build is a normal state on a working checkout (`/version`
          // asks on every read), so log each distinct reason once rather than
          // once per request. This full text — offending paths included — is
          // the CONSOLE half; only `readiness().publicReason` travels to a
          // client.
          const diagnostic =
            publisher.unavailable() ?? (error instanceof Error ? error.message : String(error))
          if (diagnostic !== unavailableDiagnostic) {
            unavailableDiagnostic = diagnostic
            log.warn('development bundle unavailable', { diagnostic })
          }
          throw error
        },
      )
    },
    registerRoute: (app) => {
      if (!publisher) return
      registerDevArtifactRoute(app, {
        current: () => publisher.current(),
        authenticate: (request) =>
          new URL(request.url).searchParams.get('token') === deps.artifactToken,
      })
    },
  }
}
