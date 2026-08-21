import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type PeerBuild, wireSchemaDigest } from '@podium/protocol'
import { SHIPPING_TRAIN_CAPABILITY } from '@podium/protocol/daemon'
import { developmentSourceVersion } from '@podium/runtime/source-version'

const DEVELOPMENT_SOURCE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * WHETHER A DESKTOP APP OWNS THIS DAEMON'S BYTES.
 *
 * Podium Desktop exports `PODIUM_DESKTOP_SUPERVISED=1` into the sidecar it
 * spawns (`apps/desktop/src-tauri/src/main.rs`). Such a daemon is part of a
 * signed application bundle: on the macOS all-in-one it runs IN PLACE inside
 * `Podium.app`, so a bundle swap would rename directories inside the signature;
 * on Linux the sidecar is copied to `~/.podium/bin`, where it looks like an
 * ordinary source or installed run and nothing would stop a wave from moving it.
 * Either way the shell update — never a fleet wave — is what updates it (P5).
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
 * A SUPERVISED DAEMON OFFERS NOTHING. That is belt and braces rather than the
 * primary guard (the server's wave filter is, {@link
 * apps/server/src/modules/updates/wave.ts}): a server that predates `supervised`
 * still issues a grant, and this is what makes the grant a no-op instead of a
 * bundle swap inside a signed .app — `planConvergence` answers `cannot:
 * unsupported-delivery` for an empty cap set, so the daemon refuses it itself.
 *
 * Note the asymmetry with the SERVER's reading of an empty cap list: there,
 * empty means "never reported" and is permissive on purpose (an old daemon must
 * not be stranded). Here, empty is a first-person refusal, and the daemon is the
 * only party that can make it fail closed.
 *
 * A SOURCE DAEMON OFFERS NO DELIVERY EITHER, and for the same first-person
 * reason (spec §1, disposition 5). It used to offer `update.delivery.git`,
 * which meant "move my checkout to that sha" — a delivery kind that has now
 * been retired, because exactly one machine still runs from source (the
 * publisher) and it is not a fleet consumer. A source daemon has no install
 * directory, so a feed artifact is bytes it could verify and then have nowhere
 * to put; `swapHeadlessBundle` would throw at the last possible moment, after
 * a quarter-gigabyte download. Reporting no delivery cap makes the fleet's
 * planner skip it and leaves it honestly `behind` instead — the same outcome
 * the wave filter already documented for a git-only machine offered a tarball.
 *
 * It keeps {@link SHIPPING_TRAIN_CAPABILITY}, which is not about delivery: the
 * cap set is open and additive, and stripping an unrelated capability would be
 * a second, unannounced change.
 */
export function deliveryCaps(build: Pick<PeerBuild, 'installKind' | 'supervised'>): string[] {
  if (build.supervised === true) return []
  return build.installKind === 'source'
    ? [SHIPPING_TRAIN_CAPABILITY]
    : ['update.delivery.feed', SHIPPING_TRAIN_CAPABILITY]
}
