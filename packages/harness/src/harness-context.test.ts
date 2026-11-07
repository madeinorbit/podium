import { join } from 'node:path'
import type { BuiltinHarnessKind } from '@podium/protocol'
import type { CommandEnvironment } from '@podium/runtime/command-environment'
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_KEYCHAIN_BASE_SERVICE,
  claudeKeychainService,
  deriveClaudeKeychainCoordinate,
} from './adapters/claude-code/keychain-coordinate.js'
import { fixtureManifest } from './adapters/fixture/index.js'
import type { HarnessExecutableSnapshot } from './executable-runtime.js'
import { harnessChildEnv, harnessContext, harnessRoots } from './harness-context.js'
import type { ResolvedHarnessExecutable } from './inventory/build-inventory.js'
import type { HarnessRoots } from './manifest.js'
import { harnessLoginReadEnv, manifestFor, registerTestManifest } from './registry.js'

const HOME = '/accounts/alice'

function snapshot(
  executables: ResolvedHarnessExecutable[],
  env: Record<string, string>,
  generation = 7,
): HarnessExecutableSnapshot {
  const commandEnvironment: CommandEnvironment = {
    env,
    pathEntries: ['/opt/homebrew/bin'],
    source: 'login-shell',
    generation,
    machineHome: '/Users/operator',
    loginShell: '/bin/zsh',
    resolve: () => undefined,
  }
  return {
    executables: new Map(executables.map((executable) => [executable.kind, executable])),
    commandEnvironment,
  }
}

const MACHINE_ENV = {
  PATH: '/opt/homebrew/bin:/usr/bin:/bin',
  HOME: '/Users/operator',
  CODEX_HOME: '/Users/operator/decoy-codex',
  OPENAI_API_KEY: 'sk-inherited',
  LANG: 'en_US.UTF-8',
}

const CODEX: ResolvedHarnessExecutable = {
  kind: 'codex',
  path: '/opt/homebrew/bin/codex',
  version: 'codex-cli 0.162.0',
  generation: 7,
}

describe('harnessContext', () => {
  it('throws for a kind the inventory did not resolve, never falling back to a basename', () => {
    const inventory = snapshot([CODEX], MACHINE_ENV)
    expect(() => harnessContext(inventory, 'claude-code', HOME)).toThrow(
      /claude-code is not installed/,
    )
    expect(() => harnessContext(snapshot([], MACHINE_ENV), 'codex', HOME)).toThrow(
      /codex is not installed in command-environment generation 7/,
    )
  })

  it("takes the account env from harnessLoginReadEnv over the snapshot's command env", () => {
    const context = harnessContext(snapshot([CODEX], MACHINE_ENV), 'codex', HOME)
    expect(context.env).toEqual(harnessLoginReadEnv('codex', HOME, MACHINE_ENV))
    // What that recipe means for the account: its HOME and selector, with the
    // inherited credential stripped and the machine's decoy selector replaced.
    expect(context.env.HOME).toBe(HOME)
    expect(context.env.CODEX_HOME).toBe(join(HOME, '.codex'))
    expect(context.env).not.toHaveProperty('OPENAI_API_KEY')
    expect(context.env.PATH).toBe(MACHINE_ENV.PATH)
    expect(context.home).toBe(HOME)
  })

  it("records the inventory's verified executable, version and generation", () => {
    const context = harnessContext(snapshot([CODEX], MACHINE_ENV, 7), 'codex', HOME)
    expect(context.installation).toEqual({
      kind: 'codex',
      executable: CODEX.path,
      version: CODEX.version,
      generation: 7,
    })
  })

  it("resolves roots once from the adapter's rule over the account env", () => {
    const context = harnessContext(snapshot([CODEX], MACHINE_ENV), 'codex', HOME)
    expect(context.roots).toEqual(manifestFor('codex')!.roots(HOME, context.env))
    expect(context.roots.state).toBe(join(HOME, '.codex'))
  })

  it('is frozen plain data', () => {
    const context = harnessContext(snapshot([CODEX], MACHINE_ENV), 'codex', HOME)
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.isFrozen(context.installation)).toBe(true)
    expect(Object.isFrozen(context.env)).toBe(true)
    expect(Object.isFrozen(context.roots)).toBe(true)
    expect(JSON.parse(JSON.stringify(context))).toEqual(context)
  })
})

