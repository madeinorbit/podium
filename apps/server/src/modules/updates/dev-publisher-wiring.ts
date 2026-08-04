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
 */
import type { Hono } from 'hono'
import type { UpdateTarget } from '@podium/protocol'
import { registerDevArtifactRoute } from './artifact-route'
import { createDevBundlePublisher, developmentHeadSha } from './dev-bundle'

export interface DevPublisherWiring {
  /** Publish the current development target, if there is one. */
  readonly publishTarget: () => UpdateTarget | undefined
  /**
   * Ask for a build. Fire-and-forget by design: `/version` calls this on a hot
   * path and must never block on a `bun build --compile`, nor fail because one
   * did. `explicit` bypasses the debounce for a human-initiated request.
   */
  readonly requestBuild: (explicit: boolean) => void
  /** Mount the authenticated artifact route, when a publisher exists. */
  readonly registerRoute: (app: Hono) => void
  /** True when this server can publish a development bundle at all. */
  readonly enabled: boolean
}

export function wireDevBundlePublisher(deps: {
  /** Absent (an installed server) disables the whole thing. */
  readonly sourceRoot: string | undefined
  /** Read lazily: the port is not known until the listener binds. */
  readonly port: () => number
  readonly artifactToken: string
  readonly signingKey: string
  readonly setTarget: (target: UpdateTarget) => void
  readonly env?: NodeJS.ProcessEnv
}): DevPublisherWiring {
  const env = deps.env ?? process.env
  const publisher = deps.sourceRoot
    ? createDevBundlePublisher({
        isSourceRun: true,
        root: deps.sourceRoot,
        headSha: () => developmentHeadSha(deps.sourceRoot as string),
        signingKey: deps.signingKey,
        artifactUrl: (version) => {
          const base = (
            env.PODIUM_DEV_ARTIFACT_BASE_URL ?? 'http://127.0.0.1:' + deps.port()
          ).replace(/\/$/, '')
          return `${base}/updates/dev-bundle/${encodeURIComponent(version)}?token=${encodeURIComponent(deps.artifactToken)}`
        },
      })
    : undefined

  const publishTarget = (): UpdateTarget | undefined => {
    const target = publisher?.target()
    if (target) deps.setTarget(target)
    return target
  }

  return {
    enabled: publisher !== undefined,
    publishTarget,
    requestBuild: (explicit) => {
      if (!publisher) return
      void publisher
        .requestBuild(explicit)
        .then(() => publishTarget())
        .catch((error) => {
          console.warn('[podium] development bundle build failed:', error)
        })
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
