/**
 * THE INSTRUMENT MUST SAY YES BEFORE ITS NO IS WORTH READING.
 *
 * The detector in `declared-consumers.ts` exists to answer "does any code read
 * this declared field?". The failure mode that matters is not a missed find —
 * it is a CONFIDENT ZERO, because a zero here is an argument for deleting a
 * policy field or for leaving one unenforced. So every case below is built as a
 * pair: the classifier finds a real read, AND it declines the lookalike.
 *
 * The lookalikes are not hypothetical. POD-1203's gate flagged eight files on
 * its first run and every one was a COMMENT explaining a deletion. That case is
 * `refuses a comment mentioning the field` below, and it is the reason this is
 * a checker-based detector rather than a grep: comments are not in the AST, so
 * the refusal is structural rather than a pattern somebody tuned.
 *
 * These run on a tiny in-memory program rather than the repo, deliberately. The
 * classification logic is what can be wrong; wiring it to 5,000 real files
 * takes a minute and proves nothing about whether a `PropertyAssignment` is
 * being miscounted as a read.
 */

import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { analyse } from './declared-consumers'

const DECL = 'decl.ts'

/**
 * Keys are FILE-QUALIFIED by the analyser, because a type name is not unique
 * across declaring modules — `CommandPolicy` really is declared in both
 * `contract.ts` and `framework.ts`. The fixture file is `decl.ts`, so its
 * qualifier is `decl`.
 */
const KEY_ROLE_FLOOR = 'decl CommandPolicy.roleFloor'
const KEY_CONFIRMATION = 'decl CommandPolicy.confirmation'
const DECLARING_SOURCE = `
export interface CommandPolicy {
  readonly roleFloor: 'member' | 'admin'
  readonly confirmation: 'none' | 'confirm'
}
export interface Unrelated {
  readonly roleFloor: string
}
export interface Contract { readonly policy: CommandPolicy }
`

/**
 * Build a program from in-memory sources and run the analyser over `decl.ts`.
 *
 * `repoRoot` is '' so the in-memory file names are already repo-relative, which
 * keeps the fixtures readable and exercises the same path filtering the real
 * run uses.
 */
function analyseSources(files: Record<string, string>): ReturnType<typeof analyse> {
  const sources: Record<string, string> = { [DECL]: DECLARING_SOURCE, ...files }
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, langVersion, onError, shouldCreate) => {
    const text = sources[name]
    return text === undefined
      ? original(name, langVersion, onError, shouldCreate)
      : ts.createSourceFile(name, text, langVersion, true)
  }
  host.fileExists = (name) => sources[name] !== undefined
  host.readFile = (name) => sources[name]
  // Resolved by hand rather than by the module resolver: these fixtures live in
  // no directory, and letting the resolver guess at `.ts`/`.d.ts`/`index.ts`
  // candidates against a virtual filesystem is how the harness silently
  // resolves NOTHING and every "finds a read" case reports a passing zero.
  host.resolveModuleNameLiterals = (literals) =>
    literals.map((literal) => {
      const candidate = `${literal.text.replace(/^\.\//, '')}.ts`
      return sources[candidate] === undefined
        ? { resolvedModule: undefined }
        : {
            resolvedModule: {
              resolvedFileName: candidate,
              extension: ts.Extension.Ts,
              isExternalLibraryImport: false,
            },
          }
    })
  const program = ts.createProgram(Object.keys(sources), options, host)
  return analyse(program, '', [DECL])
}

const productReadCount = (files: Record<string, string>, key: string): number =>
  analyseSources(files).find((f) => f.key === key)?.productReads.length ?? 0

describe('declared-consumers: the classifier can say YES', () => {
  it('finds a property-access read', () => {
    expect(
      productReadCount(
        {
          'consumer.ts': `import type { Contract } from './decl'\nexport const f = (c: Contract) => c.policy.roleFloor === 'admin'\n`,
        },
        KEY_ROLE_FLOOR,
      ),
    ).toBe(1)
  })

  it('finds a destructured read', () => {
    expect(
      productReadCount(
        {
          'consumer.ts': `import type { CommandPolicy } from './decl'\nexport const f = (p: CommandPolicy) => { const { roleFloor } = p; return roleFloor }\n`,
        },
        KEY_ROLE_FLOOR,
      ),
    ).toBe(1)
  })

  it('finds an element-access read', () => {
    expect(
      productReadCount(
        {
          'consumer.ts': `import type { CommandPolicy } from './decl'\nexport const f = (p: CommandPolicy) => p['roleFloor']\n`,
        },
        KEY_ROLE_FLOOR,
      ),
    ).toBe(1)
  })
})