describe('adapter roots', () => {
  const cases: {
    kind: BuiltinHarnessKind
    defaults: HarnessRoots
    selected: { env: Record<string, string>; roots: HarnessRoots }
  }[] = [
    {
      kind: 'codex',
      defaults: {
        state: `${HOME}/.codex`,
        config: `${HOME}/.codex`,
        credentials: `${HOME}/.codex`,
        transcripts: `${HOME}/.codex/sessions`,
        hooks: `${HOME}/.codex`,
      },
      selected: {
        env: { CODEX_HOME: '/state/codex' },
        roots: {
          state: '/state/codex',
          config: '/state/codex',
          credentials: '/state/codex',
          transcripts: '/state/codex/sessions',
          hooks: '/state/codex',
        },
      },
    },
    {
      kind: 'claude-code',
      defaults: {
        state: `${HOME}/.claude`,
        config: `${HOME}/.claude`,
        credentials: `${HOME}/.claude`,
        transcripts: `${HOME}/.claude/projects`,
      },
      selected: {
        env: { CLAUDE_CONFIG_DIR: '/state/claude' },
        roots: {
          state: '/state/claude',
          config: '/state/claude',
          credentials: '/state/claude',
          transcripts: '/state/claude/projects',
        },
      },
    },
    {
      kind: 'grok',
      defaults: {
        state: `${HOME}/.grok`,
        credentials: `${HOME}/.grok`,
        transcripts: `${HOME}/.grok/sessions`,
        hooks: `${HOME}/.grok/hooks`,
      },
      selected: {
        env: { GROK_HOME: '/state/grok' },
        roots: {
          state: '/state/grok',
          credentials: '/state/grok',
          transcripts: '/state/grok/sessions',
          hooks: '/state/grok/hooks',
        },
      },
    },
    {
      kind: 'pi',
      defaults: {
        state: `${HOME}/.pi/agent`,
        config: `${HOME}/.pi/agent`,
        credentials: `${HOME}/.pi/agent`,
        transcripts: `${HOME}/.pi/agent/sessions`,
      },
      selected: {
        env: { PI_CODING_AGENT_DIR: '/state/pi' },
        roots: {
          state: '/state/pi',
          config: '/state/pi',
          credentials: '/state/pi',
          transcripts: '/state/pi/sessions',
        },
      },
    },
    {
      kind: 'opencode',
      defaults: {
        state: `${HOME}/.local/share/opencode`,
        config: `${HOME}/.config/opencode`,
        credentials: `${HOME}/.local/share/opencode`,
        transcripts: `${HOME}/.local/share/opencode`,
      },
      selected: {
        env: { XDG_DATA_HOME: '/xdg/data', XDG_CONFIG_HOME: '/xdg/config' },
        roots: {
          state: '/xdg/data/opencode',
          config: '/xdg/config/opencode',
          credentials: '/xdg/data/opencode',
          transcripts: '/xdg/data/opencode',
        },
      },
    },
    {
      // Cursor has no selector: Podium has only ever read <home>/.cursor.
      kind: 'cursor',
      defaults: { state: `${HOME}/.cursor`, transcripts: `${HOME}/.cursor/projects` },
      selected: {
        env: { CURSOR_CONFIG_DIR: '/state/cursor', XDG_CONFIG_HOME: '/xdg/config' },
        roots: { state: `${HOME}/.cursor`, transcripts: `${HOME}/.cursor/projects` },
      },
    },
  ]

  for (const { kind, defaults, selected } of cases) {
    it(`${kind}: default folders under the home`, () => {
      expect(manifestFor(kind)!.roots(HOME, {})).toEqual(defaults)
      expect(harnessRoots(kind, HOME, {})).toEqual(defaults)
    })
    it(`${kind}: its selector relocates the folders`, () => {
      expect(manifestFor(kind)!.roots(HOME, selected.env)).toEqual(selected.roots)
    })
  }

  it('pi: PI_CODING_AGENT_SESSION_DIR relocates only the sessions tree', () => {
    expect(harnessRoots('pi', HOME, { PI_CODING_AGENT_SESSION_DIR: '/sessions/pi' })).toMatchObject(
      { state: `${HOME}/.pi/agent`, transcripts: '/sessions/pi' },
    )
  })

  it('a blank selector falls back to the home default', () => {
    expect(harnessRoots('codex', HOME, { CODEX_HOME: '  ' }).state).toBe(`${HOME}/.codex`)
    expect(harnessRoots('grok', HOME, { GROK_HOME: '' }).state).toBe(`${HOME}/.grok`)
  })

  it('fixture: default folders, and no selector relocates them', () => {
    const defaults = {
      state: `${HOME}/.fixture`,
      credentials: `${HOME}/.fixture`,
      transcripts: `${HOME}/.fixture/sessions`,
    }
    expect(fixtureManifest.roots(HOME, {})).toEqual(defaults)
    expect(fixtureManifest.roots(HOME, { FIXTURE_HOME: '/state/fixture' })).toEqual(defaults)
    const release = registerTestManifest(fixtureManifest)
    try {
      expect(harnessRoots('fixture', HOME, {})).toEqual(defaults)
    } finally {
      release()
    }
  })

  it('an unknown harness has no roots rather than borrowing another layout', () => {
    expect(() => harnessRoots('not-a-harness', HOME, {})).toThrow(/no manifest/)
  })
})

/**
 * THE OPERATOR'S OWN SELECTORS AND A NAMED ACCOUNT (POD-6604).
 *
 * Claude Code (`CLAUDE_CONFIG_DIR`) and OpenCode (`XDG_*`) default their folders
 * under HOME. An operator who sets one of these in their own shell chose it for
 * THEIR account. A named account (home ≠ the command env's HOME) must not land
 * there, and the child, the context's env and roots, and the keychain coordinate
 * must agree. The machine's own account keeps the operator's choice.
 */
