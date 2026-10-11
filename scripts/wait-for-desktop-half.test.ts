import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type DesktopJob,
  desktopHalfVerdict,
  EXPERIMENTAL_DESKTOP_TARGETS,
  pairedDesktopRun,
} from './wait-for-desktop-half'

const done = (name: string, conclusion: string): DesktopJob => ({
  name,
  status: 'completed',
  conclusion,
})
const running = (name: string): DesktopJob => ({ name, status: 'in_progress', conclusion: null })

// Exactly as GitHub reported them for the v0.2.0-edge.8 desktop run (it truncates long names).
const MAC =
  'build (darwin-aarch64, macos-15, -- --target aarch64-apple-darwin, apps/desktop/src-tauri/target/...'
const INTEL =
  'build (darwin-x86_64, macos-15-intel, -- --target x86_64-apple-darwin, apps/desktop/src-tauri/tar...'
const LINUX =
  'build (linux-x86_64, ubuntu-latest, apps/desktop/src-tauri/target/release/bundle/appimage/*.AppIm...'
const WINDOWS =
  'build (windows-x86_64, windows-latest, true, 30, -- --bundles nsis, apps/desktop/src-tauri/target...'

describe('desktopHalfVerdict', () => {
  it('waits until the desktop half has decided whether it builds an app', () => {
    expect(desktopHalfVerdict([], 'edge').kind).toBe('wait')
    expect(desktopHalfVerdict([running('validate')], 'stable').kind).toBe('wait')
  })

  it('proceeds at once when the tag builds no new app', () => {
    // The common case: no shell inputs changed, every build is skipped, nothing to wait for.
    const jobs = [done('validate', 'success'), done('build', 'skipped'), done('publish', 'skipped')]
    expect(desktopHalfVerdict(jobs, 'edge').kind).toBe('proceed')
    expect(desktopHalfVerdict(jobs, 'stable').kind).toBe('proceed')
  })

  it('on edge, waits for the app to be published, not just built', () => {
    const built = [
      done('validate', 'success'),
      done(MAC, 'success'),
      done(INTEL, 'success'),
      done(LINUX, 'success'),
    ]
    expect(desktopHalfVerdict(built, 'edge').kind).toBe('wait')
    expect(desktopHalfVerdict([...built, running('publish')], 'edge').kind).toBe('wait')
    expect(desktopHalfVerdict([...built, done('publish', 'success')], 'edge').kind).toBe('proceed')
  })

  it('on stable, proceeds once every required build succeeded (its publish needs our release)', () => {
    const built = [
      done('validate', 'success'),
      done(MAC, 'success'),
      done(INTEL, 'success'),
      done(LINUX, 'success'),
    ]
    expect(desktopHalfVerdict([...built.slice(0, 3), running(LINUX)], 'stable').kind).toBe('wait')
    expect(desktopHalfVerdict(built, 'stable').kind).toBe('proceed')
  })

  it('fails when a required build fails, so nothing half-built is published', () => {
    const jobs = [done('validate', 'success'), done(MAC, 'success'), done(INTEL, 'failure')]
    expect(desktopHalfVerdict(jobs, 'edge').kind).toBe('fail')
    expect(desktopHalfVerdict(jobs, 'stable').kind).toBe('fail')
    expect(desktopHalfVerdict([done('validate', 'failure')], 'stable').kind).toBe('fail')
  })

  it('never waits on or fails for the experimental Windows leg', () => {
    const base = [
      done('validate', 'success'),
      done(MAC, 'success'),
      done(INTEL, 'success'),
      done(LINUX, 'success'),
    ]
    expect(desktopHalfVerdict([...base, running(WINDOWS)], 'stable').kind).toBe('proceed')
    expect(
      desktopHalfVerdict([...base, done(WINDOWS, 'failure'), done('publish', 'success')], 'edge')
        .kind,
    ).toBe('proceed')
  })

  it('fails on edge when the app publish fails', () => {
    const jobs = [
      done('validate', 'success'),
      done(MAC, 'success'),
      done(INTEL, 'success'),
      done(LINUX, 'success'),
      done('publish', 'failure'),
    ]
    expect(desktopHalfVerdict(jobs, 'edge').kind).toBe('fail')
  })
})

describe('pairedDesktopRun', () => {
  it('picks the desktop run of this exact tag and commit', () => {
    const runs = [
      { databaseId: 1, headBranch: 'v0.2.0-edge.7', headSha: 'aaa' },
      { databaseId: 2, headBranch: 'v0.2.0-edge.8', headSha: 'old' },
      { databaseId: 3, headBranch: 'v0.2.0-edge.8', headSha: 'bbb' },
    ]
    expect(pairedDesktopRun(runs, 'v0.2.0-edge.8', 'bbb')).toBe(3)
    expect(pairedDesktopRun(runs, 'v0.2.0', 'bbb')).toBeUndefined()
  })
})

describe('the release workflows', () => {
  const root = join(__dirname, '..')
  const desktop = Bun.YAML.parse(
    readFileSync(join(root, '.github/workflows/desktop-release.yml'), 'utf8'),
  ) as {
    jobs: {
      build: { strategy: { matrix: { include: { target: string; experimental?: boolean }[] } } }
    }
  }
  const headless = Bun.YAML.parse(
    readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'),
  ) as {
    permissions: Record<string, string>
    jobs: { publish: { steps: { name?: string; run?: string }[] } }
  }

  it('treats exactly the workflow’s experimental legs as experimental', () => {
    const flagged = desktop.jobs.build.strategy.matrix.include
      .filter((leg) => leg.experimental === true)
      .map((leg) => leg.target)
    expect([...EXPERIMENTAL_DESKTOP_TARGETS].sort()).toEqual(flagged.sort())
  })

  it('waits for the desktop half before carrying its manifest forward and publishing', () => {
    const names = headless.jobs.publish.steps.map((step) => step.name)
    const wait = names.indexOf('Wait for the desktop half of this tag')
    expect(wait).toBeGreaterThanOrEqual(0)
    expect(wait).toBeLessThan(names.indexOf('Carry forward the standing desktop shell reference'))
    expect(wait).toBeLessThan(names.indexOf('Publish one multi-platform release'))
    expect(headless.jobs.publish.steps[wait]?.run).toContain('scripts/wait-for-desktop-half.ts')
    // Reading the desktop run's jobs needs the Actions API.
    expect(headless.permissions.actions).toBe('read')
  })
})
