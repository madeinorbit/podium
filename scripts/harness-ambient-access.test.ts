/**
 * harness-ambient-access (POD-6545, docs/design/harness-access-contract.md
 * §3.6): the ratchet that freezes direct machine access in harness adapters
 * and driver families, and harness state folders named in the daemon, so it
 * can only go down while POD-6520 migrates it onto the harness context.
 *
 * The adapter cases run a fixture adapter (scripts/fixtures/
 * harness-ambient-adapter.ts.txt) through the rule and the ratchet with an
 * allow-list at its measured counts, then edit one use at a time.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyHarnessAmbientAllowlist,
  checkHarnessAmbientAccess,
  checkHarnessAmbientAllowlistTotals,
  HARNESS_AMBIENT_RULE,
  harnessAmbientScopeOf,
  runHarnessAmbientCheck,
} from './check-boundaries'
import {
  HARNESS_AMBIENT_ALLOWLIST,
  HARNESS_AMBIENT_BASELINE_OS_TOOL,
  HARNESS_AMBIENT_BASELINE_TO_MIGRATE,
  type HarnessAmbientAllowlistEntry,
} from './harness-ambient-allowlist'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = readFileSync(
  new URL('./fixtures/harness-ambient-adapter.ts.txt', import.meta.url),
  'utf8',
)
const ADAPTER = 'packages/harness/src/adapters/probe/index.ts'

/** The fixture's measured counts, as an allow-list. */
const FIXTURE_ALLOWLIST: HarnessAmbientAllowlistEntry[] = [
  { file: ADAPTER, access: 'child-process', count: 1, category: 'to-migrate', issue: 'POD-6536' },
  { file: ADAPTER, access: 'bun-spawn', count: 1, category: 'to-migrate', issue: 'POD-6536' },
  { file: ADAPTER, access: 'homedir', count: 2, category: 'to-migrate', issue: 'POD-6536' },
  { file: ADAPTER, access: 'process-env', count: 1, category: 'to-migrate', issue: 'POD-6536' },
]

function ratchet(source: string, allowlist = FIXTURE_ALLOWLIST, file = ADAPTER) {
  return applyHarnessAmbientAllowlist(checkHarnessAmbientAccess(file, source), allowlist)
}

function counts(file: string, source: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const v of checkHarnessAmbientAccess(file, source))
    out[v.specifier] = (out[v.specifier] ?? 0) + 1
  return out
}

/** Replace exactly one occurrence, failing loudly if the fixture drifted. */
function once(source: string, find: string, replace: string): string {
  expect(source.split(find).length - 1, find).toBe(1)
  return source.replace(find, replace)
}