describe('operator selectors and a named account (POD-6604)', () => {
  const OPERATOR = '/Users/operator'
  const OPERATOR_ENV = {
    PATH: '/usr/bin:/bin',
    HOME: OPERATOR,
    CLAUDE_CONFIG_DIR: '/Users/operator/claude-alt',
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/Users/operator/claude-secure',
    XDG_DATA_HOME: '/Users/operator/xdg-data',
    XDG_CONFIG_HOME: '/Users/operator/xdg-config',
    XDG_STATE_HOME: '/Users/operator/xdg-state',
    XDG_CACHE_HOME: '/Users/operator/xdg-cache',
    XDG_RUNTIME_DIR: '/run/user/501',
  }
  const CLAUDE: ResolvedHarnessExecutable = {
    kind: 'claude-code',
    path: '/opt/homebrew/bin/claude',
    version: '2.1.234 (Claude Code)',
    generation: 7,
  }
  const OPENCODE: ResolvedHarnessExecutable = {
    kind: 'opencode',
    path: '/opt/homebrew/bin/opencode',
    version: '1.18.32',
    generation: 7,
  }
  const inventory = snapshot([CLAUDE, OPENCODE], OPERATOR_ENV)
  const CLAUDE_SELECTORS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']
  const XDG_SELECTORS = ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']

  it('claude-code: a named account drops them from its env, roots and child', () => {
    const context = harnessContext(inventory, 'claude-code', HOME)
    for (const key of CLAUDE_SELECTORS) expect(context.env).not.toHaveProperty(key)
    expect(context.roots.state).toBe(join(HOME, '.claude'))
    expect(context.roots.transcripts).toBe(join(HOME, '.claude', 'projects'))
    const child = harnessChildEnv(context, {})
    for (const key of CLAUDE_SELECTORS) {
      expect(child.env).not.toHaveProperty(key)
      // The PTY and podium-host spawns spread the daemon's own env under the
      // child's: the boundary must delete the daemon's copy too.
      expect(child.strip).toContain(key)
    }
    expect(child.env.HOME).toBe(HOME)
  })

  it('opencode: a named account drops the XDG base dirs from its env, roots and child', () => {
    const context = harnessContext(inventory, 'opencode', HOME)
    for (const key of XDG_SELECTORS) expect(context.env).not.toHaveProperty(key)
    expect(context.roots.state).toBe(join(HOME, '.local', 'share', 'opencode'))
    expect(context.roots.config).toBe(join(HOME, '.config', 'opencode'))
    const child = harnessChildEnv(context, {})
    for (const key of XDG_SELECTORS) {
      expect(child.env).not.toHaveProperty(key)
      expect(child.strip).toContain(key)
    }
    // Not a folder selector: the session bus and runtime dir stay the machine's.
    expect(child.env.XDG_RUNTIME_DIR).toBe('/run/user/501')
  })

  it('the keychain coordinate of a named Claude account is the unscoped one under its home', () => {
    const context = harnessContext(inventory, 'claude-code', HOME)
    expect(claudeKeychainService(context.env)).toEqual({
      service: CLAUDE_KEYCHAIN_BASE_SERVICE,
      scoped: false,
    })
    expect(deriveClaudeKeychainCoordinate({ env: context.env, home: HOME }).storageDirectory).toBe(
      join(HOME, '.claude'),
    )
  })

  it("the machine's own account keeps the operator's selectors (guard)", () => {
    const claude = harnessContext(inventory, 'claude-code', OPERATOR)
    expect(claude.env.CLAUDE_CONFIG_DIR).toBe(OPERATOR_ENV.CLAUDE_CONFIG_DIR)
    expect(claude.roots.state).toBe(OPERATOR_ENV.CLAUDE_CONFIG_DIR)
    expect(harnessChildEnv(claude, {}).env.CLAUDE_CONFIG_DIR).toBe(OPERATOR_ENV.CLAUDE_CONFIG_DIR)
    // Its keychain item is the one the operator's own `claude` uses.
    expect(claudeKeychainService(claude.env)).toEqual(
      claudeKeychainService({
        CLAUDE_SECURESTORAGE_CONFIG_DIR: OPERATOR_ENV.CLAUDE_SECURESTORAGE_CONFIG_DIR,
      }),
    )
    const opencode = harnessContext(inventory, 'opencode', `${OPERATOR}/`)
    expect(opencode.roots.state).toBe(join(OPERATOR_ENV.XDG_DATA_HOME, 'opencode'))
    expect(harnessChildEnv(opencode, {}).env.XDG_CONFIG_HOME).toBe(OPERATOR_ENV.XDG_CONFIG_HOME)
  })

  it('a session-chosen CLAUDE_CONFIG_DIR still reaches a named child (guard)', () => {
    const context = harnessContext(inventory, 'claude-code', HOME)
    const pinned = join(HOME, '.claude')
    const child = harnessChildEnv(context, { sessionEnv: { CLAUDE_CONFIG_DIR: pinned } })
    expect(child.env.CLAUDE_CONFIG_DIR).toBe(pinned)
    expect(child.strip).not.toContain('CLAUDE_CONFIG_DIR')
  })
})
