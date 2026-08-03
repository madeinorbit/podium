import { describe, expect, it } from 'vitest'

import { scanSource } from './check-merge-shadowing'

describe('scanSource — module exports', () => {
  it('does not flag a TypeScript overload set (POD-1355)', () => {
    const src = [
      'export function resumeKind(kind: HarnessAgent): string',
      'export function resumeKind(kind: AgentKind | string): string | undefined',
      'export function resumeKind(kind: AgentKind | string): string | undefined {',
      '  return manifestFor(kind)?.resumeKind',
      '}',
    ].join('\n')
    expect(scanSource('registry.ts', src)).toEqual([])
  })

  it('does not flag an overload set whose signatures wrap across lines', () => {
    const src = [
      'export function pick(',
      '  a: string,',
      '): string',
      'export function pick(',
      '  a: string,',
      '  b: number,',
      '): string {',
      '  return a',
      '}',
    ].join('\n')
    expect(scanSource('wrap.ts', src)).toEqual([])
  })

  it('still fires on a genuine duplicate module export — two real bodies', () => {
    const src = [
      'export function readFeedIdentity(): string {',
      "  return db.query('sync_feed')",
      '}',
      '',
      'export function readFeedIdentity(): string {',
      "  return db.query('feed_identity')",
      '}',
    ].join('\n')
    expect(scanSource('sync.ts', src)).toEqual([
      { file: 'sync.ts', kind: 'module-export', name: 'readFeedIdentity', lines: [1, 5] },
    ])
  })

  it('still fires when a merge kept a duplicate alongside an overload set', () => {
    const src = [
      'export function resumeKind(kind: HarnessAgent): string',
      'export function resumeKind(kind: string): string | undefined {',
      '  return a',
      '}',
      '',
      'export function resumeKind(kind: string): string | undefined {',
      '  return b',
      '}',
    ].join('\n')
    expect(scanSource('dupe.ts', src)).toEqual([
      { file: 'dupe.ts', kind: 'module-export', name: 'resumeKind', lines: [2, 6] },
    ])
  })

  it('still fires on duplicate non-function exports', () => {
    const src = ['export const LIMIT = 1', 'export const LIMIT = 2'].join('\n')
    expect(scanSource('limits.ts', src)).toHaveLength(1)
  })
})
