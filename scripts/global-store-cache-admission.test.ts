import { describe, expect, it } from 'vitest'
import { breakableEntry, parseAdmissionArgs } from './global-store-cache-admission'

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
