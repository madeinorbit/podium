// scripts/carry-forward-desktop-manifest.test.ts
//
// POD-2796 — the standing desktop shell reference must survive a publish, or the
// publish must stop.
//
// The step this covers used to end every `gh release download` with `|| true`, so
// one silent catch held two completely different outcomes: "this channel has no
// previous release, there is genuinely nothing to carry" and "GitHub could not be
// reached / the token was rejected / gh fell over". The second one ships a stable
// release with no `latest.json`, and `releases/latest/download/latest.json` is the
// endpoint baked into every desktop shell already installed. Nothing errors; the
// fleet simply stops being offered updates.
//
// Two properties carry the fix and both are asserted against BEHAVIOUR:
//
//   1. THE BENIGN CASE STILL SHIPS, AND SAYS SO. A first release on a channel, and
//      a standing release that lists no desktop reference at all, both exit 0 with
//      a line naming what was not carried. Today's real stable release lists
//      `latest.json` and no `desktop-shell-input.sha256` — a rule that called a
//      missing asset fatal would refuse every stable cut, so that arm is pinned.
//
//   2. EVERY OTHER OUTCOME STOPS THE PUBLISH, NAMING THIS STEP. Proven by running
//      the real script against a `gh` that fails the way a real one fails — the
//      shapes below were measured against github.com with gh 2.89.0, not read.
//
// The armedness of (2) is the load-bearing assertion: a step that cannot say no is
// exactly the step this issue is about.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CARRIED_ASSETS,
  CARRY_FORWARD_STEP,
  carryForwardPlan,
  classifyProbe,
  sourceReleaseEndpoint,
} from './carry-forward-desktop-manifest'

const repoRoot = join(__dirname, '..')
const script = join(repoRoot, 'scripts', 'carry-forward-desktop-manifest.ts')
const headlessWorkflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')