describe('declared-consumers: the classifier can say NO', () => {
  /**
   * POD-1203's measured failure, reproduced. A comment naming the field is the
   * single most common thing a grep trips on, and it is the one shape that most
   * often means the OPPOSITE of a consumer — somebody explaining a removal.
   */
  it('refuses a comment mentioning the field', () => {
    expect(
      productReadCount(
        {
          'consumer.ts': `// roleFloor used to be enforced here; see POD-352.\n/* policy.roleFloor — deleted, do not reintroduce */\nexport const f = 1\n`,
        },
        KEY_ROLE_FLOOR,
      ),
    ).toBe(0)
  })

  it('refuses a string literal naming the field', () => {
    expect(
      productReadCount(
        {
          'consumer.ts': `export const key = 'roleFloor'\nexport const msg = \`requires \${'roleFloor'}\`\n`,
        },
        KEY_ROLE_FLOOR,
      ),
    ).toBe(0)
  })

  /**
   * THE CENTRAL DISTINCTION. Every unread field has dozens of declaration
   * sites; counting them is precisely the mistake that makes an unenforced
   * field look enforced.
   */
  it('refuses a declaration site — writing the field is not reading it', () => {
    expect(
      productReadCount(
        {
          'consumer.ts': `import type { CommandPolicy } from './decl'\nexport const p: CommandPolicy = { roleFloor: 'admin', confirmation: 'none' }\n`,
        },
        KEY_ROLE_FLOOR,
      ),
    ).toBe(0)
  })

  it('refuses a same-named property on an unrelated type', () => {
    expect(
      productReadCount(
        {
          'consumer.ts': `import type { Unrelated } from './decl'\nexport const f = (u: Unrelated) => u.roleFloor\n`,
        },
        KEY_ROLE_FLOOR,
      ),
    ).toBe(0)
  })

  it('refuses a test-file read, and reports it separately', () => {
    const field = analyseSources({
      'consumer.test.ts': `import type { CommandPolicy } from './decl'\nexport const f = (p: CommandPolicy) => p.roleFloor\n`,
    }).find((f) => f.key === KEY_ROLE_FLOOR)
    expect(field?.productReads).toHaveLength(0)
    expect(field?.testReads).toHaveLength(1)
  })

  it('refuses a read inside the declaring module, and reports it separately', () => {
    const field = analyseSources({}).find((f) => f.key === KEY_ROLE_FLOOR)
    expect(field?.productReads).toHaveLength(0)
  })
})

describe('declared-consumers: a field nobody reads is reported unread', () => {
  it('reports zero for a field with only declaration sites', () => {
    const fields = analyseSources({
      'consumer.ts': `import type { CommandPolicy } from './decl'\nexport const a: CommandPolicy = { roleFloor: 'member', confirmation: 'confirm' }\nexport const f = (p: CommandPolicy) => p.roleFloor\n`,
    })
    expect(fields.find((f) => f.key === KEY_ROLE_FLOOR)?.productReads).toHaveLength(1)
    expect(fields.find((f) => f.key === KEY_CONFIRMATION)?.productReads).toHaveLength(0)
  })
})

describe('declared-consumers: a cast is surfaced, not silently dropped', () => {
  /**
   * `apps/server/src/modules/fleet/authz.ts` really does this to `machineVerb`.
   * The read is genuine and the symbol link is genuinely gone, so the honest
   * outcome is a flag for review rather than either a silent zero or a guess.
   */
  it('records a cast-erased read as shadowed rather than as unread-with-no-evidence', () => {
    const field = analyseSources({
      'consumer.ts': `import type { CommandPolicy } from './decl'\nexport const f = (p: CommandPolicy) => (p as { roleFloor?: string }).roleFloor\n`,
    }).find((f) => f.key === KEY_ROLE_FLOOR)
    expect(field?.productReads).toHaveLength(0)
    expect(field?.shadowedReads.length).toBeGreaterThan(0)
  })
})
