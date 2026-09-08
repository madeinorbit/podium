import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { census } from './promise-caller-census'

function scan(source: string) {
  const root = process.cwd()
  const filename = path.join(root, '__promise_census_probe__.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, types: [], strict: true, noEmit: true }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (file, languageVersion, ...rest) => file === filename
    ? ts.createSourceFile(file, source, languageVersion, true)
    : read(file, languageVersion, ...rest)
  return census(ts.createProgram([filename], options, host), root).findings
}

const declarations = `
  declare function read(): Promise<{ version: string } | undefined>;
  declare function fingerprint(input: unknown): string;
  declare function consume(input: any): void;
  declare function rest(...input: unknown[]): void;
`

describe('promise caller census', () => {
  it('derives both edges of the original guard through an inferred local', () => {
    const findings = scan(`${declarations}
      const approved = read();
      approved !== undefined && fingerprint(approved) === fingerprint({ version: 'next' });
    `)
    expect(findings.map((finding) => finding.kind).sort()).toEqual(['existence', 'unknown/any parameter'])
    expect(new Set(findings.map((finding) => finding.origin)).size).toBe(1)
  })

  it('follows widened aliases, later assignments, and properties', () => {
    const findings = scan(`${declarations}
      const first = read();
      const widened: unknown = first;
      let later: any;
      later = widened;
      const holder = { value: later };
      consume(holder.value);
    `)
    expect(findings.map((finding) => finding.kind)).toEqual(['unknown/any parameter'])
    expect(findings[0]?.call).toBe('read()')
  })

  it('follows object destructuring and locally declared promise parameters', () => {
    const findings = scan(`${declarations}
      const box = { value: read() };
      const { value: renamed } = box;
      function inspect(value: Promise<unknown>) { return !value; }
      inspect(renamed);
    `)
    expect(findings.map((finding) => finding.kind)).toEqual(['truthiness'])
    expect(findings[0]?.call).toBe('read()')
  })

  it('keeps differently instantiated generic properties separate', () => {
    const findings = scan(`${declarations}
      interface Cell<T> { current: T }
      const pending: Cell<Promise<unknown> | undefined> = { current: undefined };
      const count: Cell<number> = { current: 0 };
      pending.current = read();
      if (count.current) {}
      if (pending.current) {}
    `)
    expect(findings.map((finding) => finding.kind)).toEqual(['truthiness'])
    expect(findings[0]?.expression).toBe('if (pending.current) {}')
  })

  it('finds promises in serialized containers without treating the container as a promise', () => {
    const findings = scan(`${declarations}
      const p = read();
      const box = { nested: [p] };
      if (box) {}
      fingerprint(box);
    `)
    expect(findings.map((finding) => finding.kind)).toEqual(['unknown/any parameter'])
    expect(findings[0]?.call).toBe('read()')
  })

  it('follows local return values including containers surviving an outer await', () => {
    const findings = scan(`${declarations}
      function erased(): unknown { return read(); }
      async function nested() { return { value: read() }; }
      async function run() { fingerprint(erased()); fingerprint(await nested()); }
    `)
    expect(findings.map((finding) => finding.kind)).toEqual(['unknown/any parameter', 'unknown/any parameter'])
    expect(findings.map((finding) => finding.call)).toEqual(['read()', 'read()'])
  })

  it('tracks indexed promises, logical assignments, nullish checks and typeof existence', () => {
    const findings = scan(`${declarations}
      const tasks = [read()];
      fingerprint(tasks[0]);
      let p: Promise<unknown> | undefined;
      p ||= read();
      p &&= read();
      p ?? read();
      typeof p === 'undefined';
    `)
    expect(findings.some((finding) => finding.kind === 'unknown/any parameter' && finding.call === 'read()')).toBe(true)
    expect(findings.filter((finding) => finding.kind === 'truthiness').length).toBeGreaterThan(0)
    expect(findings.filter((finding) => finding.kind === 'existence').length).toBeGreaterThan(0)
  })

  it('includes null, equality, negation, all loop conditions and rest parameters', () => {
    const findings = scan(`${declarations}
      const p = read();
      p == null;
      p === 'ready';
      !p;
      if (p) {}
      while (p) { break; }
      do {} while (p);
      for (; p;) { break; }
      p ? 1 : 0;
      p || 0;
      rest(p);
    `)
    expect(findings.filter((finding) => finding.kind === 'truthiness')).toHaveLength(7)
    expect(findings.filter((finding) => finding.kind === 'existence')).toHaveLength(1)
    expect(findings.filter((finding) => finding.kind === 'equality')).toHaveLength(1)
    expect(findings.filter((finding) => finding.kind === 'unknown/any parameter')).toHaveLength(1)
  })

  it('recognizes union returns and structural thenables without an async keyword', () => {
    const findings = scan(`
      declare function union(): boolean | Promise<boolean>;
      declare function thenable(): PromiseLike<number>;
      if (union()) {}
      !thenable();
    `)
    expect(findings.map((finding) => finding.call)).toEqual(['union()', 'thenable()'])
  })

  it('does not mistake an unconstrained generic for a declared promise', () => {
    expect(scan(`${declarations}
      function generic<T>(read: () => T) { const value = read(); consume(value); return !value; }
    `)).toEqual([])
  })

  it('stops at await and leaves typed promise consumers and promise identity alone', () => {
    const findings = scan(`${declarations}
      declare function accepts(p: Promise<unknown>): void;
      async function fixed() {
        const approved = await read();
        approved !== undefined && fingerprint(approved);
        const p = read();
        accepts(p);
        p === read();
        fingerprint(await p);
        const tasks = [read()];
        fingerprint(await tasks[0]);
        await read();
      }
    `)
    expect(findings).toEqual([])
  })
})