const scratch: string[] = []
afterAll(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pod2796-${prefix}-`))
  scratch.push(dir)
  return dir
}

/**
 * The three `gh api` outcomes, MEASURED against github.com with gh 2.89.0 rather
 * than quoted from documentation. A classifier tuned to prose that gh does not
 * actually print would send every failure down the benign arm — the bug again,
 * one layer in.
 */
const MEASURED = {
  present: {
    status: 0,
    stdout: JSON.stringify({
      tag_name: 'v0.1.0',
      assets: [{ name: 'latest.json' }, { name: 'SHA256SUMS' }],
    }),
    stderr: '',
  },
  notFound: {
    status: 1,
    stdout:
      '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/releases/releases#get-a-release-by-tag-name","status":"404"}',
    stderr: 'gh: Not Found (HTTP 404)\n',
  },
  unreachable: {
    status: 1,
    stdout: '',
    stderr: 'error connecting to nope.invalid\ncheck your internet connection or https://githubstatus.com\n',
  },
} as const

describe('classifying what GitHub said about the standing release', () => {
  it('reads the tag and the asset list off a release that exists', () => {
    expect(classifyProbe(MEASURED.present)).toEqual({
      kind: 'present',
      tag: 'v0.1.0',
      assets: ['latest.json', 'SHA256SUMS'],
    })
  })

  it('calls a 404 what it is — this channel has no previous release', () => {
    expect(classifyProbe(MEASURED.notFound)).toEqual({ kind: 'none' })
  })

  it('refuses to read an unreachable host as an empty channel', () => {
    const outcome = classifyProbe(MEASURED.unreachable)
    expect(outcome.kind).toBe('unreadable')
    expect(outcome.kind === 'unreadable' && outcome.detail).toContain('error connecting')
  })

  it('fails closed on a 5xx, which names no 404 anywhere', () => {
    expect(
      classifyProbe({ status: 1, stdout: '', stderr: 'gh: Server Error (HTTP 500)\n' }).kind,
    ).toBe('unreadable')
  })

  // A success whose body cannot be parsed is not a success: believing it would
  // carry an empty asset list forward and call the manifest absent.
  it('fails closed when a zero exit carries a body it cannot parse', () => {
    expect(classifyProbe({ status: 0, stdout: 'not json at all', stderr: '' }).kind).toBe(
      'unreadable',
    )
  })
})

describe('what the publish then does about it', () => {
  it('carries the assets the standing release actually lists, and names the ones it does not', () => {
    // Today's real stable release: latest.json present, desktop-shell-input.sha256 absent.
    const plan = carryForwardPlan({
      channel: 'stable',
      source: { kind: 'present', tag: 'v0.1.0', assets: ['latest.json', 'SHA256SUMS'] },
    })
    expect(plan.kind).toBe('carry')
    if (plan.kind !== 'carry') return
    expect(plan.carry).toEqual(['latest.json'])
    expect(plan.absent).toEqual(['desktop-shell-input.sha256'])
    expect(plan.tag).toBe('v0.1.0')
    expect(plan.note).toContain('desktop-shell-input.sha256')
  })

  it('still ships a first release on a channel, and says nothing was there to carry', () => {
    const plan = carryForwardPlan({ channel: 'edge', source: { kind: 'none' } })
    expect(plan.kind).toBe('nothing')
    if (plan.kind !== 'nothing') return
    expect(plan.note).toMatch(/no previous release/i)
  })

  it('ships a standing release that lists no desktop reference, and says which', () => {
    const plan = carryForwardPlan({
      channel: 'edge',
      source: { kind: 'present', tag: 'edge', assets: ['podium-update.json'] },
    })
    expect(plan.kind).toBe('nothing')
    if (plan.kind !== 'nothing') return
    expect(plan.note).toContain('latest.json')
  })

  it('refuses when GitHub could not be read, naming the step and the reason', () => {
    const plan = carryForwardPlan({
      channel: 'stable',
      source: { kind: 'unreadable', detail: 'error connecting to api.github.com' },
    })
    expect(plan.kind).toBe('refuse')
    if (plan.kind !== 'refuse') return
    expect(plan.message).toContain(CARRY_FORWARD_STEP)
    expect(plan.message).toContain('error connecting to api.github.com')
  })

  it('reads stable through the same endpoint the shipped shells read', () => {
    // Installed stable shells fetch releases/latest/download/latest.json, so the
    // standing reference must be taken from releases/latest and nothing else.
    expect(sourceReleaseEndpoint('stable')).toBe('releases/latest')
    expect(sourceReleaseEndpoint('edge')).toBe('releases/tags/edge')
  })
})

/**
 * The end-to-end arm. A `gh` on PATH that behaves the way the measured shapes say
 * a real one behaves, so these assertions are about the script CI will run.
 */
function ghShim(behaviour: {
  api: 'present' | 'notFound' | 'unreachable'
  assets?: readonly string[]
  download?: 'ok' | 'fail' | 'writes-nothing'
}): string {
  const bin = tmp('bin')
  const body = JSON.stringify({
    tag_name: 'edge',
    assets: (behaviour.assets ?? ['latest.json']).map((name) => ({ name })),
  })
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
if [ "$1" = api ]; then
  case "${behaviour.api}" in
    present) printf '%s' ${JSON.stringify(body)}; exit 0 ;;
    notFound) printf '%s' '{"message":"Not Found","status":"404"}'; echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
    *) echo 'error connecting to api.github.com' >&2; exit 1 ;;
  esac
fi
if [ "$1" = release ] && [ "$2" = download ]; then
  case "${behaviour.download ?? 'ok'}" in
    ok)
      dir=""; pattern=""
      while [ $# -gt 0 ]; do
        case "$1" in --dir) dir="$2"; shift 2 ;; --pattern) pattern="$2"; shift 2 ;; *) shift ;; esac
      done
      printf 'carried\\n' > "$dir/$pattern"; exit 0 ;;
    fail) echo 'gh: asset download failed (HTTP 503)' >&2; exit 1 ;;
    *) exit 0 ;;
  esac
fi
echo "unexpected gh invocation: $*" >&2; exit 64
`,
  )
  execFileSync('chmod', ['+x', join(bin, 'gh')])
  return bin
}

function run(
  behaviour: Parameters<typeof ghShim>[0],
  channel: 'stable' | 'edge' = 'edge',
  /** Files already sitting in the staging directory before the step runs. */
  seed: Readonly<Record<string, string>> = {},
) {
  const dir = tmp('release')
  for (const [name, contents] of Object.entries(seed)) writeFileSync(join(dir, name), contents)
  const bin = ghShim(behaviour)
  const result = spawnSync(
    'bun',
    [script, '--channel', channel, '--dir', dir, '--repo', 'madeinorbit/podium'],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      cwd: repoRoot,
    },
  )
  return { ...result, dir }
}

