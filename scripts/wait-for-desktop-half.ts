/**
 * THE SERVER HALF OF A RELEASE WAITS FOR ITS APP HALF (POD-5969).
 *
 * One version tag starts two workflows: `release.yml` publishes the headless server bundles in
 * about ten minutes, `desktop-release.yml` builds and notarizes the desktop app in about thirty.
 * Each used to publish the moment it was done, so for twenty minutes a channel advertised a
 * server whose app did not exist yet — and if the app build failed, the server stayed published
 * without it. When a tag carries no new app the desktop half skips every build and there is
 * nothing to wait for; that common case is unchanged.
 *
 * When the tag does build an app, the headless publish step runs this first:
 *
 *   - edge: wait until the desktop half has PUBLISHED. The rolling `edge` release already exists,
 *     so the app lands first and the server last, and the headless carry-forward then reads the
 *     new `latest.json` instead of re-uploading the old one.
 *   - stable: wait until every required app build has SUCCEEDED. The desktop half uploads into
 *     the `vX.Y.Z` release the headless half creates, so waiting for its publish would deadlock;
 *     the app follows the server within about a minute.
 *
 * Either way a failed required build fails this step, so nothing half-built is published.
 * Experimental legs (Windows) never gate the release, exactly as in the desktop workflow.
 */
import { execFileSync } from 'node:child_process'

export type ReleaseChannel = 'edge' | 'stable'

/** One job of the desktop run, as `gh run view --json jobs` reports it. */
export interface DesktopJob {
  name: string
  status: string
  conclusion: string | null
}

export type DesktopHalfVerdict =
  | { kind: 'wait'; why: string }
  | { kind: 'proceed'; why: string }
  | { kind: 'fail'; why: string }

/**
 * Matrix targets marked `experimental` in desktop-release.yml. A failed or unfinished leg for one
 * of these never holds the release; `desktop-release-workflow.test.ts` keeps this list equal to
 * the workflow's flags.
 */
export const EXPERIMENTAL_DESKTOP_TARGETS: readonly string[] = ['windows-x86_64']

const isBuildJob = (job: DesktopJob): boolean =>
  job.name === 'build' || job.name.startsWith('build (')
const isExperimental = (job: DesktopJob): boolean =>
  EXPERIMENTAL_DESKTOP_TARGETS.some((target) => job.name.includes(`(${target},`))

/** What the headless half should do, given the desktop half's jobs right now. */
export function desktopHalfVerdict(
  jobs: readonly DesktopJob[],
  channel: ReleaseChannel,
): DesktopHalfVerdict {
  const validate = jobs.find((job) => job.name === 'validate')
  if (!validate || validate.status !== 'completed') {
    return { kind: 'wait', why: 'the desktop half has not decided whether it builds an app' }
  }
  if (validate.conclusion !== 'success') {
    return { kind: 'fail', why: `the desktop half's validation ended ${validate.conclusion}` }
  }

  const builds = jobs.filter(isBuildJob)
  if (builds.length === 0) {
    return { kind: 'wait', why: 'the desktop builds have not been scheduled yet' }
  }
  if (builds.every((job) => job.status === 'completed' && job.conclusion === 'skipped')) {
    return { kind: 'proceed', why: 'this tag builds no new app; the standing one is carried' }
  }

  for (const job of builds.filter((candidate) => !isExperimental(candidate))) {
    if (job.status !== 'completed') return { kind: 'wait', why: `${job.name} is still building` }
    if (job.conclusion !== 'success') {
      return { kind: 'fail', why: `${job.name} ended ${job.conclusion}; nothing is published` }
    }
  }
  if (channel === 'stable') {
    return { kind: 'proceed', why: 'every required app build succeeded' }
  }

  const publish = jobs.find((job) => job.name === 'publish')
  if (!publish || publish.status !== 'completed') {
    return { kind: 'wait', why: 'the new app is being published' }
  }
  if (publish.conclusion !== 'success') {
    return {
      kind: 'fail',
      why: `the app publish ended ${publish.conclusion}; nothing is published`,
    }
  }
  return { kind: 'proceed', why: 'the new app is published' }
}

/** The desktop run started by the same tag push, if GitHub lists it yet. */
export function pairedDesktopRun(
  runs: readonly { databaseId: number; headBranch: string; headSha: string }[],
  tag: string,
  sha: string,
): number | undefined {
  return runs.find((run) => run.headBranch === tag && run.headSha === sha)?.databaseId
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

async function main(): Promise<void> {
  const channel = process.env.PODIUM_RELEASE_CHANNEL
  const tag = process.env.GITHUB_REF_NAME ?? ''
  const sha = process.env.GITHUB_SHA ?? ''
  // A dispatched headless publish has no desktop run paired with it.
  if (process.env.GITHUB_EVENT_NAME !== 'push') {
    console.log('[desktop-half] not a tag push; nothing to wait for')
    return
  }
  if (channel !== 'edge' && channel !== 'stable') {
    throw new Error(`[desktop-half] unexpected channel '${channel}' for a tag push`)
  }
  const intervalMs = Number(process.env.PODIUM_DESKTOP_WAIT_INTERVAL_MS ?? 30_000)
  const deadline = Date.now() + Number(process.env.PODIUM_DESKTOP_WAIT_TIMEOUT_MS ?? 90 * 60_000)
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  let runId: number | undefined
  let last = ''
  while (Date.now() < deadline) {
    if (runId === undefined) {
      const runs = JSON.parse(
        gh([
          'run',
          'list',
          '--workflow',
          'desktop-release.yml',
          '--event',
          'push',
          '--limit',
          '50',
          '--json',
          'databaseId,headBranch,headSha',
        ]),
      )
      runId = pairedDesktopRun(runs, tag, sha)
      if (runId === undefined) {
        console.log(`[desktop-half] no desktop run for ${tag} yet`)
        await sleep(intervalMs)
        continue
      }
      console.log(`[desktop-half] desktop run ${runId} for ${tag}`)
    }
    const { jobs } = JSON.parse(gh(['run', 'view', String(runId), '--json', 'jobs'])) as {
      jobs: DesktopJob[]
    }
    const verdict = desktopHalfVerdict(jobs, channel)
    if (verdict.why !== last) console.log(`[desktop-half] ${verdict.kind}: ${verdict.why}`)
    last = verdict.why
    if (verdict.kind === 'proceed') return
    if (verdict.kind === 'fail') throw new Error(`[desktop-half] ${verdict.why}`)
    await sleep(intervalMs)
  }
  throw new Error(`[desktop-half] gave up waiting for the desktop half of ${tag}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
