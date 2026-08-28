import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type PeerBuild, wireSchemaDigest } from '@podium/protocol'
import { ARTIFACT_PROBE_CAPABILITY, SHIPPING_TRAIN_CAPABILITY } from '@podium/protocol/daemon'
import { developmentSourceVersion } from '@podium/runtime/source-version'

const DEVELOPMENT_SOURCE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * WHETHER A DESKTOP APP SUPERVISES THIS DAEMON'S PROCESS.
 *
 * Podium Desktop exports `PODIUM_DESKTOP_SUPERVISED=1` into the sidecar it
 * spawns (`apps/desktop/src-tauri/src/main.rs`). The flag now describes crash
 * ownership only: payload bytes live outside the signed frame and take ordinary
 * fleet grants. It remains on the report for topology and older-server compatibility.
 *
 * `=== '1'` exactly, matching every other reader of this flag
 * (`resolveLoggingMode`, `role-reconcile`, `server-transfer/lifecycle`).
 */
export function isDesktopSupervised(env: NodeJS.ProcessEnv): boolean {
  return env.PODIUM_DESKTOP_SUPERVISED === '1'
}

export function buildReport(
  env: NodeJS.ProcessEnv,
  installDir: string | undefined,
  sourceVersion?: string,
): PeerBuild {
  const supervised = isDesktopSupervised(env)
  return {
    appVersion:
      env.PODIUM_APP_VERSION ??
      // Must stay a literal `process.env.PODIUM_APP_VERSION` read: build-bun's
      // --define replaces this expression with the release baked into the binary.
      process.env.PODIUM_APP_VERSION ??
      (installDir ? 'dev' : (sourceVersion ?? developmentSourceVersion(DEVELOPMENT_SOURCE_ROOT))),
    wireSchemaDigest: wireSchemaDigest(),
    installKind: installDir ? 'installed' : 'source',
    // Additive and only ever present when true: absent is the reading every
    // server old and new already gives an unsupervised daemon.
    ...(supervised ? { supervised: true } : {}),
  }
}

export interface DaemonBootBuild {
  build: PeerBuild
  installDir: string | undefined
}

/** Capture one build identity before daemon boot or reconnect work can move the checkout. */
export function captureDaemonBootBuild(
  env: NodeJS.ProcessEnv,
  execPath: string,
  sourceRoot: string = DEVELOPMENT_SOURCE_ROOT,
): DaemonBootBuild {
  const installDir =
    env.PODIUM_HOME ??
    (/(?:^|[\\/])podium(?:-cli)?$/.test(execPath) ? dirname(execPath) : undefined)
  const sourceVersion =
    installDir || env.PODIUM_APP_VERSION || process.env.PODIUM_APP_VERSION
      ? undefined
      : developmentSourceVersion(sourceRoot)
  return { build: buildReport(env, installDir, sourceVersion), installDir }
}

/**
 * WHAT THIS DAEMON CAN TAKE DELIVERY OF — the caps it offers at handshake AND
 * the caps its own convergence planner is given.
 *
 * Desktop supervision now describes crash ownership only. Its installed payload
 * lives outside the signed frame, so a supervised daemon offers the same feed
 * delivery capability as every other installed fleet machine (spec §2.2).
 *
 *
 * A SOURCE DAEMON OFFERS NO DELIVERY EITHER, and for the same first-person
 * reason (spec §1, disposition 5). It used to offer `update.delivery.git`,
 * which meant "move my checkout to that sha" — a delivery kind that has now
 * been retired, because exactly one machine still runs from source (the
 * publisher) and it is not a fleet consumer. A source daemon has no install
 * directory, so a feed artifact is bytes it could verify and then have nowhere
 * to put; `swapHeadlessBundle` would throw at the last possible moment, after
 * a quarter-gigabyte download. Reporting no delivery cap prevents accidental
 * transport, while the explicit source install kind lets rollout planning omit
 * it as a non-target rather than misreporting it as behind.
 *
 * It keeps {@link SHIPPING_TRAIN_CAPABILITY}, which is not about delivery: the
 * cap set is open and additive, and stripping an unrelated capability would be
 * a second, unannounced change.
 */
export function deliveryCaps(build: Pick<PeerBuild, 'installKind' | 'supervised'>): string[] {
  return build.installKind === 'source'
    ? [SHIPPING_TRAIN_CAPABILITY]
    : ['update.delivery.feed', ARTIFACT_PROBE_CAPABILITY, SHIPPING_TRAIN_CAPABILITY]
}
