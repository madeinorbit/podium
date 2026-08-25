/**
 * THE STANDING DESKTOP SHELL REFERENCE SURVIVES A PUBLISH, OR THE PUBLISH STOPS (POD-2796).
 *
 * A headless release and a desktop shell are minted by two different workflows on
 * two different cadences. Most headless releases build no shell at all, so the
 * publish job carries the PREVIOUS release's `latest.json` (and the
 * `desktop-shell-input.sha256` that says which shell inputs produced it) onto the
 * release it is about to cut. That carry-forward is what keeps installed desktop
 * apps pointed at a shell they can still fetch.
 *
 * It used to be a loop of `gh release download … || true`. One silent catch held
 * two outcomes that have nothing to do with each other:
 *
 *   - THE BENIGN ONE. A channel with no previous release, or a standing release
 *     that never carried a desktop reference in the first place. There is nothing
 *     to carry, and the release should ship.
 *
 *   - THE ONE THIS MODULE EXISTS FOR. GitHub unreachable, the token rejected,
 *     a 5xx, `gh` itself falling over. The asset EXISTS and we simply failed to
 *     fetch it.
 *
 * The second one is silent and it is expensive. `scripts/release.ts` only asks
 * `existsSync('latest.json')`, so an unfetched manifest is indistinguishable from
 * a deliberate one, and a stable cut is a BRAND-NEW release: nothing carried
 * means the new release has no `latest.json`, and
 * `releases/latest/download/latest.json` — the endpoint baked into every desktop
 * shell already installed — starts returning 404. Every installed app quietly
 * stops being offered a shell update. Nothing errors, nothing looks wrong, and
 * the people affected see only that no update is available.
 *
 * Publishing a release is one act. If a step of it cannot complete, the honest
 * outcome is that the release does not ship. So the rule here is:
 *
 *   ask what the standing release actually holds, ONCE, and let only a clean
 *   404 mean "nothing to carry". Every other answer stops the publish, naming
 *   this step.
 *
 * ---------------------------------------------------------------------------
 * WHY A MISSING ASSET IS NOT A FAILURE, AND WHY THAT IS NOT A LOOPHOLE
 * ---------------------------------------------------------------------------
 *
 * Measured against github.com: the standing stable release (v0.1.0) lists
 * `latest.json` and does NOT list `desktop-shell-input.sha256`. A rule that
 * called any missing asset fatal would refuse every stable cut. So the asset list
 * is read from the release itself and only the assets it genuinely lists are
 * fetched — which also means a fetch that then fails is unambiguous, because we
 * already know the bytes are there.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It never SYNTHESISES a manifest. POD-2794 established why: restamping
 * `latest.json` at the headless version satisfies the old pairing rule while
 * offering every installed shell bytes that still report the old version after
 * installing — a silent headless stranding traded for a desktop update loop.
 * This module carries bytes that already exist or it stops; it never invents any.
 *
 * It also does not decide whether a release with NO desktop manifest may ship.
 * That is POD-2794's refusal in `scripts/release.ts`, which reads what was staged
 * and speaks for the installs that would be stranded. This step's only claim is
 * the narrower one: what the standing release holds is what got staged, or the
 * run stopped and said which step failed.
 *
 * ---------------------------------------------------------------------------
 * THE `gh` SHAPES BELOW WERE MEASURED, NOT READ (gh 2.89.0, github.com)
 * ---------------------------------------------------------------------------
 *
 *   present  → exit 0, the release JSON on stdout
 *   404      → exit 1, `{"message":"Not Found",…,"status":"404"}` on stdout and
 *              `gh: Not Found (HTTP 404)` on stderr
 *   no host  → exit 1, empty stdout, `error connecting to …` on stderr
 *
 * The classifier keys on the `(HTTP 404)` marker and treats everything it does
 * not recognise as a failure. That direction matters: an unrecognised shape must
 * fail the publish, never be waved through as an empty channel.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** The two assets that together are the standing desktop shell reference. */
export const CARRIED_ASSETS = ['latest.json', 'desktop-shell-input.sha256'] as const

/** Named in every refusal, so a failed release says which step failed. */
export const CARRY_FORWARD_STEP = 'carry forward the standing desktop shell reference'

export type ReleaseChannel = 'stable' | 'edge'

/**
 * Where a channel's standing reference is read from — the SAME release the
 * installed shells on that channel read.
 *
 * Stable shells fetch `releases/latest/download/latest.json`, so the source is
 * `releases/latest` and never a tag we picked ourselves; edge is republished in
 * place onto the fixed `edge` tag.
 */
export function sourceReleaseEndpoint(channel: ReleaseChannel): string {
  return channel === 'stable' ? 'releases/latest' : 'releases/tags/edge'
}

export type SourceRelease =
  | { kind: 'present'; tag: string; assets: readonly string[] }
  | { kind: 'none' }
  | { kind: 'unreadable'; detail: string }

