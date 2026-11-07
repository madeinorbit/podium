// THE ONE CHILD ENVIRONMENT (POD-6535, design §3.5): a table over the layer
// order and the two strip rules.
import { delimiter } from 'node:path'
import type { BuiltinHarnessKind } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { harnessChildEnv, harnessRoots } from './harness-context.js'
import type { HarnessContext } from './harness-context-types.js'

const HOME = '/state/agent-home'

function context(
  kind: BuiltinHarnessKind,
  env: Record<string, string>,
  home = HOME,
): HarnessContext {
  return {
    installation: { kind, executable: `/opt/${kind}`, version: '', generation: 1 },
    home,
    env,
    roots: harnessRoots(kind, home, env),
  }
}

/** PATH entries other than the account home's own install roots. */
function machinePath(path: string | undefined, home = HOME): string[] {
  return (path ?? '').split(delimiter).filter((entry) => !entry.startsWith(`${home}/`))
}

describe('every layer overrides the one before it', () => {
  // One key per boundary, each set in the layer that must win and in every
  // layer below it.
  const ctx = context('codex', {
    MACHINE_ONLY: 'machine',
    SESSION_WINS: 'machine',
    WIRING_WINS: 'machine',
    PODIUM_WINS: 'machine',
    HOME: '/home/operator',
    CODEX_HOME: '/home/operator/.codex',
    PATH: '/machine/bin',
  })
  const { env } = harnessChildEnv(ctx, {
    sessionEnv: {
      SESSION_WINS: 'session',
      WIRING_WINS: 'session',
      PODIUM_WINS: 'session',
      HOME: '/session/home',
      CODEX_HOME: '/session/.codex',
      PATH: '/session/bin',
      CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT: '0',
    },
    wiringEnv: {
      WIRING_WINS: 'wiring',
      PODIUM_WINS: 'wiring',
      HOME: '/wiring/home',
      CODEX_HOME: '/wiring/.codex',
      CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT: '0',
    },
    podiumEnv: { PODIUM_WINS: 'podium' },
  })

  it.each([
    ['1 the machine command env is the base', 'MACHINE_ONLY', 'machine'],
    ['3 session env over the machine env (PATH included)', 'SESSION_WINS', 'session'],
    ['4 wiring env over the session env', 'WIRING_WINS', 'wiring'],
    [
      '4 the adapter declaration over the wiring env',
      'CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT',
      '1',
    ],
    ['5 account HOME over session and wiring', 'HOME', HOME],
    ['5 instance selector over session and wiring', 'CODEX_HOME', `${HOME}/.codex`],
    ['6 Podium vars over everything', 'PODIUM_WINS', 'podium'],
  ])('%s', (_layer, key, value) => {
    expect(env[key]).toBe(value)
  })

  it('3 the session PATH beats the machine PATH; 6 prefixes it', () => {
    expect(machinePath(env.PATH)).toEqual(['/session/bin'])
  })
})

describe('the two strip rules', () => {
  const inherited = context('claude-code', {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-inherited',
    ANTHROPIC_AUTH_TOKEN: 'tok-inherited',
    CLAUDE_CODE_SESSION_ID: 'parent-conversation',
  })

  it.each([
    ['an inherited foreign credential is removed', {}, 'ANTHROPIC_API_KEY', undefined],
    [
      'the same key in spec.env is kept',
      { ANTHROPIC_API_KEY: 'sk-chosen' },
      'ANTHROPIC_API_KEY',
      'sk-chosen',
    ],
    [
      'keeping one chosen key narrows nothing else',
      { ANTHROPIC_API_KEY: 'sk-chosen' },
      'ANTHROPIC_AUTH_TOKEN',
      undefined,
    ],
    [
      'a removeInherited key is removed from the FINAL env even when spec.env sets it',
      { CLAUDE_CODE_SESSION_ID: 'set-on-the-frame' },
      'CLAUDE_CODE_SESSION_ID',
      undefined,
    ],
  ])('%s', (_case, sessionEnv, key, value) => {
    const child = harnessChildEnv(inherited, { sessionEnv })
    expect(child.env[key]).toBe(value)
    // What a process layer that spreads the daemon env underneath must delete.
    expect(child.strip.includes(key)).toBe(value === undefined)
  })

  it('a foreign credential from the wiring env is not chosen either', () => {
    const child = harnessChildEnv(inherited, { wiringEnv: { ANTHROPIC_API_KEY: 'sk-wired' } })
    expect(child.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('a removeInherited key is removed whatever layer carries it', () => {
    const child = harnessChildEnv(inherited, {
      wiringEnv: { CLAUDE_CODE_SESSION_ID: 'wired' },
      podiumEnv: { CLAUDE_CODE_SESSION_ID: 'podium' },
    })
    expect(child.env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
  })

  it('lists credentials first, then parent controls, then the operator selectors the child lacks', () => {
    expect(harnessChildEnv(inherited, {}).strip).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH',
      // POD-6604: neither is in the child's env, so the boundary deletes the
      // daemon's own copy too.
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
    ])
  })
})

describe('PATH', () => {
  it('leads with the desktop-owned Podium CLI, which neither session nor wiring can redirect', () => {
    const cli = '/Applications/Podium.app/Contents/Resources/resources/podium'
    const { env } = harnessChildEnv(
      context('opencode', { PATH: '/usr/bin', PODIUM_CLI_PATH: cli }),
      {
        sessionEnv: { PATH: '/session/bin:/usr/bin', PODIUM_CLI_PATH: '/stale/session/podium' },
        wiringEnv: { PODIUM_CLI_PATH: '/stale/harness/podium' },
      },
    )
    expect(env.PODIUM_CLI_PATH).toBe(cli)
    expect(env.PATH?.split(delimiter)[0]).toBe(
      '/Applications/Podium.app/Contents/Resources/resources',
    )
    expect(machinePath(env.PATH).slice(1)).toEqual(['/session/bin', '/usr/bin'])
  })

  it("prepends the account home's install roots that PATH lacks", () => {
    const { env } = harnessChildEnv(context('opencode', { PATH: '/usr/bin' }), {})
    expect(env.PATH?.split(delimiter)).toEqual([
      `${HOME}/.local/bin`,
      `${HOME}/.bun/bin`,
      `${HOME}/.opencode/bin`,
      '/usr/bin',
    ])
  })

  it('leaves a root PATH already holds where it is', () => {
    const path = ['/opt/homebrew/bin', `${HOME}/.local/bin`, `${HOME}/.bun/bin`, '/usr/bin']
    const { env } = harnessChildEnv(context('opencode', { PATH: path.join(delimiter) }), {})
    expect(env.PATH?.split(delimiter)).toEqual([`${HOME}/.opencode/bin`, ...path])
  })
})
