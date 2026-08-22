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
import type { ReleaseProposal, UpdateTarget } from '@podium/protocol'
import type { Hono } from 'hono'
import { registerDevFeedRoutes } from './artifact-route'
import {
  createDevBundlePublisher,
  DEV_ARTIFACT_ROUTE,
  DevBundleProposalMovedError,
  DevBundleUnavailableError,
  developmentHeadSha,
} from './dev-bundle'
import { createServerDevBundleLock, type DevBundleLockService } from './dev-bundle-lock'
import { createDevWebBuilder, type DevWebBuildState, decideWebDist } from './dev-web-build'
import { createGitHeadShaCache } from './head-sha-cache'
import {
  createReleaseApprovalFlow,
  ReleaseApprovalRefusal,
  type ReleaseApprovalTarget,
} from './release-approval'
import { type ChannelFeed, DEV_FEED_MANIFEST, DEV_FEED_ROUTE } from './release-target'

const log = createLogger('server:updates')

export interface DevPublisherWiring {
  /** The admin-only pre-release fact. Undefined means nothing awaits publication. */
  readonly proposal: () => Promise<ReleaseProposal | undefined>
  /** Approve BUILD + PUBLISH only; rollout remains the ordinary update offer. */
  readonly approveRelease: (
    approvedBy: string,
    expected: ReleaseApprovalTarget,
  ) => Promise<ReleaseProposal | undefined>
  /**
   * Ask for a build after the operator has started an update. Merely publishing
   * the current HEAD identity never calls this capability.
   */
  readonly requestBuild: () => Promise<unknown>
  /** Mount the authenticated dev feed (manifest + artifacts), when a publisher exists. */
  readonly registerRoute: (app: Hono) => void
  /**
   * How `resolveReleaseTarget` reaches THIS server's dev feed — the address, the
   * origin fence, the trust root and the machine credential, in one descriptor.
   *
   * Nothing when this server publishes no feed, or when it cannot name an
   * address its fleet could fetch from. Both are the same honest answer: there
   * is no dev feed to pull, so the channel resolves to "unavailable" with a
   * reason rather than to a target nobody could take delivery of.
   */
  readonly channelFeed: () => ChannelFeed | undefined
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

/**
 * Where a machine of `platform` fetches this version's bundle.
 *
 * The platform is part of the PATH rather than a query parameter because it selects
 * which file is served, and a URL that names the bytes it returns is one a log line or
 * a failed download can be read against.
 */
export function developmentArtifactUrl(
  origin: string,
  version: string,
  artifactToken: string,
  platform: string,
): string {
  return `${origin}${DEV_ARTIFACT_ROUTE}/${encodeURIComponent(
    version,
  )}/${encodeURIComponent(platform)}?token=${encodeURIComponent(artifactToken)}`
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

export function wireDevBundlePublisher(deps: {
  /** Absent (an installed server) disables the whole thing. */
  readonly sourceRoot: string | undefined
  /** Validated external origin. Absent is allowed only for same-host publication. */
  readonly artifactOrigin: string | undefined
  /** Loopback origin used only when the registered managed fleet is same-host. */
  readonly localArtifactOrigin: () => string
  /** Read at publication time so a newly joined remote machine fails closed immediately. */
  readonly hasRemoteManagedMachines: () => boolean
  /**
   * The platforms the registered fleet actually runs — what this host mints bundles
   * for beyond its own [spec:SP-6144 section 8b]. Absent mints only this host's.
   */
  readonly fleetPlatforms?: () => readonly string[]
  /** Product version currently running on the fleet this proposal would update. */
  readonly proposalBaselineVersion?: (
    headSha: string,
  ) => string | undefined | Promise<string | undefined>
  readonly artifactToken: string
  readonly signingKey: string
  readonly setTarget: (target: UpdateTarget) => void
  /**
   * Retract the `dev` target and record a reason a client may be shown. Called
   * whenever this HEAD has no publishable bundle, so the read model never keeps
   * offering an older commit's.
   */
  readonly setTargetUnavailable?: (reason: string) => void
  /**
   * Ask the updates service to re-resolve `dev` from its feed, right now.
   *
   * The publisher no longer PUSHES a deliverable target; it writes a manifest
   * and asks the ordinary resolver to pull it. This is that ask — in-process,
   * because on a source host the publisher and the updater are the same process
   * (spec dispositions 19, 20).
   */
  readonly refreshDevTarget?: () => Promise<unknown>
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
        sourceCheckoutAvailable: true,
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
          void observeBundleReadiness()
        },
        prepareWebDist: async (headSha, explicit, buildRoot, releaseVersion) => {
          if (!webBuilder) return undefined
          const buildWeb =
            buildRoot === sourceRoot
              ? webBuilder
              : createDevWebBuilder({
                  root: buildRoot,
                  instanceId,
                  headSha: () => headSha,
                })
          const decision = decideWebDist({
            current: buildWeb.isCurrent(headSha, releaseVersion),
            explicit,
          })
          if (decision === 'ready') {
            return
          }
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
          try {
            await buildWeb.ensure(headSha, releaseVersion)
            return
          } catch (error) {
            throw new DevBundleUnavailableError(
              `development bundle unavailable: the web bundles could not be rebuilt for dev+${headSha}: ` +
                (error instanceof Error ? error.message : String(error)),
              `The website could not be rebuilt for HEAD (${headSha}), so dev+${headSha} cannot be packed.`,
            )
          }
        },
        artifactUrl: (version, platform) =>
          developmentArtifactUrl(
            selectDevelopmentArtifactOrigin({
              externalOrigin: artifactOrigin,
              localOrigin: deps.localArtifactOrigin(),
              hasRemoteManagedMachines: deps.hasRemoteManagedMachines(),
            }),
            version,
            deps.artifactToken,
            platform,
          ),
        // Read at BUILD time, not at wiring time: a machine that enrolls while this
        // server is running must be covered by the next build, and this server runs for
        // days at a time.
        fleetPlatforms: deps.fleetPlatforms,
        proposalBaselineVersion: deps.proposalBaselineVersion,
      })
    : undefined