describe('the step as CI runs it', () => {
  it('carries the standing manifest onto the staging directory', () => {
    const { status, stdout, dir } = run({ api: 'present', assets: ['latest.json'] })
    expect(status).toBe(0)
    expect(existsSync(join(dir, 'latest.json'))).toBe(true)
    expect(stdout).toContain('latest.json')
  })

  it('ships a channel with no previous release', () => {
    const { status, stdout } = run({ api: 'notFound' })
    expect(status).toBe(0)
    expect(stdout).toMatch(/no previous release/i)
  })

  // THE ARMEDNESS PROOF. Break the carry-forward for real and the step must stop,
  // naming itself — this is the exact failure the `|| true` used to swallow.
  it('STOPS the publish when GitHub cannot be read', () => {
    const { status, stderr } = run({ api: 'unreachable' })
    expect(status).not.toBe(0)
    expect(stderr).toContain(CARRY_FORWARD_STEP)
    expect(stderr).toContain('error connecting')
  })

  it('STOPS the publish when a listed asset will not download', () => {
    const { status, stderr } = run({ api: 'present', assets: ['latest.json'], download: 'fail' })
    expect(status).not.toBe(0)
    expect(stderr).toContain(CARRY_FORWARD_STEP)
    expect(stderr).toContain('downloading it failed')
  })

  /**
   * The same failure with a FILE ALREADY IN THE STAGING DIRECTORY, which is what
   * separates the two guards. Asking only "is the file there afterwards?" passes
   * this — and publishes whatever bytes happened to be lying around, at whatever
   * version, as though they were this release's carried manifest. Mutation-tested:
   * deleting the exit-status check leaves every other case green and only this one
   * red, which is the whole reason it is written down.
   */
  it('STOPS the publish when a download fails over a file already staged', () => {
    const { status, stderr, dir } = run(
      { api: 'present', assets: ['latest.json'], download: 'fail' },
      'edge',
      { 'latest.json': '{"version":"stale"}' },
    )
    expect(status).not.toBe(0)
    expect(stderr).toContain(CARRY_FORWARD_STEP)
    expect(stderr).toContain('downloading it failed')
    // Untouched — the refusal is about the fetch, not about tidying the directory.
    expect(readFileSync(join(dir, 'latest.json'), 'utf8')).toBe('{"version":"stale"}')
  })

  // The silent shape one layer down: gh reports success and leaves no file. The
  // publisher only checks existsSync, so this would have published the hole too.
  it('STOPS the publish when a download reports success but writes nothing', () => {
    const { status, stderr, dir } = run({
      api: 'present',
      assets: ['latest.json'],
      download: 'writes-nothing',
    })
    expect(existsSync(join(dir, 'latest.json'))).toBe(false)
    expect(status).not.toBe(0)
    expect(stderr).toContain(CARRY_FORWARD_STEP)
  })
})

describe('the workflow runs this and cannot ignore it', () => {
  it('calls the script instead of swallowing gh failures', () => {
    expect(headlessWorkflow).toContain('scripts/carry-forward-desktop-manifest.ts')
    const step = headlessWorkflow.slice(
      headlessWorkflow.indexOf('Carry forward the standing desktop shell reference'),
      headlessWorkflow.indexOf('Publish one multi-platform release'),
    )
    expect(step.length).toBeGreaterThan(0)
    expect(step).not.toContain('|| true')
    expect(step).not.toContain('continue-on-error')
  })

  it('carries before it publishes, so a refusal is reached first', () => {
    const carry = headlessWorkflow.indexOf('Carry forward the standing desktop shell reference')
    const publish = headlessWorkflow.indexOf('Publish one multi-platform release')
    expect(carry).toBeGreaterThan(-1)
    expect(publish).toBeGreaterThan(carry)
  })

  it('names both assets in one place, the script, and not in the workflow text', () => {
    expect([...CARRIED_ASSETS]).toEqual(['latest.json', 'desktop-shell-input.sha256'])
  })
})
