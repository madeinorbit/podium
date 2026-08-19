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
 * all. Read-only target publication and explicit build admission remain
 * separate capabilities in either profile.
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
import { createGitHeadShaCache } from './head-sha-cache'

const log = createLogger('server:updates')

export interface DevPublisherWiring {
  /**
   * Publish the current development target, if there is one.
   *
   * Asynchronous because naming the target means reading HEAD, and every git
   * call this server makes is off its event loop (POD-2048).
   */
  readonly publishTarget: () => Promise<UpdateTarget | undefined>
  /**
   * Ask for a build after the operator has started an update. Merely publishing
   * the current HEAD identity never calls this capability.
   */
  readonly requestBuild: () => Promise<unknown>
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
  /** Readiness of the two coordinator-owned preparation places shown by Update. */
  readonly preparation: () => {
    webReady: boolean
    bundleReady: boolean
    failureDetail?: string
  }
}

export function developmentArtifactUrl(
  origin: string,
  version: string,
  artifactToken: string,
): string {
  return `${origin}/updates/dev-bundle/${encodeURIComponent(version)}?token=${encodeURIComponent(artifactToken)}`
}

/**
 * The sentence an operator is shown when this server cannot name an address its
 * fleet could fetch from — spec §6.2 and §7: a failure names itself, says the
 * one next action, and is recoverable by taking it.
 *
 * It is written as the remedy rather than as the condition because that is what
 * the reader can act on. The condition (which env var, which machines) stays in
 * the console half of {@link DevBundleUnavailableError}, where a log reader
 * wants it.
 */
export const ARTIFACT_ORIGIN_UNCONFIGURED_REASON =
  'This server has no address your other machines can reach, so it cannot hand out the ' +
  'update package. Set Public URL in Settings — or PODIUM_DEV_ARTIFACT_BASE_URL — to an ' +
  'address they can reach, then start the update again.'

export function selectDevelopmentArtifactOrigin(input: {
  externalOrigin: string | undefined
  localOrigin: string
  hasRemoteManagedMachines: boolean
}): string {
  if (input.externalOrigin) return input.externalOrigin
  if (input.hasRemoteManagedMachines) {
    // TYPED, so the refusal can travel (POD-2227). It used to be a bare Error
    // whose only reader was `publishTarget`'s catch, which logged it and
    // returned undefined — the operator was left watching a step that waited
    // for a package this server had already decided it would never hand over.
    throw new DevBundleUnavailableError(
      'development artifact publishing requires PODIUM_DEV_ARTIFACT_BASE_URL or ' +
        'config.publicUrl while remote managed machines are registered',
      ARTIFACT_ORIGIN_UNCONFIGURED_REASON,
    )
  }
  return input.localOrigin
}

/**
 * What the shared update service may advertise.
 *
 * A dest identity (web digest, git checkout, no tarball URL) is the destination
 * Update Podium needs on this host. It must enter the service even when there is
 * no publicUrl — otherwise /version shows dest+HEAD and converge throws
 * "No update target is configured."
 *
 * A dest tarball URL is different: without an external origin it is loopback, and
 * a later remote grant must not be handed 127.0.0.1. Strip that URL and keep the
 * dest identity so this host can still rebuild and pack.
 */
