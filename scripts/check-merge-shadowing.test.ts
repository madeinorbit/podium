import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { main, scanSource } from './check-merge-shadowing'

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

/** The three healthy shapes this gate reported as defects on a clean tree at
 *  43bfe4a47 [POD-2817], transcribed verbatim from the files it accused. Each is
 *  legal TypeScript. Pinning the literal text is the point: a paraphrase would
 *  drift away from the shape that actually fooled it. */
describe('scanSource — class members that legally share a name (POD-2817)', () => {
  it('does not flag a method overload set — apps/server/src/gateway/ws-server.ts `on`', () => {
    const src = [
      'class Socket {',
      '  terminate(): void {',
      '    this.native.terminate()',
      '  }',
      '',
      "  on(event: 'message', listener: (raw: string | Buffer) => void): this",
      "  on(event: 'close', listener: () => void): this",
      "  on(event: 'pong', listener: () => void): this",
      '  on(event: SocketEvent, listener: SocketListener): this {',
      '    return this',
      '  }',
      '}',
    ].join('\n')
    expect(scanSource('ws-server.ts', src)).toEqual([])
  })

  it('does not flag a getter/setter pair — apps/server/src/modules/sessions/session.ts `resume`', () => {
    const src = [
      'class Launch {',
      '  get resume(): ResumeRef | undefined {',
      '    return this.resumeRef',
      '  }',
      '  set resume(next: ResumeRef | undefined) {',
      '    this.resumeRef = next',
      '  }',
      '  private resumeRef: ResumeRef | undefined',
      '}',
    ].join('\n')
    expect(scanSource('session.ts', src)).toEqual([])
  })

  it('does not flag an overload set split by a doc comment — updates/service.ts `setTarget`', () => {
    const src = [
      'class UpdatesService {',
      '  setTarget(channel: UpdateChannel, target: UpdateTarget): void',
      '  /** Compatibility form for the existing development publisher. */',
      '  setTarget(target: UpdateTarget): void',
      '  setTarget(channelOrTarget: UpdateChannel | UpdateTarget, maybeTarget?: UpdateTarget): void {',
      '    this.targets.set(channelOrTarget, maybeTarget)',
      '  }',
      '}',
    ].join('\n')
    expect(scanSource('service.ts', src)).toEqual([])
  })

  it('does not flag a class overload signature that wraps across lines', () => {
    const src = [
      'class Wrapper {',
      '  pick(',
      '    a: string,',
      '  ): string',
      '  pick(',
      '    a: string,',
      '    b?: number,',
      '  ): string {',
      '    return a',
      '  }',
      '}',
    ].join('\n')
    expect(scanSource('wrap.ts', src)).toEqual([])
  })

  it('does not flag an abstract member declared beside nothing else', () => {
    const src = ['abstract class Base {', '  abstract load(id: string): Promise<void>', '}'].join('\n')
    expect(scanSource('base.ts', src)).toEqual([])
  })
})

/** The other half, and the one that matters: a quiet gate must still be ARMED.
 *  Each case below is the shape a bad merge actually produces — two live bodies
 *  for one name, the later silently winning. */
describe('scanSource — class members that genuinely shadow', () => {
  it('fires on two implementation bodies for one method — the POD-1246 merge shape', () => {
    const src = [
      'class SyncRepository {',
      '  readFeedIdentity(): string {',
      "    return this.db.query('sync_feed WHERE id = 1')",
      '  }',
      '',
      '  readFeedIdentity(): string {',
      "    return this.db.query('feed_identity WHERE singleton = 1')",
      '  }',
      '}',
    ].join('\n')
    expect(scanSource('sync-repository.ts', src)).toEqual([
      { file: 'sync-repository.ts', kind: 'class-member', name: 'readFeedIdentity', lines: [2, 6] },
    ])
  })

  it('fires when a merge kept a duplicate body alongside a legitimate overload set', () => {
    const src = [
      'class Socket {',
      "  on(event: 'message', listener: SocketListener): this",
      '  on(event: SocketEvent, listener: SocketListener): this {',
      '    return this',
      '  }',
      '',
      '  on(event: SocketEvent, listener: SocketListener): this {',
      '    return this',
      '  }',
      '}',
    ].join('\n')
    expect(scanSource('ws-server.ts', src)).toEqual([
      { file: 'ws-server.ts', kind: 'class-member', name: 'on', lines: [3, 7] },
    ])
  })

  it('fires on two getters of the same name — an accessor PAIR is one get plus one set', () => {
    const src = [
      'class Launch {',
      '  get resume(): ResumeRef | undefined {',
      '    return this.a',
      '  }',
      '  get resume(): ResumeRef | undefined {',
      '    return this.b',
      '  }',
      '}',
    ].join('\n')
    expect(scanSource('session.ts', src)).toEqual([
      { file: 'session.ts', kind: 'class-member', name: 'resume', lines: [2, 5] },
    ])
  })

  it('fires on the duplicated setter while leaving the single getter alone', () => {
    const src = [
      'class Launch {',
      '  get resume(): ResumeRef | undefined {',
      '    return this.a',
      '  }',
      '  set resume(next: ResumeRef | undefined) {',
      '    this.a = next',
      '  }',
      '  set resume(next: ResumeRef | undefined) {',
      '    this.b = next',
      '  }',
      '}',
    ].join('\n')
    expect(scanSource('session.ts', src)).toEqual([
      { file: 'session.ts', kind: 'class-member', name: 'resume', lines: [5, 8] },
    ])
  })
})

/** Armed end to end, not just in the scanner: a gate is only believable if the
 *  process the lint aggregate runs is shown to exit non-zero on a real file. */
describe('main — the exit code the lint aggregate reads', () => {
  const fixture = (name: string, src: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'shadowing-')), name)
    writeFileSync(path, src)
    return path
  }

  it('exits 1 and names the file when a class carries two bodies for one method', () => {
    const path = fixture(
      'repo.ts',
      ['class SyncRepository {', '  read(): string {', '    return "a"', '  }', '  read(): string {', '    return "b"', '  }', '}'].join('\n'),
    )
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)))
    try {
      expect(main([path])).toBe(1)
    } finally {
      spy.mockRestore()
    }
    expect(errors.join('\n')).toContain("class-member 'read'")
  })

  it('exits 0 on the same class once the duplicate body is an overload signature', () => {
    const path = fixture(
      'repo.ts',
      ['class SyncRepository {', '  read(): string', '  read(): string {', '    return "b"', '  }', '}'].join('\n'),
    )
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void logs.push(String(m)))
    try {
      expect(main([path])).toBe(0)
    } finally {
      spy.mockRestore()
    }
    expect(logs.join('\n')).toContain('ok: no shadowed declarations')
  })
})
