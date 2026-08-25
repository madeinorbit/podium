import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  breakableEntry,
  parseAdmissionArgs,
  probeEnv,
  workspaceSourceFile,
} from './global-store-cache-admission'
import { shouldAcquireValidationLease, VALIDATION_HELD_ENV } from './validation-admission'

const source = '/home/agent/podium'

describe('parseAdmissionArgs', () => {
  const args = [
    '--cache-root',
    '/cache/podium/admission',
    '--scratch-parent',
    '/cache/podium/admission-worktrees',
    '--run-id',
    'flatblock-2026-08-25',
    '--output',
    'evidence/admission.json',
  ]

  it('resolves every path so nothing lands relative to a worktree', () => {
    const options = parseAdmissionArgs(args, source)
    expect(options.cacheRoot).toBe('/cache/podium/admission')
    expect(options.output.startsWith('/')).toBe(true)
    expect(options.runId).toBe('flatblock-2026-08-25')
    expect(options.sourceRoot).toBe(source)
  })

  it('checks the commit under test at HEAD unless told otherwise', () => {
    expect(parseAdmissionArgs(args, source).ref).toBe('HEAD')
    expect(parseAdmissionArgs([...args, '--ref', 'abc1234'], source).ref).toBe('abc1234')
  })

  it('defaults the representative package but lets a host override it', () => {
    expect(parseAdmissionArgs(args, source).testPackage).toBe('@podium/composer')
    expect(
      parseAdmissionArgs([...args, '--test-package', '@podium/telemetry'], source).testPackage,
    ).toBe('@podium/telemetry')
  })

  it('accepts --flag=value as well as --flag value', () => {
    const inline = parseAdmissionArgs(
      ['--cache-root=/c', '--scratch-parent=/s', '--run-id=r', '--output=/o.json'],
      source,
    )
    expect(inline).toMatchObject({ cacheRoot: '/c', scratchParent: '/s', runId: 'r' })
  })
})

describe('breakableEntry', () => {
  const installed = ['.bin', '.bun', '@podium', '@types', 'left-pad', 'turbo', 'typescript']

  it('prefers node-pty, the optional native package this lane exists for', () => {
    expect(breakableEntry([...installed, 'node-pty'])).toBe('node-pty')
  })

  it('never sacrifices a package the refusal itself has to load', () => {
    // Breaking turbo or typescript would crash the run instead of refusing it, and a
    // crash is not evidence that admission said no.
    expect(breakableEntry(installed)).toBe('left-pad')
    expect(breakableEntry(['.bin', 'turbo', 'typescript', 'vitest'])).toBeNull()
  })

  it('is deterministic across two hosts that installed the same lockfile', () => {
    expect(breakableEntry(['zod', 'left-pad', 'acorn'])).toBe(
      breakableEntry(['acorn', 'zod', 'left-pad']),
    )
  })
})

describe('workspaceSourceFile', () => {
  const scratch: string[] = []
  afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  function repository(): string {
    const root = mkdtempSync(join(tmpdir(), 'podium-admission-source-'))
    scratch.push(root)
    writeFileSync(join(root, 'package.json'), '{"private":true,"workspaces":["packages/*"]}\n')
    mkdirSync(join(root, 'packages/composer/src'), { recursive: true })
    writeFileSync(join(root, 'packages/composer/package.json'), '{"name":"@podium/composer"}\n')
    writeFileSync(join(root, 'packages/composer/src/index.ts'), 'export const a = 1\n')
    mkdirSync(join(root, 'packages/headless'), { recursive: true })
    writeFileSync(join(root, 'packages/headless/package.json'), '{"name":"@podium/headless"}\n')
    return root
  }

  it('finds the package by its manifest name, not by its directory name', () => {
    const root = repository()
    expect(workspaceSourceFile(root, '@podium/composer')).toBe(
      join(root, 'packages/composer/src/index.ts'),
    )
  })

  it('refuses a package it cannot edit rather than silently skipping the probe', () => {
    const root = repository()
    expect(() => workspaceSourceFile(root, '@podium/headless')).toThrow('no src/index.ts')
    expect(() => workspaceSourceFile(root, '@podium/nonexistent')).toThrow('no workspace package')
  })
})

describe('probeEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('leaves no probe able to take a heavy lease of its own', () => {
    // Asserted against the two conditions runWithLease actually branches on, not against
    // the variable names: a probe that queued for a second `test:heavy` would queue
    // behind the lane's own holder and never start.
    vi.stubEnv('PODIUM_SESSION_ID', 'sess_live_agent')
    vi.stubEnv(VALIDATION_HELD_ENV, '')
    const env = probeEnv('/home/agent/.bun/bin/bun', '/cache/run/xdg') as Record<
      string,
      string | undefined
    >
    expect(shouldAcquireValidationLease(env)).toBe(false)
    expect(env[VALIDATION_HELD_ENV]).toBe('heavy')
  })

  it('says the lane is already heavy even when nothing outside it said so', () => {
    // The lane may be invoked directly rather than through the leased script. The marker
    // is the lane's own statement about what it is, so inner probes behave the same way
    // either route.
    vi.stubEnv(VALIDATION_HELD_ENV, 'focused')
    expect(
      (probeEnv('/home/agent/.bun/bin/bun', '/cache/run/xdg') as Record<string, string>)[
        VALIDATION_HELD_ENV
      ],
    ).toBe('heavy')
  })

  it('keeps the cache directory the one the checkout derives for itself', () => {
    // An inherited TURBO_CACHE_DIR would point every worktree at one directory by fiat,
    // and the lane would then prove nothing about how siblings find each other.
    vi.stubEnv('TURBO_CACHE_DIR', '/somewhere/the/operator/uses')
    const env = probeEnv('/home/agent/.bun/bin/bun', '/cache/run/xdg') as Record<
      string,
      string | undefined
    >
    expect(env.TURBO_CACHE_DIR).toBeUndefined()
    expect(env.XDG_CACHE_HOME).toBe('/cache/run/xdg')
  })
})