  let unavailableDiagnostic: string | undefined
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
    log.warn('development bundle target unavailable', {
      diagnostic: error.message,
    })
  }

  /** Cache publisher readiness at lifecycle transitions; fleet polling must not spawn git. */
  const observeBundleReadiness = async () => {
    const readiness = await publisher?.readiness()
    bundleReady = readiness?.state === 'ready'
    bundleFailureDetail = readiness?.state === 'failed' ? readiness.publicReason : undefined
    return readiness
  }

  /**
   * PUBLISH, THEN HAND OFF (spec §6 step 4).
   *
   * Writing the manifest into the served feed IS the publication; nudging the
   * refresh is what makes this process notice it in seconds rather than at
   * tomorrow's tick. The publisher and the updater share one process on a source
   * host, which is why this is an in-process call and not a second protocol —
   * and why withdrawal and queued `nextTargets` stay internal events too
   * (dispositions 19 and 20).
   *
   * The nudge goes through the SAME `refreshTarget` the periodic tick calls, so
   * the two coalesce and the operation-active skip rule applies to both: a
   * publish landing mid-operation is queued as `nextTarget`, never spliced into
   * a running wave.
   */
  const publishToFeed = async (): Promise<boolean> => {
    if (!publisher) return false
    const published = await publisher.publishFeed()
    if (published) await deps.refreshDevTarget?.()
    return published
  }

  const approval = createReleaseApprovalFlow({
    proposal: async () => publisher?.proposal(),
    release: async (approved) => {
      if (!publisher) throw new Error('This server does not publish development releases.')
      const blocked = artifactOriginFailure()
      if (blocked) throw blocked
      publishFailureDetail = undefined
      headSha?.invalidate()
      try {
        await publisher.requestBuild(true, approved)
      } catch (error) {
        if (error instanceof DevBundleProposalMovedError) {
          throw new ReleaseApprovalRefusal(error.publicReason)
        }
        throw error
      }
      await observeBundleReadiness()
      publishedVersion = publisher.current()?.version
      if (!(await publishToFeed())) {
        throw new Error('the development feed manifest was not published')
      }
      unavailableDiagnostic = undefined
      publishFailureDetail = undefined
    },
    failureLogs: (error) =>
      publisher?.unavailable() ?? (error instanceof Error ? error.message : String(error)),
  })

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
    proposal: approval.read,
    approveRelease: async (approvedBy, expected) => {
      if (!publisher) {
        throw new DevBundleUnavailableError(
          'development release publishing is unavailable on an installed server',
          'This server does not publish development releases.',
        )
      }
      return approval.approve(approvedBy, expected)
    },
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
          publishedVersion = built?.version
          // The order is the handoff: write the manifest into the feed, then
          // ask the resolver to pull it. This legacy internal entry point is
          // intentionally not composed into update operations any more; only
          // proposal approval calls the release path above.
          await publishToFeed()
          return built
        },
        async (error: unknown) => {
          await observeBundleReadiness()
          // The failure must reach the read model, or a stale target stays
          // published while the only trace of the problem is this log line.
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
    channelFeed: () => {
      if (!publisher) return undefined
      let origin: string
      try {
        origin = selectDevelopmentArtifactOrigin({
          externalOrigin: artifactOrigin,
          localOrigin: deps.localArtifactOrigin(),
          hasRemoteManagedMachines: deps.hasRemoteManagedMachines(),
        })
      } catch {
        // The refusal is already reported through `requestBuild`/`preparation`;
        // here it just means there is no feed address to hand the resolver.
        return undefined
      }
      const base = `${origin}${DEV_FEED_ROUTE}/`
      return {
        manifestUrl: `${base}${DEV_FEED_MANIFEST}`,
        // The fence is this server's own feed prefix, so a manifest that named
        // a GitHub URL — or any other origin — is refused before a byte moves.
        artifactBase: base,
        // Signed by THIS instance's key, which every paired daemon pinned.
        trust: 'instance',
        headers: { authorization: `Bearer ${deps.artifactToken}` },
      }
    },
    registerRoute: (app) => {
      if (!publisher) return
      registerDevFeedRoutes(app, {
        publishedArtifact: (version, platform) => publisher.publishedArtifact(version, platform),
        manifestPath: () => publisher.feedManifestPath(),
        desktopManifestPath: () => publisher.desktopManifestPath(),
        /**
         * ONE CREDENTIAL, TWO WAYS TO PRESENT IT.
         *
         * A daemon fetches an artifact URL taken straight out of the manifest,
         * so its token has to live in the query string — it has no place to put
         * a header. The RESOLVER is ordinary code making an ordinary fetch, so
         * it sends the header, which keeps the credential out of request logs
         * and out of the manifest URL an operator might paste somewhere.
         *
         * Both are the same token and the same authority; accepting only one
         * would mean minting a second credential for no reason.
         */
        authenticate: (request) => {
          const bearer = request.headers.get('authorization')
          if (bearer === `Bearer ${deps.artifactToken}`) return true
          return new URL(request.url).searchParams.get('token') === deps.artifactToken
        },
      })
    },
  }
}