describe('harness-ambient-access (POD-6545)', () => {
  it('counts the fixture adapter exactly — prose, strings, type-only imports and fields stay quiet', () => {
    expect(counts(ADAPTER, FIXTURE)).toEqual({
      'child-process': 1,
      'bun-spawn': 1,
      homedir: 2,
      'process-env': 1,
    })
    const vs = checkHarnessAmbientAccess(ADAPTER, FIXTURE)
    expect(new Set(vs.map((v) => v.rule))).toEqual(new Set([HARNESS_AMBIENT_RULE]))
    const atCount = ratchet(FIXTURE)
    expect(atCount.errors).toEqual([])
    expect(atCount.stale).toEqual([])
    expect(atCount.warnings).toHaveLength(5)
  })

  it('one extra homedir() fails', () => {
    const extra = once(
      FIXTURE,
      'return process.env.PROBE_HOME',
      'return process.env.PROBE_HOME ?? homedir()',
    )
    const { errors, stale } = ratchet(extra)
    expect(errors.map((v) => v.specifier)).toEqual(['homedir'])
    expect(errors[0]?.message).toContain(`${ADAPTER}:`)
    expect(stale).toEqual([])
  })

  it('one extra child_process import fails, in either spelling', () => {
    for (const spec of ["'child_process'", "'node:child_process'"]) {
      const extra = `import { spawnSync } from ${spec}\n${FIXTURE}`
      const { errors, stale } = ratchet(extra)
      expect(
        errors.map((v) => v.specifier),
        spec,
      ).toEqual(['child-process'])
      expect(stale, spec).toEqual([])
    }
    // require() and import() are the same access by another spelling.
    for (const call of ["require('child_process')", "await import('node:child_process')"]) {
      const extra = `${FIXTURE}\nexport async function late() { return ${call} }\n`
      expect(
        ratchet(extra).errors.map((v) => v.specifier),
        call,
      ).toEqual(['child-process'])
    }
  })

  it('one extra process.env read or Bun.spawn fails', () => {
    const env = `${FIXTURE}\nexport const trace = process.env.PROBE_TRACE\n`
    expect(ratchet(env).errors.map((v) => v.specifier)).toEqual(['process-env'])
    const spawn = `${FIXTURE}\nexport const run = () => Bun.spawnSync(['probe'])\n`
    expect(ratchet(spawn).errors.map((v) => v.specifier)).toEqual(['bun-spawn'])
  })

  it('removing one use without lowering the count fails with "lower the count"; lowering it passes', () => {
    const fewer = once(
      FIXTURE,
      "join(opts.homeDir ?? homedir(), '.probe', 'sessions')",
      "join(opts.homeDir ?? '/', '.probe', 'sessions')",
    )
    expect(counts(ADAPTER, fewer).homedir).toBe(1)
    const unlowered = ratchet(fewer)
    expect(unlowered.errors).toEqual([])
    expect(unlowered.stale).toHaveLength(1)
    expect(unlowered.stale[0]).toContain(ADAPTER)
    expect(unlowered.stale[0]).toContain('(homedir) allows 2 but only 1 remain')
    expect(unlowered.stale[0]).toContain('lower the count to 1 to hold the ground you gained')

    const lowered = FIXTURE_ALLOWLIST.map((e) => (e.access === 'homedir' ? { ...e, count: 1 } : e))
    const after = ratchet(fewer, lowered)
    expect(after.errors).toEqual([])
    expect(after.stale).toEqual([])
  })

  it('an entry whose access is gone is dead and must be removed', () => {
    const none = once(FIXTURE, "  Bun.spawn([bin, '--help'])\n", '')
    const { errors, stale } = ratchet(none)
    expect(errors).toEqual([])
    expect(stale).toHaveLength(1)
    expect(stale[0]).toContain('(bun-spawn) is dead')
  })

  it('swapping one access for another fails — counts are kept per access, not per file', () => {
    const swapped = once(
      FIXTURE,
      "join(opts.homeDir ?? homedir(), '.probe', 'sessions')",
      "join(opts.homeDir ?? process.env.HOME ?? '/', '.probe', 'sessions')",
    )
    const { errors, stale } = ratchet(swapped)
    expect(errors.map((v) => v.specifier)).toEqual(['process-env'])
    expect(stale.join('\n')).toContain('(homedir) allows 2 but only 1 remain')
  })

  it('a .codex literal added to an apps/daemon file fails against the real allow-list', () => {
    const file = 'apps/daemon/src/host-runtime.ts'
    const source = readFileSync(join(repoRoot, file), 'utf8')
    const base = applyHarnessAmbientAllowlist(
      checkHarnessAmbientAccess(file, source),
      HARNESS_AMBIENT_ALLOWLIST,
    )
    expect(base.errors).toEqual([])
    const added = `${source}\nexport const codexStateFolder = (home: string) => join(home, '.codex')\n`
    const { errors } = applyHarnessAmbientAllowlist(
      checkHarnessAmbientAccess(file, added),
      HARNESS_AMBIENT_ALLOWLIST,
    )
    expect(errors.map((v) => v.specifier)).toEqual(['state-folder'])
    expect(errors[0]?.message).toContain("adapter's `roots`")
  })

  it('names every harness state folder in the daemon, and only folders', () => {
    const file = 'apps/daemon/src/probe.ts'
    for (const literal of [
      "'.codex'",
      "'.claude'",
      "'.grok'",
      "'.pi/agent'",
      "'.pi'",
      "'.codex/sessions'",
      '"/home/u/.claude/projects"',
      `\`\${home}/.grok\``,
      `\`\${home}/.pi/agent/sessions\``,
    ]) {
      expect(counts(file, `export const x = ${literal}\n`), literal).toEqual({ 'state-folder': 1 })
    }
    for (const literal of [
      "'.claude.json'",
      "'.codexrc'",
      "'codex'",
      "'.pictures'",
      "'.pi/other'",
      "'.worktrees'",
    ]) {
      expect(counts(file, `export const x = ${literal}\n`), literal).toEqual({})
    }
    // Comments are not literals.
    expect(counts(file, '// written to ~/.codex/sessions\nexport const x = 1\n')).toEqual({})
    // Harness code may name its own folders: that is the adapters' `roots`.
    expect(counts(ADAPTER, "export const x = '.codex'\n")).toEqual({})
  })

  it('looks only at product source in its two scopes', () => {
    for (const file of [
      'packages/harness/src/adapters/codex/state-provider.ts',
      'packages/harness/src/driver/families/opencode/engine-host.ts',
    ]) {
      expect(harnessAmbientScopeOf(file), file).toBe('harness')
    }
    expect(harnessAmbientScopeOf('apps/daemon/src/control/codex.ts')).toBe('daemon')
    for (const file of [
      'packages/harness/src/adapters/codex/state-provider.test.ts',
      'packages/harness/src/driver/families/codex/test-support/fake-app-server.ts',
      'packages/harness/src/driver/families/headless/test-support.ts',
      'packages/harness/src/adapters/codex/__fixtures__/home.ts',
      'apps/daemon/src/test-support/server-host-survival.gen1.ts',
      'apps/daemon/src/session-observers.test.ts',
      'packages/harness/src/driver/host.ts',
      'apps/server/src/x.ts',
    ]) {
      expect(harnessAmbientScopeOf(file), file).toBeNull()
      expect(checkHarnessAmbientAccess(file, FIXTURE), file).toEqual([])
    }
  })

  it('counts os.homedir under any alias, and homedir passed as a value', () => {
    expect(counts(ADAPTER, "import os from 'node:os'\nexport const h = os.homedir()\n")).toEqual({
      homedir: 1,
    })
    expect(
      counts(ADAPTER, "import * as nodeOs from 'node:os'\nexport const h = nodeOs.homedir()\n"),
    ).toEqual({ homedir: 1 })
    expect(
      counts(ADAPTER, "import { homedir as home } from 'node:os'\nexport const h = home()\n"),
    ).toEqual({ homedir: 1 })
    expect(
      counts(ADAPTER, "import { homedir } from 'node:os'\nexport const getHome = homedir\n"),
    ).toEqual({ homedir: 1 })
    expect(counts(ADAPTER, "import { spawn, $ } from 'bun'\n")).toEqual({ 'bun-spawn': 2 })
    expect(counts(ADAPTER, 'export const env = globalThis.process.env\n')).toEqual({
      'process-env': 1,
    })
  })

  it('the totals only shrink, and the baselines equal the seeded sums', () => {
    expect(checkHarnessAmbientAllowlistTotals(FIXTURE_ALLOWLIST, 5, 0)).toEqual([])
    const grown = FIXTURE_ALLOWLIST.map((e) => (e.access === 'homedir' ? { ...e, count: 3 } : e))
    expect(checkHarnessAmbientAllowlistTotals(grown, 5, 0).join('\n')).toContain(
      'to-migrate total grew: 6 > baseline 5',
    )
    expect(checkHarnessAmbientAllowlistTotals(FIXTURE_ALLOWLIST, 6, 0).join('\n')).toContain(
      'lower HARNESS_AMBIENT_BASELINE_TO_MIGRATE to 5',
    )
    const unreasoned: HarnessAmbientAllowlistEntry[] = [
      { file: ADAPTER, access: 'child-process', count: 1, category: 'os-tool' },
    ]
    expect(checkHarnessAmbientAllowlistTotals(unreasoned, 0, 1).join('\n')).toContain(
      'os-tool but gives no reason',
    )
    const unowned: HarnessAmbientAllowlistEntry[] = [
      { file: ADAPTER, access: 'homedir', count: 1, category: 'to-migrate' },
    ]
    expect(checkHarnessAmbientAllowlistTotals(unowned, 1, 0).join('\n')).toContain(
      'names no removing issue',
    )
    expect(checkHarnessAmbientAllowlistTotals()).toEqual([])
    const sum = (category: string) =>
      HARNESS_AMBIENT_ALLOWLIST.filter((e) => e.category === category).reduce(
        (n, e) => n + e.count,
        0,
      )
    expect(sum('to-migrate')).toBe(HARNESS_AMBIENT_BASELINE_TO_MIGRATE)
    expect(sum('os-tool')).toBe(HARNESS_AMBIENT_BASELINE_OS_TOOL)
  })

  it('os-tool covers exactly the OS utilities the design names', () => {
    expect(
      HARNESS_AMBIENT_ALLOWLIST.filter((e) => e.category === 'os-tool')
        .map((e) => `${e.file} ${e.access}`)
        .sort(),
    ).toEqual([
      'packages/harness/src/adapters/claude-code/keychain-security.ts child-process',
      'packages/harness/src/adapters/codex/owned-rollout.ts child-process',
      'packages/harness/src/adapters/codex/state-provider.ts child-process',
    ])
  })

  it('is green on the real tree — seeded counts equal actual counts', () => {
    const violations = runHarnessAmbientCheck(repoRoot)
    const { errors, stale } = applyHarnessAmbientAllowlist(violations, HARNESS_AMBIENT_ALLOWLIST)
    expect(errors.map((v) => v.message)).toEqual([])
    expect(stale).toEqual([])
    // The walk covers every scope file the generic walker would yield.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name.startsWith('.') || e.name === 'node_modules') return []
        const full = join(dir, e.name)
        if (e.isDirectory()) return walk(full)
        return /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [full] : []
      })
    const scanned = ['packages/harness/src', 'apps/daemon/src']
      .flatMap((root) => walk(join(repoRoot, root)))
      .map((abs) => relative(repoRoot, abs).split(sep).join('/'))
      .filter((file) => harnessAmbientScopeOf(file) !== null)
    expect(scanned.length).toBeGreaterThan(100)
    const seen = new Set(violations.map((v) => v.file))
    for (const entry of HARNESS_AMBIENT_ALLOWLIST)
      expect(seen.has(entry.file), entry.file).toBe(true)
  })

  it('is wired into the lean gate through check-boundaries', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['lint:harness-ambient']).toBe(
      'bun scripts/check-boundaries.ts --harness-ambient-only',
    )
    expect(pkg.scripts.test).toContain('bun run lint:harness-ambient &&')
  })
})