export function targetForSharedReadModel(
  target: UpdateTarget,
  artifactOrigin: string | undefined,
): UpdateTarget {
  if (artifactOrigin || target.artifacts.headless === undefined) return target
  const { headless: _headless, ...artifacts } = target.artifacts
  return { ...target, artifacts }
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
  /** Seam for tests; defaults to `git rev-parse --short=7 HEAD` in `sourceRoot`. */
  readonly readHeadSha?: (root: string) => Promise<string>
}): DevPublisherWiring {
  const sourceRoot = deps.sourceRoot
  const artifactOrigin = deps.artifactOrigin
  const instanceId = deps.instanceId ?? 'default'
  /**
   * ONE HEAD READER for everything below, and the reason it is here.
   *
   * The publisher reads HEAD two to four times per `/version` — to decide, to
   * name the target, to explain a refusal — and the web builder reads it again
   * on a rebuild. Every one of those was its own `git rev-parse`. Sharing a
   * cache is only possible at the composition root, because it is the only
   * place that knows they are all asking about the same checkout (POD-2052).
   */
  const readHeadSha = deps.readHeadSha ?? developmentHeadSha
  const headSha = sourceRoot
    ? createGitHeadShaCache(sourceRoot, () => readHeadSha(sourceRoot))
    : undefined
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
        headSha: () => headSha?.read() ?? readHeadSha(sourceRoot),
      })
    : undefined
  const publisher = sourceRoot
    ? createDevBundlePublisher({
        isSourceRun: true,
        root: sourceRoot,
        instanceId,
        headSha: () => headSha?.read() ?? readHeadSha(sourceRoot),
        signingKey: deps.signingKey,
        lock: createServerDevBundleLock(sourceRoot, deps.locks),
        // The instant a build is admitted, the read model must say `preparing`
        // rather than keep offering the previous commit's target for the length
        // of a compile. Admission is decided asynchronously (it reads HEAD and
        // walks the tree off the loop), so the publisher announces it — a
        // caller cannot infer it from `requestBuild` having returned.
        onAdmitted: () => {
          void publishReadiness()
        },
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
          // for this commit exists until a confirmed update prepares it.
          if (decision === 'refuse') {
            return Promise.reject(
              new DevBundleUnavailableError(
                `development bundle unavailable: apps/web/dist is not the website for ${headSha}, and ` +
                  'rebuilding it before a confirmed update would leave open browser tabs ahead of this server. ' +
                  'It is rebuilt when you update Podium.',
                `The website has not been built for HEAD (${headSha}) yet. The confirmed ` +
                  'update operation prepares it.',
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
  let publishedVersion: string | undefined
  let bundleReady = false
  let bundleFailureDetail: string | undefined
  /**
   * A refusal that belongs to PUBLICATION rather than to the build — the server
   * has bytes, or could make them, and no way to tell anyone where to get them
   * (POD-2227). Held separately from `bundleFailureDetail` because
   * `observeBundleReadiness` recomputes that one from the builder, which is
   * perfectly happy: the tarball really was packed and signed.
   */
  let publishFailureDetail: string | undefined

  /**
   * CAN THIS SERVER NAME AN ADDRESS THE FLEET COULD FETCH FROM?
   *
   * Asked BEFORE the pack as well as at publication. The live drive spent
   * thirty-five seconds building a bundle, reported "The update package is
   * ready.", and then waited for a package this server had already decided it
   * would never hand over — the answer was knowable before the first byte.
   */
  const artifactOriginFailure = (): DevBundleUnavailableError | undefined => {
    if (!publisher) return undefined
    try {
      selectDevelopmentArtifactOrigin({
        externalOrigin: artifactOrigin,
        localOrigin: deps.localArtifactOrigin(),
        hasRemoteManagedMachines: deps.hasRemoteManagedMachines(),
      })
      return undefined
    } catch (error) {
      if (error instanceof DevBundleUnavailableError) return error
      throw error
    }
  }

  /** Log the console half once per distinct reason; keep the public half for the panel. */
  const recordPublishFailure = (error: DevBundleUnavailableError): void => {
    publishFailureDetail = error.publicReason
    if (error.message === unavailableDiagnostic) return
    unavailableDiagnostic = error.message
    log.warn('development bundle target unavailable', { diagnostic: error.message })
  }

  /** Cache publisher readiness at lifecycle transitions; fleet polling must not spawn git. */
  const observeBundleReadiness = async () => {
    const readiness = await publisher?.readiness()
    bundleReady = readiness?.state === 'ready'
    bundleFailureDetail = readiness?.state === 'failed' ? readiness.publicReason : undefined
    return readiness
  }

  const setSharedTarget = (target: UpdateTarget): void => {
    publishedVersion = target.version
    deps.setTarget(targetForSharedReadModel(target, artifactOrigin))
  }

  /**
   * Push the publisher's readiness into the shared read model.
   *
   * A dev identity (web digest, no tarball) is still a target. Retracting it
   * because the headless compile failed hides Update — operators then have no
   * button to rebuild yesterday's website.
   */
  const publishReadiness = async (): Promise<void> => {
    if (!publisher) return
    const identity = await publisher.target()
    if (identity) {
      setSharedTarget(identity)
      publishedReason = undefined
      return
    }
    if (!deps.setTargetUnavailable) return
    const readiness = await observeBundleReadiness()
    if (!readiness) return
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

  const publishTarget = async (): Promise<UpdateTarget | undefined> => {
    try {
      const target = await publisher?.target()
      if (target) {
        setSharedTarget(target)
        publishedReason = undefined
      } else {
        await publishReadiness()
      }
      unavailableDiagnostic = undefined
      publishFailureDetail = undefined
      return target
    } catch (error) {
      // A TYPED refusal reaches the read model; an untyped one is a diagnostic
      // whose text may name paths, and stays in the log (POD-2227).
      if (error instanceof DevBundleUnavailableError) {
        recordPublishFailure(error)
        return undefined
      }
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
    requestWebRebuild: webBuilder
      ? () => {
          // Human-initiated, like an explicit build: ask git rather than the
          // stamp. Rebuilding the website for the wrong commit is a slow
          // mistake to discover.
          headSha?.invalidate()
          webBuilder.requestRebuild()
        }
      : undefined,
    webBuildState: () => webBuilder?.state() ?? { state: 'idle' },
    preparation: () => {
      const web = webBuilder?.state()
      const failureDetail =
        // First, because it is the one that decides whether ANY of this can be
        // delivered: a website rebuilt for a package nobody can fetch is not
        // the sentence to lead with.
        publishFailureDetail ??
        (web?.state === 'failed' && publishedVersion === `dev+${web.headSha}`
          ? `The website could not be rebuilt for dev+${web.headSha}. See the server log.`
          : bundleFailureDetail)
      return {
        webReady: web?.state === 'ready',
        // A packed tarball with no address to fetch it from is not a ready
        // package. `fleet` reported `bundleReady: true` right through the live
        // stall, which read as the package being on its way (POD-2227).
        bundleReady: bundleReady && publishFailureDetail === undefined,
        ...(failureDetail ? { failureDetail } : {}),
      }
    },
    publishTarget,
    requestBuild: () => {
      if (!publisher) return Promise.resolve()
      // Refuse before the compile, with the remedy in the sentence, rather than
      // pack for thirty-five seconds and leave the step waiting (POD-2227).
      const blocked = artifactOriginFailure()
      if (blocked) {
        recordPublishFailure(blocked)
        return Promise.reject(blocked)
      }
      publishFailureDetail = undefined
      // A human pressed Update. Whatever the stamp says, ask git — the one
      // interaction where someone is watching is not the place to save 8ms,
      // and it is the escape hatch if this cache is ever wrong about a
      // checkout. Read-only publication keeps the cache.
      headSha?.invalidate()
      // `preparing` is published by the publisher's `onAdmitted` above, not
      // from here: this call returns before admission has been decided.
      return publisher.requestBuild(true).then(
        async (built) => {
          await observeBundleReadiness()
          await publishTarget()
          return built
        },
        async (error: unknown) => {
          await observeBundleReadiness()
          // The failure must reach the read model, or a stale target stays
          // published while the only trace of the problem is this log line.
          await publishReadiness()
          // Log each distinct refusal once. This full text — offending paths
          // included — is the CONSOLE half; only
          // `readiness().publicReason` travels to a client.
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