/** Turns one `gh api` result into the three outcomes, failing closed on anything else. */
export function classifyProbe(p: {
  status: number
  stdout: string
  stderr: string
}): SourceRelease {
  if (p.status === 0) {
    try {
      const parsed: unknown = JSON.parse(p.stdout)
      const tag = (parsed as { tag_name?: unknown }).tag_name
      const assets = (parsed as { assets?: unknown }).assets
      if (typeof tag !== 'string' || tag.length === 0 || !Array.isArray(assets)) {
        return { kind: 'unreadable', detail: 'the release JSON named no tag_name and assets' }
      }
      const names = assets
        .map((asset) => (asset as { name?: unknown }).name)
        .filter((name): name is string => typeof name === 'string')
      return { kind: 'present', tag, assets: names }
    } catch (error) {
      return {
        kind: 'unreadable',
        detail: `gh exited 0 but its output could not be parsed as a release (${String(error)})`,
      }
    }
  }
  if (/\(HTTP 404\)/.test(p.stderr)) return { kind: 'none' }
  const detail = (p.stderr.trim() || p.stdout.trim() || `gh exited ${p.status}`).replace(
    /\s+$/,
    '',
  )
  return { kind: 'unreadable', detail }
}

export type CarryPlan =
  | { kind: 'carry'; tag: string; carry: string[]; absent: string[]; note: string }
  | { kind: 'nothing'; note: string }
  | { kind: 'refuse'; message: string }

/** The refusal text — one sentence on what failed, one on what it would have cost. */
export function carryForwardRefusal(p: { channel: ReleaseChannel; detail: string }): string {
  return (
    `${CARRY_FORWARD_STEP} failed on the ${p.channel} channel: ${p.detail}. ` +
    `Refusing to continue: publishing from here would cut a release with no desktop ` +
    `manifest, and every installed shell would quietly stop being offered an update ` +
    `while this run reported success. Re-run once ${p.channel}'s ` +
    `${sourceReleaseEndpoint(p.channel)} can be read.`
  )
}

export function carryForwardPlan(p: {
  channel: ReleaseChannel
  source: SourceRelease
}): CarryPlan {
  if (p.source.kind === 'unreadable') {
    return { kind: 'refuse', message: carryForwardRefusal({ ...p, detail: p.source.detail }) }
  }
  if (p.source.kind === 'none') {
    return {
      kind: 'nothing',
      note:
        `no previous release on the ${p.channel} channel (${sourceReleaseEndpoint(p.channel)} ` +
        `is a 404), so there is no standing desktop shell reference to carry forward`,
    }
  }
  const listed = new Set(p.source.assets)
  const carry = CARRIED_ASSETS.filter((asset) => listed.has(asset))
  const absent = CARRIED_ASSETS.filter((asset) => !listed.has(asset))
  if (carry.length === 0) {
    return {
      kind: 'nothing',
      note:
        `the standing ${p.channel} release ${p.source.tag} lists neither ` +
        `${CARRIED_ASSETS.join(' nor ')}, so there is no standing desktop shell ` +
        `reference to carry forward`,
    }
  }
  return {
    kind: 'carry',
    tag: p.source.tag,
    carry: [...carry],
    absent: [...absent],
    note:
      `carrying ${carry.join(', ')} forward from ${p.source.tag}` +
      (absent.length > 0 ? `; ${absent.join(', ')} is not on that release` : ''),
  }
}

function gh(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('gh', [...args], { encoding: 'utf8' })
  if (result.error) {
    return { status: 127, stdout: '', stderr: `could not run gh: ${result.error.message}` }
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function main(): void {
  const channel = arg('--channel')
  if (channel !== 'stable' && channel !== 'edge') {
    throw new Error(`--channel must be stable or edge, got ${channel ?? '(nothing)'}`)
  }
  const dir = arg('--dir')
  if (!dir) throw new Error('--dir is required — where the release assets are staged')
  const repo = arg('--repo') ?? process.env.GITHUB_REPOSITORY ?? 'madeinorbit/podium'

  const plan = carryForwardPlan({
    channel,
    source: classifyProbe(gh(['api', `repos/${repo}/${sourceReleaseEndpoint(channel)}`])),
  })
  if (plan.kind === 'refuse') {
    console.error(`[carry-forward] ${plan.message}`)
    process.exitCode = 1
    return
  }
  if (plan.kind === 'nothing') {
    console.log(`[carry-forward] ${plan.note}`)
    return
  }

  mkdirSync(dir, { recursive: true })
  console.log(`[carry-forward] ${plan.note}`)
  for (const asset of plan.carry) {
    const result = gh([
      'release',
      'download',
      plan.tag,
      '--pattern',
      asset,
      '--dir',
      dir,
      '--clobber',
    ])
    // The release LISTED this asset, so a failure here is a failure to fetch bytes
    // that exist — never "there was nothing to carry".
    if (result.status !== 0) {
      console.error(
        `[carry-forward] ${carryForwardRefusal({
          channel,
          detail: `${plan.tag} lists ${asset} but downloading it failed (${
            result.stderr.trim() || `gh exited ${result.status}`
          })`,
        })}`,
      )
      process.exitCode = 1
      return
    }
    // A zero exit that left no file is the same silent hole one layer down: the
    // publisher only asks whether the file is there.
    if (!existsSync(join(dir, asset))) {
      console.error(
        `[carry-forward] ${carryForwardRefusal({
          channel,
          detail: `gh reported success downloading ${asset} from ${plan.tag} but wrote no ${join(dir, asset)}`,
        })}`,
      )
      process.exitCode = 1
      return
    }
    console.log(`[carry-forward] carried ${asset} from ${plan.tag}`)
  }
}

if (import.meta.main) main()
