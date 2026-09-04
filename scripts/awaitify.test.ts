/**
 * THE AWAIT PASS MUST EMIT CODE THAT PARSES.
 *
 * `check-await-idempotence.ts` proves the pass proposes nothing at the current
 * tip. It cannot prove the pass would emit VALID text at a site the tip does not
 * happen to contain — once a site is converted the pass has nothing to say about
 * it, so a broken emitter stays green forever. POD-3382 was exactly that: two
 * sites in one file, hidden behind keep-sync entries, and the same shape anywhere
 * else would have produced the same TS1109.
 *
 * So the emitter is checked here, on the shape that has now gone wrong twice: two
 * awaits beginning at the SAME offset. `openTestStore(f).sessions.purge(x)` is a
 * parenthesised helper await (`(await openTestStore(f))`, because `await` binds
 * looser than `.sessions`) AND a statement-level store await, and both start at
 * `openTestStore`. POD-3262 applied them in the wrong order; POD-3382 was the
 * ASI semicolon landing between them.
 */
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { type AwaitSite, applyEdits, awaitEdits } from './awaitify'

/** The pass emits text, not an AST. Whether that text parses is the property. */
function syntaxErrors(body: string): string[] {
  const r = ts.transpileModule(`async function t() {\n${body}\n}\n`, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  })
  return (r.diagnostics ?? []).map((d) => `TS${d.code}`)
}

/** Await `sites` in `text` the way `run(--apply)` does, and return the result. */
function awaited(text: string, sites: AwaitSite[]): string {
  return applyEdits(text, awaitEdits(sites), 'fixture').text
}

/** The offsets of `call` within `text`, as one await site. */
function site(
  text: string,
  call: string,
  rest: Pick<AwaitSite, 'parenthesised' | 'atStatementStart'>,
): AwaitSite {
  const start = text.indexOf(call)
  expect(start, `${call} not in fixture`).toBeGreaterThanOrEqual(0)
  return { start, end: start + call.length, ...rest }
}

describe('awaitEdits', () => {
  it('puts the ASI guard outside BOTH awaits that begin at one offset', () => {
    // The POD-3382 site. The previous line ends without a semicolon, so
    // `draftWithSession(reg)` newline `(await openTestStore(f))…` is one call
    // expression to the parser and the `;` has to be there.
    const text = '  const { id } = draftWithSession(reg)\n  openTestStore(f).sessions.purge(id)\n'
    const out = awaited(text, [
      site(text, 'openTestStore(f)', { parenthesised: true, atStatementStart: true }),
      site(text, 'openTestStore(f).sessions.purge(id)', {
        parenthesised: false,
        atStatementStart: true,
      }),
    ])
    expect(out).toContain(';await (await openTestStore(f)).sessions.purge(id)')
    expect(syntaxErrors(out)).toEqual([])
  })

  it('rejects the form POD-3382 emitted, so the fixture above is not vacuous', () => {
    // What the guard-on-the-lead version produced. If this ever parses, the
    // check above has stopped being a check.
    expect(syntaxErrors('  await ;(await openTestStore(f)).sessions.purge(id)')).toEqual(['TS1109'])
  })

  it('still guards a lone parenthesised receiver at a statement start', () => {
    const text = '  const { id } = draftWithSession(reg)\n  openTestStore(f).sessions.purge(id)\n'
    const out = awaited(text, [
      site(text, 'openTestStore(f)', { parenthesised: true, atStatementStart: true }),
    ])
    expect(out).toContain(';(await openTestStore(f)).sessions.purge(id)')
    expect(syntaxErrors(out)).toEqual([])
  })

  it('emits ONE guard when two parenthesised awaits share a statement start', () => {
    // `f(a)` is the callee of `(b)` and `f(a)(b)` is the receiver of `.c` — both
    // need parentheses and both begin at the same offset. Two guards there would
    // be `;;`, which parses, but the set of statements it makes is not the one
    // the pass meant to write.
    const text = '  const x = g(a)\n  f(a)(b).c()\n'
    const out = awaited(text, [
      site(text, 'f(a)', { parenthesised: true, atStatementStart: true }),
      site(text, 'f(a)(b)', { parenthesised: true, atStatementStart: true }),
    ])
    expect(out).toContain(';(await (await f(a))(b)).c()')
    expect(out.match(/;/g)).toHaveLength(1)
    expect(syntaxErrors(out)).toEqual([])
  })

  it('does not guard a receiver that is not at a statement start', () => {
    const text = '  const v = openTestStore(f).sessions.get(id)\n'
    const out = awaited(text, [
      site(text, 'openTestStore(f)', { parenthesised: true, atStatementStart: false }),
    ])
    expect(out).toContain('const v = (await openTestStore(f)).sessions.get(id)')
    expect(out).not.toContain(';')
    expect(syntaxErrors(out)).toEqual([])
  })
})
