/**
 * Parallel gzip (pigz) for the release tarballs [POD-3161].
 *
 * GNU tar's `-z` is a single gzip stream, so archiving used one core while the build's
 * transient scope is granted two (CPUQuota=200% — apps/server/src/modules/updates/build-scope.ts).
 * pigz splits the deflate work across threads: measured inside that same cgroup shape on the
 * dev.30 linux-x86_64 bundle (157MB in, 60.3MB out), gzip averaged 8.80s against 3.88s for
 * `pigz -n -p2` — 2.27x.
 *
 * THREADS ARE PINNED TO THE QUOTA. Default pigz (-p8 on this box) oversubscribes the 200% cap
 * and measured SLOWER than -p2 (8.35s vs 7.02s). The quota, not pigz, is the binding constraint,
 * and raising it is not on the table: capping the build is the deliberate POD-1966 decision that
 * a build must not slow the box. Hence an explicit -p2.
 *
 * NOT BYTE-IDENTICAL TO GZIP. `pigz -n` output is deterministic and independent of the thread
 * count (sha256 equal at -p1/-p2/-p4/-p8), and a `pigz -n` tarball extracts with plain `tar -xzf`
 * to byte-identical contents — but its bytes differ from gzip's on the same tar stream. That is
 * fine today because each release signs whatever bytes it produced. If archive normalisation or
 * reproducible artifacts is ever adopted, pigz must become a hard REQUIREMENT rather than the
 * optional accelerator it is here, or the same input would sign differently on two hosts.
 */
import { spawnSync } from 'node:child_process'

/** Threads pinned to the build scope's CPUQuota=200%. See the note above before changing. */
export const PIGZ_THREADS = 2

/** Candidate pigz paths tried after PODIUM_PIGZ and a bare `pigz` on PATH. */
const PIGZ_FALLBACK_PATHS = ['/usr/bin/pigz', '/usr/local/bin/pigz', '/opt/homebrew/bin/pigz']

/** Injectable seam: does `candidate` actually RUN? Replaced in tests to simulate a host without pigz. */
export type PigzDeps = { probe: (candidate: string) => boolean }

const defaultDeps: PigzDeps = {
  probe: (candidate) => spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0,
}

/**
 * Locate a pigz that RUNS: PODIUM_PIGZ, then PATH, then the usual install prefixes. Unlike
 * `resolveZig`/`resolveRcodesign` in scripts/abduco-cross.ts this returns undefined instead of
 * throwing — pigz is an optimisation, not a prerequisite, and a host without it still produces
 * a valid signed bundle through plain gzip.
 *
 * EVERY candidate is probed, the configured one included. Those resolvers take the env var on
 * trust because their tool is mandatory and a mistyped path SHOULD fail loudly; here the
 * opposite holds. `tar --use-compress-program=/nonexistent/pigz` exits 2 ("Child returned
 * status 127"), so trusting a stale PODIUM_PIGZ would break every release with the one thing
 * that is only ever meant to make them faster. Same reason existsSync is not enough: a file
 * that exists but does not execute must fall through to gzip.
 */
export function resolvePigz(deps: PigzDeps = defaultDeps): string | undefined {
  const configured = process.env.PODIUM_PIGZ?.trim()
  for (const candidate of [...(configured ? [configured] : []), 'pigz', ...PIGZ_FALLBACK_PATHS]) {
    if (deps.probe(candidate)) return candidate
  }
  return undefined
}

/**
 * `tar` arguments that compress `-C cwd entry` into `tarball`, using pigz when one is available
 * and gzip otherwise. `--use-compress-program` hands the whole tar stream to pigz on stdout.
 */
export function tarCompressArgs(
  tarball: string,
  parentDir: string,
  entry: string,
  pigz: string | undefined,
): string[] {
  const compress = pigz ? [`--use-compress-program=${pigz} -n -p${PIGZ_THREADS}`, '-cf'] : ['-czf']
  return [...compress, tarball, '-C', parentDir, entry]
}
