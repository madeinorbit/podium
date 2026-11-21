/**
 * THE PODIUM HOME PER HARNESS (POD-7271, managed installs §4.3 to §4.6).
 *
 * Real folders throughout: the person's own harness folders under a fake
 * account HOME, Podium's homes under a fake state folder. The cases follow
 * the task's acceptance list:
 *
 * - the folder, its listing and its own removal confirmation;
 * - which home a session runs in, with and without a managed install;
 * - sign-in folders link from the Podium home; re-pointing replaces links only;
 * - the fill copies exactly the listed entries, twice is a no-op, and the
 *   person's folder is byte-identical afterwards;
 * - the first launch in a fresh Podium home asks nothing;
 * - a conversation moves into the Podium home, and a switch on Podium's side
 *   copies none;
 * - posture's edits for a Podium-home session stay inside the Podium home.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  type HarnessContext,
  harnessChildEnv,
  harnessCommand,
  launchTerms,
  manifestFor,
  type ResolvedHarnessInventory,
} from '@podium/harness'
import { asSessionId, type BuiltinHarnessKind, type SessionId } from '@podium/model'
import { type AccessField, podiumHomeId } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deliveryOverlay, memoryMarkers, SessionAccessStore } from '../control/access'
import type { DaemonContext } from '../control/context'
import { planTomlTablesReplace, tomlTablesUnder } from '../harness-home-toml'
import {
  buildSessionHarnessContext,
  recordedSessionHarnessContext,
} from '../session-harness-context'
import { sessionInstallRow } from '../session-installs'
import { testHarnessSnapshot } from '../test-support/harness-snapshot'
import { prepareConversation } from './conversation'
import { FILLED_RECORD, fillPodiumHome } from './fill'
import { PodiumHomes, personFolderOf } from './podium-home'
import { HomeRegistry, isPodiumHome } from './registry'
import { linkShared, repointSignInFolders } from './share'

const KEY_CRED = 'cred_aaaaaaaa-0000-4000-8000-0000000000a1'
const OTHER_KEY_CRED = 'cred_aaaaaaaa-0000-4000-8000-0000000000a2'
const SIGNED_IN = 'cred_bbbbbbbb-0000-4000-8000-0000000000b1'
const OWN_LOGIN = 'cred_cccccccc-0000-4000-8000-0000000000c1'

const ANTHROPIC_KEY = 'sk-ant-api03-PODIUM-TEST-KEY-0123456789abcdefghij'
const OPENAI_KEY = 'sk-PODIUM-TEST-KEY-0123456789abcdefghijklmnop'

const PERSON_BIN = { 'claude-code': '/usr/local/bin/claude', codex: '/usr/local/bin/codex' }
const MANAGED_BIN = {
  'claude-code': '/state/harnesses/claude-code/1-2.1.311/claude',
  codex: '/state/harnesses/codex/1-0.171.0/bin/codex',
}

let root: string
let person: string
let homes: HomeRegistry

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-home-'))
  person = join(root, 'person')
  mkdirSync(person, { recursive: true })
  homes = new HomeRegistry({ root: join(root, 'state', 'homes') })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

/** Every file and link under `dir`: its path, its bytes' hash or link target, its mode and mtime. */
function listing(dir: string, withTimes = false): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      const stat = lstatSync(path)
      const key = relative(dir, path)
      const time = withTimes ? ` ${stat.mtimeMs}` : ''
      if (stat.isSymbolicLink()) out[key] = `link ${readlinkSync(path)}${time}`
      else if (stat.isDirectory()) {
        out[key] = `dir ${(stat.mode & 0o777).toString(8)}${time}`
        walk(path)
      } else {
        const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
        out[key] = `file ${hash} ${(stat.mode & 0o777).toString(8)}${time}`
      }
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

/** A snapshot with the person's install of both harnesses, and Podium's when `managed`. */
function snapshot(managed: boolean): ResolvedHarnessInventory {
  return testHarnessSnapshot(PERSON_BIN, 1, managed ? MANAGED_BIN : {})
}

function contextSource(access: SessionAccessStore, snap: ResolvedHarnessInventory): DaemonContext {
  return {
    homeDir: person,
    access,
    homes,
    harnessRuntime: { current: async () => snap, settled: () => snap },
  } as unknown as DaemonContext
}

const apiKeyAccess = (harness: BuiltinHarnessKind, credentialId = KEY_CRED): AccessField => ({
  credentialId,
  delivery:
    harness === 'codex'
      ? { kind: 'env', variable: 'OPENAI_API_KEY', secret: OPENAI_KEY }
      : { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: ANTHROPIC_KEY },
})

type SessionKind = 'api-key' | 'own-login' | 'no-credential' | 'sign-in'

async function sessionOn(
  access: SessionAccessStore,
  harness: BuiltinHarnessKind,
  kind: SessionKind,
): Promise<SessionId> {
  const sessionId = asSessionId(`s-${harness}-${kind}`)
  if (kind === 'api-key') access.remember(sessionId, apiKeyAccess(harness), harness)
  if (kind === 'own-login') {
    access.remember(
      sessionId,
      { credentialId: OWN_LOGIN, delivery: { kind: 'home', homeId: 'default' } },
      harness,
    )
  }
  if (kind === 'sign-in') {
    const { home } = await homes.ensure(SIGNED_IN, harness as 'codex' | 'claude-code')
    access.remember(
      sessionId,
      { credentialId: SIGNED_IN, delivery: { kind: 'home', homeId: home.homeId } },
      harness,
    )
  }
  return sessionId
}

describe('the Podium home in the home registry', () => {
  it('is <state>/homes/podium/<harness>, owner-only, and listed with the other homes', async () => {
    const { home, created } = homes.ensurePodiumHome('codex')
    await homes.ensure(SIGNED_IN, 'codex')
    expect(created).toBe(true)
    expect(home).toEqual({
      homeId: 'podium:codex',
      credentialId: 'podium',
      harness: 'codex',
      dir: join(root, 'state', 'homes', 'podium', 'codex'),
    })
    expect(statSync(home.dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, 'state', 'homes', 'podium')).mode & 0o777).toBe(0o700)
    expect(homes.ensurePodiumHome('codex').created).toBe(false)
    expect(homes.get(podiumHomeId('codex'))).toEqual(home)
    expect(homes.podiumHome('claude-code')).toBeUndefined()
    expect(
      homes
        .list()
        .map((h) => h.homeId)
        .sort(),
    ).toEqual([`${SIGNED_IN}:codex`, 'podium:codex'])
    expect(homes.list().filter(isPodiumHome)).toEqual([home])
  })

  it('is never removed with a credential, and only on its own confirmation', async () => {
    const { home } = homes.ensurePodiumHome('claude-code')
    write(join(home.dir, 'CLAUDE.md'), 'kept')
    const signIn = await homes.ensure(SIGNED_IN, 'claude-code')
    expect(await homes.remove(signIn.home.homeId)).toMatchObject({ removed: true })
    expect(existsSync(join(home.dir, 'CLAUDE.md'))).toBe(true)
    await expect(homes.remove('podium:claude-code')).rejects.toThrow(/its own confirmed request/)
    expect(existsSync(home.dir)).toBe(true)
    expect(await homes.remove('podium:claude-code', { podiumHomeConfirmed: true })).toMatchObject({
      removed: true,
    })
    expect(existsSync(home.dir)).toBe(false)
  })
})

describe('which home a session runs in (§4.2, §4.3)', () => {
  type Where = 'person' | 'podium' | 'sign-in'
  const expected: Record<'without' | 'with', Record<SessionKind, Where>> = {
    // Exactly as credential management built it.
    without: {
      'api-key': 'person',
      'own-login': 'person',
      'no-credential': 'person',
      'sign-in': 'sign-in',
    },
    with: {
      'api-key': 'podium',
      'own-login': 'person',
      'no-credential': 'person',
      'sign-in': 'sign-in',
    },
  }
  const cases = (['claude-code', 'codex'] as const).flatMap((harness) =>
    (['without', 'with'] as const).flatMap((install) =>
      (Object.keys(expected[install]) as SessionKind[]).map((kind) => ({
        harness,
        install,
        kind,
        where: expected[install][kind],
      })),
    ),
  )

  it.each(cases)('$harness, $install a managed install, $kind → $where', async (c) => {
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await sessionOn(access, c.harness, c.kind)
    const snap = snapshot(c.install === 'with')
    const context = await buildSessionHarnessContext(
      contextSource(access, snap),
      c.harness,
      sessionId,
    )
    const home = context.harnessHome
    if (c.where === 'person') {
      expect(home).toBeUndefined()
      // The person's folder always runs the person's binary.
      expect(context.installation.executable).toBe(PERSON_BIN[c.harness])
      expect(context.installation.provenance).toBe('external')
    } else if (c.where === 'podium') {
      expect(home?.id).toBe(podiumHomeId(c.harness))
      expect(home?.dir).toBe(join(root, 'state', 'homes', 'podium', c.harness))
      expect(context.installation.executable).toBe(MANAGED_BIN[c.harness])
    } else {
      expect(home?.id).toBe(`${SIGNED_IN}:${c.harness}`)
    }
  })

  it('after a restart, before the server’s refresh, an env marker still runs in the Podium home', () => {
    const markers = memoryMarkers()
    const before = new SessionAccessStore({ markers })
    const sessionId = asSessionId('s-restarted')
    before.remember(sessionId, apiKeyAccess('codex'), 'codex')
    const after = new SessionAccessStore({ markers })
    expect(after.homeIdOf(sessionId)).toBeUndefined()
    expect(after.homeIdOf(sessionId, { managedInstall: () => false })).toBeUndefined()
    expect(after.homeIdOf(sessionId, { managedInstall: (k) => k === 'codex' })).toBe('podium:codex')
  })

  it('a harness with no home variable is never sent to a Podium home', () => {
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = asSessionId('s-opencode')
    access.remember(
      sessionId,
      {
        credentialId: KEY_CRED,
        delivery: { kind: 'env', variable: 'OPENROUTER_API_KEY', secret: 'x' },
      },
      'opencode',
    )
    expect(access.homeIdOf(sessionId, { managedInstall: () => true })).toBeUndefined()
  })
})

describe('re-attach after a restart follows the recorded install (§6.2)', () => {
  /** The daemon restarted: the session's process lives on, its row says what it runs. */
  async function reattach(
    harness: BuiltinHarnessKind,
    startedManaged: boolean,
    nowManaged: boolean,
  ) {
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await sessionOn(access, harness, 'api-key')
    const started = await buildSessionHarnessContext(
      contextSource(access, snapshot(startedManaged)),
      harness,
      sessionId,
    )
    const row = sessionInstallRow(sessionId, started.installation)
    const ctx = {
      ...contextSource(access, snapshot(nowManaged)),
      sessionInstalls: { get: (id: SessionId) => (id === sessionId ? row : undefined) },
    } as unknown as DaemonContext
    return { started, again: await recordedSessionHarnessContext(ctx, sessionId, harness) }
  }

  it.each([
    'claude-code',
    'codex',
  ] as const)('%s: started in the person’s folder, a managed install appeared since: still the person’s folder', async (harness) => {
    const { started, again } = await reattach(harness, false, true)
    expect(started.harnessHome).toBeUndefined()
    expect(again?.harnessHome).toBeUndefined()
    expect(again?.installation.executable).toBe(PERSON_BIN[harness])
  })

  it.each([
    'claude-code',
    'codex',
  ] as const)('%s: started in the Podium home on Podium’s install: the Podium home, whatever the inventory says now', async (harness) => {
    for (const nowManaged of [true, false]) {
      const { started, again } = await reattach(harness, true, nowManaged)
      expect(started.harnessHome?.id).toBe(podiumHomeId(harness))
      expect(again?.harnessHome?.id).toBe(podiumHomeId(harness))
      expect(again?.installation.executable).toBe(MANAGED_BIN[harness])
    }
  })
})

describe('sign-in folders on Podium’s side link from the Podium home (§4.6)', () => {
  function personClaude(): string {
    const dir = join(person, '.claude')
    write(join(dir, 'settings.json'), '{"person":true}')
    write(join(dir, 'CLAUDE.md'), 'person instructions')
    mkdirSync(join(dir, 'skills'), { recursive: true })
    return dir
  }

  it('without a managed install it links the person’s folder, as built', async () => {
    const dir = personClaude()
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await sessionOn(access, 'claude-code', 'sign-in')
    const context = await buildSessionHarnessContext(
      contextSource(access, snapshot(false)),
      'claude-code',
      sessionId,
    )
    const signIn = context.harnessHome?.dir as string
    expect(readlinkSync(join(signIn, 'CLAUDE.md'))).toBe(join(dir, 'CLAUDE.md'))
    expect(homes.podiumHome('claude-code')).toBeUndefined()
  })

  it('with one, every link points into the Podium home and none into the person’s folder', async () => {
    personClaude()
    const podium = homes.ensurePodiumHome('claude-code').home
    write(join(podium.dir, 'settings.json'), '{"podium":true}')
    write(join(podium.dir, 'CLAUDE.md'), 'podium instructions')
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await sessionOn(access, 'claude-code', 'sign-in')
    const context = await buildSessionHarnessContext(
      contextSource(access, snapshot(true)),
      'claude-code',
      sessionId,
    )
    const signIn = context.harnessHome?.dir as string
    expect(context.installation.executable).toBe(MANAGED_BIN['claude-code'])
    expect(readlinkSync(join(signIn, 'settings.json'))).toBe(join(podium.dir, 'settings.json'))
    expect(readlinkSync(join(signIn, 'CLAUDE.md'))).toBe(join(podium.dir, 'CLAUDE.md'))
    // The person has skills, the Podium home does not: no link at all.
    expect(existsSync(join(signIn, 'skills'))).toBe(false)
    for (const target of Object.values(listing(signIn))) expect(target).not.toContain(person)
  })

  it('re-pointing replaces links only; a real file in the way is left and reported', async () => {
    const dir = personClaude()
    const signIn = (await homes.ensure(SIGNED_IN, 'claude-code')).home
    linkShared(signIn, dir)
    // The folder's own settings, written by a person or the harness: not a link.
    rmSync(join(signIn.dir, 'settings.json'))
    write(join(signIn.dir, 'settings.json'), '{"own":true}')
    const podium = homes.ensurePodiumHome('claude-code').home
    write(join(podium.dir, 'settings.json'), '{}')
    write(join(podium.dir, 'CLAUDE.md'), 'podium')

    const [report] = repointSignInFolders(homes.list(), 'claude-code', podium.dir)
    expect(report).toEqual({
      homeId: signIn.homeId,
      linked: [],
      repointed: ['CLAUDE.md'],
      // The person's skills link: the Podium home has none to point it at.
      unlinked: ['skills'],
      leftInPlace: ['settings.json'],
    })
    expect(readlinkSync(join(signIn.dir, 'CLAUDE.md'))).toBe(join(podium.dir, 'CLAUDE.md'))
    expect(lstatSync(join(signIn.dir, 'settings.json')).isSymbolicLink()).toBe(false)
    expect(readJson(join(signIn.dir, 'settings.json'))).toEqual({ own: true })
    // A second pass changes nothing.
    expect(repointSignInFolders(homes.list(), 'claude-code', podium.dir)[0]).toMatchObject({
      linked: [],
      repointed: [],
      unlinked: [],
    })
  })

  it('a managed install appearing makes, fills and re-points once (reconcile)', async () => {
    const dir = personClaude()
    const signIn = (await homes.ensure(SIGNED_IN, 'claude-code')).home
    linkShared(signIn, dir)
    const service = new PodiumHomes({
      homes,
      personFolder: async (harness) => personFolderOf(harness, { home: person, env: {} }),
    })
    expect(await service.reconcile(() => false)).toEqual([])
    expect(homes.podiumHome('claude-code')).toBeUndefined()

    const [ready] = await service.reconcile((harness) => harness === 'claude-code')
    const podium = homes.podiumHome('claude-code')
    expect(ready?.home).toEqual(podium)
    expect(ready?.fill?.copied).toContain('CLAUDE.md')
    expect(readFileSync(join(podium?.dir as string, 'CLAUDE.md'), 'utf8')).toBe(
      'person instructions',
    )
    expect(readlinkSync(join(signIn.dir, 'CLAUDE.md'))).toBe(
      join(podium?.dir as string, 'CLAUDE.md'),
    )
    // Filled once: a later wave leaves it alone.
    expect(await service.reconcile((harness) => harness === 'claude-code')).toEqual([])
  })
})

describe('filling the Podium home from the person’s folder (§4.5)', () => {
  function personClaude(): { dir: string; state: string } {
    const dir = join(person, '.claude')
    write(
      join(dir, 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(rm *)'], defaultMode: 'bypassPermissions' },
        hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] },
        autoUpdates: false,
        autoUpdatesChannel: 'stable',
        env: { DISABLE_AUTOUPDATER: '1', ANTHROPIC_API_KEY: 'sk-ant-person' },
        enabledPlugins: { 'tool@market': true },
        extraKnownMarketplaces: {
          market: { source: { source: 'directory', path: join(dir, 'm') } },
        },
      }),
    )
    write(join(dir, 'CLAUDE.md'), 'person instructions')
    write(join(dir, 'skills', 'review', 'SKILL.md'), 'a skill')
    write(join(dir, 'skills', 'review', 'run.sh'), '#!/bin/sh\n')
    // A link inside a copied folder that points into the person's folder.
    mkdirSync(join(dir, 'skills'), { recursive: true })
    write(join(dir, 'agents', 'planner.md'), 'an agent')
    write(join(dir, 'commands', 'ship.md'), 'a command')
    write(
      join(dir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'tool@market': [{ scope: 'user', installPath: join(dir, 'plugins', 'cache', 'tool') }],
        },
      }),
    )
    write(join(dir, 'plugins', 'cache', 'tool', 'plugin.json'), '{"name":"tool"}')
    // Never copied: the login, conversations, history, harness state.
    write(join(dir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"secret"}}')
    write(join(dir, 'projects', '-work', 'conversation.jsonl'), '{"type":"user"}\n')
    write(join(dir, 'history.jsonl'), '{}\n')
    const state = write(
      join(person, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: { emailAddress: 'person@example.com' },
        projects: { '/work': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } },
        customApiKeyResponses: { approved: ['person-key-suffix'], rejected: [] },
        autoUpdates: true,
        mcpServers: { docs: { command: 'docs-mcp', args: ['--stdio'] } },
      }),
    )
    return { dir, state }
  }

  function personCodex(): string {
    const dir = join(person, '.codex')
    write(
      join(dir, 'config.toml'),
      [
        'model = "gpt-5.5"',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        'check_for_update_on_startup = false',
        '',
        '[projects."/work"]',
        'trust_level = "trusted"',
        '',
        '[mcp_servers.docs]',
        'command = "docs-mcp"',
        'args = ["--stdio"]',
        '',
        '[mcp_servers.docs.env]',
        'DOCS_TOKEN = "t"',
        '',
        '[hooks]',
        'enabled = true',
        '',
        '[mcp_servers."search tool"]',
        'url = "https://example.invalid/mcp"',
        '',
      ].join('\n'),
    )
    write(join(dir, 'AGENTS.md'), 'person instructions')
    write(join(dir, 'skills', 'review', 'SKILL.md'), 'a skill')
    write(join(dir, 'prompts', 'ship.md'), 'a prompt')
    write(join(dir, 'auth.json'), '{"OPENAI_API_KEY":"sk-person"}')
    write(join(dir, 'hooks.json'), '{}')
    write(join(dir, 'sessions', '2026', '11', '20', 'rollout-x.jsonl'), '{}\n')
    return dir
  }

  it('Claude Code: the listed entries, plugin keys and MCP servers, nothing else', () => {
    const { dir, state } = personClaude()
    const home = homes.ensurePodiumHome('claude-code').home
    const report = fillPodiumHome('claude-code', { dir, claudeState: state }, home.dir)
    expect(report.left).toEqual([])
    expect(report.copied.sort()).toEqual(
      [
        '.claude.json mcpServers',
        'CLAUDE.md',
        'agents',
        'commands',
        'plugins',
        'settings.json',
        'skills',
      ].sort(),
    )
    expect(Object.keys(listing(home.dir)).sort()).toEqual(
      [
        '.claude.json',
        FILLED_RECORD,
        'CLAUDE.md',
        'agents',
        'agents/planner.md',
        'commands',
        'commands/ship.md',
        'plugins',
        'plugins/cache',
        'plugins/cache/tool',
        'plugins/cache/tool/plugin.json',
        'plugins/installed_plugins.json',
        'settings.json',
        'skills',
        'skills/review',
        'skills/review/SKILL.md',
        'skills/review/run.sh',
      ].sort(),
    )
    // Of the settings, only which plugins are on and where they come from.
    expect(readJson(join(home.dir, 'settings.json'))).toEqual({
      enabledPlugins: { 'tool@market': true },
      extraKnownMarketplaces: {
        market: { source: { source: 'directory', path: join(home.dir, 'm') } },
      },
    })
    // Of the state file, only the MCP servers: no identity, trust, key answers or updates.
    expect(readJson(join(home.dir, '.claude.json'))).toEqual({
      mcpServers: { docs: { command: 'docs-mcp', args: ['--stdio'] } },
    })
    // The plugin record names the home's copy, not the person's.
    expect(readFileSync(join(home.dir, 'plugins', 'installed_plugins.json'), 'utf8')).not.toContain(
      dir,
    )
    expect(
      readJson(join(home.dir, 'plugins', 'installed_plugins.json')).plugins as Record<
        string,
        { installPath: string }[]
      >,
    ).toEqual({
      'tool@market': [{ scope: 'user', installPath: join(home.dir, 'plugins', 'cache', 'tool') }],
    })
  })

  it('Codex: instructions, skills, prompts and the MCP server tables, nothing else', () => {
    const dir = personCodex()
    const home = homes.ensurePodiumHome('codex').home
    const report = fillPodiumHome('codex', { dir }, home.dir)
    expect(report.left).toEqual([])
    expect(Object.keys(listing(home.dir)).sort()).toEqual(
      [
        FILLED_RECORD,
        'AGENTS.md',
        'config.toml',
        'prompts',
        'prompts/ship.md',
        'skills',
        'skills/review',
        'skills/review/SKILL.md',
      ].sort(),
    )
    expect(readFileSync(join(home.dir, 'config.toml'), 'utf8')).toBe(
      [
        '[mcp_servers.docs]',
        'command = "docs-mcp"',
        'args = ["--stdio"]',
        '',
        '[mcp_servers.docs.env]',
        'DOCS_TOKEN = "t"',
        '',
        '[mcp_servers."search tool"]',
        'url = "https://example.invalid/mcp"',
        '',
      ].join('\n'),
    )
  })

  it('a second fill changes nothing, and the person’s folders stay byte-identical', () => {
    const claude = personClaude()
    const codex = personCodex()
    const personBefore = listing(person, true)
    const claudeHome = homes.ensurePodiumHome('claude-code').home
    const codexHome = homes.ensurePodiumHome('codex').home
    fillPodiumHome('claude-code', claude, claudeHome.dir)
    fillPodiumHome('codex', { dir: codex }, codexHome.dir)
    const homesAfterFirst = { ...listing(claudeHome.dir, true), ...listing(codexHome.dir, true) }

    const again = [
      fillPodiumHome('claude-code', claude, claudeHome.dir),
      fillPodiumHome('codex', { dir: codex }, codexHome.dir),
    ]
    expect(again.map((r) => r.copied)).toEqual([[], []])
    expect({ ...listing(claudeHome.dir, true), ...listing(codexHome.dir, true) }).toEqual(
      homesAfterFirst,
    )
    expect(listing(person, true)).toEqual(personBefore)
  })

  it('takes what the person changed since, and keeps what the home has of its own', () => {
    const codex = personCodex()
    const home = homes.ensurePodiumHome('codex').home
    fillPodiumHome('codex', { dir: codex }, home.dir)
    // The home's own: Codex wrote a trust entry there, someone added a server.
    write(
      join(home.dir, 'config.toml'),
      `${readFileSync(join(home.dir, 'config.toml'), 'utf8')}\n[projects."/srv"]\ntrust_level = "trusted"\n\n[mcp_servers.own]\ncommand = "own"\n`,
    )
    write(join(home.dir, 'skills', 'own', 'SKILL.md'), 'home skill')
    write(join(codex, 'AGENTS.md'), 'changed instructions')
    const report = fillPodiumHome('codex', { dir: codex }, home.dir)
    expect(report.copied).toEqual(['AGENTS.md'])
    expect(readFileSync(join(home.dir, 'AGENTS.md'), 'utf8')).toBe('changed instructions')
    expect(readFileSync(join(home.dir, 'skills', 'own', 'SKILL.md'), 'utf8')).toBe('home skill')
    const config = readFileSync(join(home.dir, 'config.toml'), 'utf8')
    expect(config).toContain('[projects."/srv"]')
    expect(config).toContain('[mcp_servers.own]')
    expect(config.match(/\[mcp_servers\.docs\]/g)).toHaveLength(1)
  })

  it('an MCP server written in a form the copy does not lift is reported, the home untouched', () => {
    const dir = join(person, '.codex')
    write(join(dir, 'config.toml'), 'mcp_servers.docs.command = "docs"\n')
    const home = homes.ensurePodiumHome('codex').home
    const report = fillPodiumHome('codex', { dir }, home.dir)
    expect(report.left).toEqual([
      {
        entry: 'config.toml mcp_servers',
        reason: 'mcp_servers.docs.command is written in a form this copy does not lift',
      },
    ])
    expect(existsSync(join(home.dir, 'config.toml'))).toBe(false)
  })

  it('a link inside a copied folder that points into the person’s folder points into the home', () => {
    const dir = join(person, '.claude')
    write(join(dir, 'skills', 'real', 'SKILL.md'), 'real')
    mkdirSync(join(dir, 'skills'), { recursive: true })
    const outside = write(join(root, 'repo', 'skill', 'SKILL.md'), 'outside')
    symlinkSync(join(dir, 'skills', 'real'), join(dir, 'skills', 'alias'))
    symlinkSync(dirname(outside), join(dir, 'skills', 'external'))
    const home = homes.ensurePodiumHome('claude-code').home
    fillPodiumHome('claude-code', { dir }, home.dir)
    expect(readlinkSync(join(home.dir, 'skills', 'alias'))).toBe(join(home.dir, 'skills', 'real'))
    expect(readlinkSync(join(home.dir, 'skills', 'external'))).toBe(dirname(outside))
  })
})

describe('the TOML table copy', () => {
  it('replacing tables twice gives the same text', () => {
    const person = '[mcp_servers.a]\ncommand = "a"\n\n[mcp_servers.a.env]\nK = "v"\n'
    const lifted = tomlTablesUnder(person, ['mcp_servers'])
    if ('reason' in lifted) throw new Error(lifted.reason)
    const home =
      'model = "x"\n\n[mcp_servers.a]\ncommand = "old"\n\n[projects."/p"]\ntrust_level = "trusted"\n'
    const once = planTomlTablesReplace(home, ['mcp_servers'], lifted.tables)
    if ('reason' in once) throw new Error(once.reason)
    expect(once.next).toBe(
      'model = "x"\n\n[projects."/p"]\ntrust_level = "trusted"\n\n[mcp_servers.a]\ncommand = "a"\n\n[mcp_servers.a.env]\nK = "v"\n',
    )
    const twice = planTomlTablesReplace(once.next, ['mcp_servers'], lifted.tables)
    expect(twice).toEqual({ next: once.next })
  })
})

describe('the first launch in a fresh Podium home asks nothing (§4.3, POD-7267)', () => {
  it('Claude Code on an API key: onboarding done and the key approved, never written whole', async () => {
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await sessionOn(access, 'claude-code', 'api-key')
    const context = await buildSessionHarnessContext(
      contextSource(access, snapshot(true)),
      'claude-code',
      sessionId,
    )
    const dir = context.harnessHome?.dir as string
    const state = readJson(join(dir, '.claude.json'))
    expect(state.hasCompletedOnboarding).toBe(true)
    expect(state.customApiKeyResponses).toEqual({
      approved: [ANTHROPIC_KEY.slice(-20)],
      rejected: [],
    })
    expect(statSync(join(dir, '.claude.json')).mode & 0o777).toBe(0o600)
    for (const name of readdirSync(dir)) {
      expect(readFileSync(join(dir, name), 'utf8')).not.toContain(ANTHROPIC_KEY)
    }
    // The Podium home links nothing: it shares no folder of the person's.
    for (const entry of Object.values(listing(dir))) expect(entry.startsWith('link')).toBe(false)
  })

  it('Codex on an API key: a provider that reads the variable, only in the Podium home', () => {
    const access = apiKeyAccess('codex')
    const inPodium = deliveryOverlay('codex', access, { podiumHome: true })
    expect(inPodium.args).toContain('model_provider="podium_openai_api_key"')
    expect(inPodium.args).toContain(
      'model_providers.podium_openai_api_key.env_key="OPENAI_API_KEY"',
    )
    expect(inPodium.args.join(' ')).not.toContain(OPENAI_KEY)
    expect(inPodium.env.OPENAI_API_KEY).toBe(OPENAI_KEY)
    // The person's folder: as credential management built it.
    expect(deliveryOverlay('codex', access).args.join(' ')).not.toContain('model_provider')
  })
})

describe('the conversation moves into the Podium home (§4.6 item 4)', () => {
  const THREAD = '019a7f00-0000-7000-8000-00000000d00d'
  const rolloutRel = join(
    'sessions',
    '2026',
    '11',
    '20',
    `rollout-2026-11-20T10-00-00-${THREAD}.jsonl`,
  )
  const ROLLOUT = `${[
    JSON.stringify({ type: 'session_meta', payload: { id: THREAD, model_provider: 'openai' } }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: 'My code word is FIG-7.' },
    }),
  ].join('\n')}\n`

  const deps = (managed: boolean) => ({
    account: { home: person, env: {} },
    homes,
    managedInstall: (harness: string) => managed && harness === 'codex',
    now: () => 1_700_000_000_000,
  })
  const request = (account: string, fromAccount?: string) => ({
    agentKind: 'codex' as const,
    cwd: '/work',
    resume: { kind: 'codex-thread' as const, value: THREAD },
    toHomeId: 'default',
    toDelivery: 'env' as const,
    account,
    ...(fromAccount ? { fromAccount } : {}),
  })

  it('a session that ran in the person’s folder continues the same conversation there', async () => {
    const original = write(join(person, '.codex', rolloutRel), ROLLOUT)
    const placed = await prepareConversation(deps(true), request(KEY_CRED))
    const podium = homes.podiumHome('codex')?.dir as string
    expect(placed).toMatchObject({ ok: true, placed: 'copied', path: join(podium, rolloutRel) })
    const moved = readFileSync(join(podium, rolloutRel), 'utf8')
    expect(moved).toContain('FIG-7')
    // Recorded under the provider the Podium home runs an API key on.
    expect(JSON.parse(moved.split('\n')[0] as string).payload.model_provider).toBe(
      'podium_openai_api_key',
    )
    expect(readFileSync(original, 'utf8')).toBe(ROLLOUT)
  })

  it('without a managed install the conversation stays where credential management put it', async () => {
    write(join(person, '.codex', rolloutRel), ROLLOUT)
    expect(await prepareConversation(deps(false), request(KEY_CRED))).toMatchObject({
      ok: true,
      placed: 'in-place',
    })
    expect(homes.podiumHome('codex')).toBeUndefined()
  })

  it('switching between two passed-in credentials on Podium’s side copies nothing', async () => {
    const podium = homes.ensurePodiumHome('codex').home.dir
    const inHome = ROLLOUT.replace('"openai"', '"podium_openai_api_key"')
    write(join(podium, rolloutRel), inHome)
    const personBefore = listing(person)
    const placed = await prepareConversation(deps(true), request(OTHER_KEY_CRED, KEY_CRED))
    expect(placed.ok && placed.placed).not.toBe('copied')
    expect(placed).toMatchObject({ ok: true, path: join(podium, rolloutRel) })
    expect(listing(person)).toEqual(personBefore)
  })
})

describe('posture’s edits for a Podium-home session stay in the Podium home (§6.4)', () => {
  it.each(['claude-code', 'codex'] as const)('%s', async (harness) => {
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await sessionOn(access, harness, 'api-key')
    const context: HarnessContext = await buildSessionHarnessContext(
      contextSource(access, snapshot(true)),
      harness,
      sessionId,
    )
    const home = context.harnessHome?.dir as string
    const manifest = manifestFor(harness)
    if (!manifest) throw new Error(`no manifest for ${harness}`)
    const command = harnessCommand(
      context,
      { args: [] },
      launchTerms(manifest, {
        mode: 'terminal',
        posture: { mode: 'autonomous' },
        workdir: '/work',
        runtimeDir: join(root, 'runtime'),
        context,
        grants: {
          podiumCli: { name: 'podium', path: '/bin/podium' },
          uploadsDir: join(root, 'uploads'),
          mcpServers: [],
        },
      }),
    )
    expect(command.terms.homeEdits.length).toBeGreaterThan(0)
    for (const edit of command.terms.homeEdits) {
      expect(resolve(edit.file).startsWith(`${resolve(home)}${sep}`)).toBe(true)
    }
    expect(command.homeEditScope?.personal).toBe(false)
    expect(command.harnessHomeId).toBe(podiumHomeId(harness))
  })
})

/**
 * GROK (POD-7370, managed installs §4.7): `GROK_HOME` moves its login,
 * config, hooks and sessions together (POD-7267), so Grok gets the same
 * Podium home and sign-in folders as Claude Code and Codex. Its login reaches
 * a home only as a sign-in folder: no passed-in Grok credential exists.
 */
describe('Grok in a Podium-made home (§4.7)', () => {
  const GROK_PERSON_BIN = '/usr/local/bin/grok'
  const GROK_MANAGED_BIN = '/state/harnesses/grok/1-1.0.89/grok'
  const grokSnapshot = (managed: boolean): ResolvedHarnessInventory =>
    testHarnessSnapshot({ grok: GROK_PERSON_BIN }, 1, managed ? { grok: GROK_MANAGED_BIN } : {})

  function personGrok(): string {
    const dir = join(person, '.grok')
    write(
      join(dir, 'config.toml'),
      [
        '[permission]',
        'allow = ["Bash(rm *)"]',
        '',
        '[cli]',
        'auto_update = true',
        '',
        '[mcp_servers.docs]',
        'command = "docs-mcp"',
        'args = ["--stdio"]',
        '',
        '[[hooks.PreToolUse]]',
        'command = "person-hook"',
        '',
        '[mcp_servers.search]',
        'url = "https://example.invalid/mcp"',
        '',
      ].join('\n'),
    )
    write(join(dir, 'AGENTS.md'), 'person rules')
    write(join(dir, 'skills', 'review', 'SKILL.md'), 'a skill')
    write(join(dir, 'agents', 'planner.md'), 'an agent')
    write(join(dir, 'plugins', 'tool', 'plugin.json'), '{"name":"tool"}')
    // Never copied or linked: the login, hooks, trust, memory, sessions.
    write(join(dir, 'auth.json'), '{"default":{"key":"secret","refresh_token":"r"}}')
    write(join(dir, 'hooks', 'person.json'), '{}')
    write(join(dir, 'trusted_folders.toml'), '[[folders]]\npath = "/work"\n')
    write(join(dir, 'memory-v2', 'index.json'), '{}')
    write(join(dir, 'sessions', '%2Fwork', 'abc', 'messages.jsonl'), '{}\n')
    return dir
  }

  async function grokSession(
    access: SessionAccessStore,
    kind: 'own-login' | 'sign-in',
  ): Promise<SessionId> {
    const sessionId = asSessionId(`s-grok-${kind}`)
    if (kind === 'own-login') {
      access.remember(
        sessionId,
        { credentialId: OWN_LOGIN, delivery: { kind: 'home', homeId: 'default' } },
        'grok',
      )
      return sessionId
    }
    const { home } = await homes.ensure(SIGNED_IN, 'grok')
    access.remember(
      sessionId,
      { credentialId: SIGNED_IN, delivery: { kind: 'home', homeId: home.homeId } },
      'grok',
    )
    return sessionId
  }

  it.each([
    false,
    true,
  ])('the person’s own login stays in ~/.grok on the person’s binary (managed: %s)', async (managed) => {
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await grokSession(access, 'own-login')
    const context = await buildSessionHarnessContext(
      contextSource(access, grokSnapshot(managed)),
      'grok',
      sessionId,
    )
    expect(context.harnessHome).toBeUndefined()
    expect(context.installation.executable).toBe(GROK_PERSON_BIN)
    // The account's own folder, as the instance-home rule sets it.
    expect(context.env.GROK_HOME).toBe(join(person, '.grok'))
    expect(context.roots.state).toBe(join(person, '.grok'))
  })

  it('a sign-in folder runs Podium’s Grok with GROK_HOME on the folder, linked from the Podium home', async () => {
    const own = personGrok()
    const before = listing(own, true)
    const podium = homes.ensurePodiumHome('grok').home
    write(join(podium.dir, 'config.toml'), '[mcp_servers.docs]\ncommand = "docs-mcp"\n')
    write(join(podium.dir, 'AGENTS.md'), 'podium rules')
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await grokSession(access, 'sign-in')
    const context = await buildSessionHarnessContext(
      contextSource(access, grokSnapshot(true)),
      'grok',
      sessionId,
    )
    const signIn = context.harnessHome?.dir as string
    expect(context.harnessHome?.id).toBe(`${SIGNED_IN}:grok`)
    expect(context.harnessHome?.variable).toBe('GROK_HOME')
    expect(context.env.GROK_HOME).toBe(signIn)
    expect(context.roots.state).toBe(signIn)
    expect(context.installation.executable).toBe(GROK_MANAGED_BIN)
    expect(readlinkSync(join(signIn, 'config.toml'))).toBe(join(podium.dir, 'config.toml'))
    expect(readlinkSync(join(signIn, 'AGENTS.md'))).toBe(join(podium.dir, 'AGENTS.md'))
    // The login, hooks and trust are the folder's own; nothing points at the person.
    for (const name of ['auth.json', 'hooks', 'trusted_folders.toml', 'sessions']) {
      expect(existsSync(join(signIn, name)), name).toBe(false)
    }
    for (const target of Object.values(listing(signIn))) expect(target).not.toContain(person)
    expect(listing(own, true)).toEqual(before)
  })

  it('without a managed install a sign-in folder links the person’s ~/.grok, as for Codex', async () => {
    const own = personGrok()
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await grokSession(access, 'sign-in')
    const context = await buildSessionHarnessContext(
      contextSource(access, grokSnapshot(false)),
      'grok',
      sessionId,
    )
    const signIn = context.harnessHome?.dir as string
    expect(context.installation.executable).toBe(GROK_PERSON_BIN)
    expect(
      ['config.toml', 'AGENTS.md', 'skills', 'agents', 'plugins'].map((name) =>
        readlinkSync(join(signIn, name)),
      ),
    ).toEqual(['config.toml', 'AGENTS.md', 'skills', 'agents', 'plugins'].map((n) => join(own, n)))
    expect(existsSync(join(signIn, 'auth.json'))).toBe(false)
    expect(homes.podiumHome('grok')).toBeUndefined()
  })

  it('the fill copies rules, skills, agents, plugins and the MCP server tables, nothing else', () => {
    const dir = personGrok()
    const before = listing(dir, true)
    const home = homes.ensurePodiumHome('grok').home
    const report = fillPodiumHome('grok', { dir }, home.dir)
    expect(report.left).toEqual([])
    expect(Object.keys(listing(home.dir)).sort()).toEqual(
      [
        FILLED_RECORD,
        'AGENTS.md',
        'agents',
        'agents/planner.md',
        'config.toml',
        'plugins',
        'plugins/tool',
        'plugins/tool/plugin.json',
        'skills',
        'skills/review',
        'skills/review/SKILL.md',
      ].sort(),
    )
    expect(readFileSync(join(home.dir, 'config.toml'), 'utf8')).toBe(
      [
        '[mcp_servers.docs]',
        'command = "docs-mcp"',
        'args = ["--stdio"]',
        '',
        '[mcp_servers.search]',
        'url = "https://example.invalid/mcp"',
        '',
      ].join('\n'),
    )
    // A second fill writes nothing; the person's folder is untouched.
    const filled = listing(home.dir, true)
    expect(fillPodiumHome('grok', { dir }, home.dir).copied).toEqual([])
    expect(listing(home.dir, true)).toEqual({ ...filled, [FILLED_RECORD]: expect.any(String) })
    expect(listing(dir, true)).toEqual(before)
  })

  it('a managed Grok appearing makes, fills and re-points the sign-in folders once', async () => {
    const own = personGrok()
    const signIn = (await homes.ensure(SIGNED_IN, 'grok')).home
    linkShared(signIn, own)
    const service = new PodiumHomes({
      homes,
      personFolder: async (harness) => personFolderOf(harness, { home: person, env: {} }),
    })
    const [ready] = await service.reconcile((harness) => harness === 'grok')
    const podium = homes.podiumHome('grok')?.dir as string
    expect(ready?.fill?.copied).toEqual(
      expect.arrayContaining(['AGENTS.md', 'skills', 'config.toml mcp_servers']),
    )
    expect(readFileSync(join(podium, 'AGENTS.md'), 'utf8')).toBe('person rules')
    for (const name of ['config.toml', 'AGENTS.md', 'skills', 'agents', 'plugins']) {
      expect(readlinkSync(join(signIn.dir, name)), name).toBe(join(podium, name))
    }
    expect(await service.reconcile((harness) => harness === 'grok')).toEqual([])
  })

  it('the engine’s Podium CLI rule is written inside the sign-in folder, never ~/.grok', async () => {
    personGrok()
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await grokSession(access, 'sign-in')
    const context: HarnessContext = await buildSessionHarnessContext(
      contextSource(access, grokSnapshot(true)),
      'grok',
      sessionId,
    )
    const home = context.harnessHome?.dir as string
    const manifest = manifestFor('grok')
    if (!manifest) throw new Error('no manifest for grok')
    const command = harnessCommand(
      context,
      { args: [] },
      launchTerms(manifest, {
        mode: 'engine',
        posture: { mode: 'autonomous' },
        workdir: '/work',
        runtimeDir: join(root, 'runtime'),
        context,
        grants: {
          podiumCli: { name: 'podium', path: '/bin/podium' },
          uploadsDir: join(root, 'uploads'),
          mcpServers: [],
        },
      }),
    )
    expect(command.terms.homeEdits.map((edit) => edit.file)).toEqual([join(home, 'config.toml')])
    expect(command.homeEditScope?.personal).toBe(false)
    expect(command.harnessHomeId).toBe(`${SIGNED_IN}:grok`)
  })
})

/**
 * PI (POD-7372, managed installs §4.7): `PI_CODING_AGENT_DIR` moves Pi's login,
 * settings, model state and sessions together (POD-7267), so a Pi key Podium
 * passes in runs Podium's Pi in Pi's Podium home. Pi has no sign-in folders:
 * no login credential type reaches a home of its own.
 */
describe('Pi in a Podium-made home (§4.7)', () => {
  const PI_PERSON_BIN = '/usr/local/bin/pi'
  const PI_MANAGED_BIN = '/state/harnesses/pi/1-1.6.0/pi/pi'
  const piSnapshot = (managed: boolean, personal = true): ResolvedHarnessInventory =>
    testHarnessSnapshot(
      personal ? { pi: PI_PERSON_BIN } : {},
      1,
      managed ? { pi: PI_MANAGED_BIN } : {},
    )

  function personPi(): string {
    const dir = join(person, '.pi', 'agent')
    write(
      join(dir, 'mcp.json'),
      JSON.stringify({
        mcpServers: { docs: { command: 'docs-mcp', args: ['--stdio'] } },
        imports: ['person-only'],
      }),
    )
    write(join(dir, 'AGENTS.md'), 'person rules')
    write(join(dir, 'SYSTEM.md'), 'person system prompt')
    write(join(dir, 'APPEND_SYSTEM.md'), 'person appended prompt')
    write(join(dir, 'skills', 'review', 'SKILL.md'), 'a skill')
    write(join(dir, 'prompts', 'fix.md'), 'a prompt template')
    write(join(dir, 'extensions', 'tool.ts'), 'export default () => {}')
    write(join(dir, 'themes', 'dusk.json'), '{"name":"dusk"}')
    // Never copied: the login, trust, MCP sign-ins, settings, custom models,
    // model state, sessions and installed packages.
    write(join(dir, 'auth.json'), '{"anthropic":{"type":"api_key","key":"person-secret"}}')
    write(join(dir, 'trust.json'), '{"/work":"trusted"}')
    write(join(dir, 'mcp-auth.json'), '{"docs":{"token":"t"}}')
    write(join(dir, 'settings.json'), '{"defaultProjectTrust":"always","deviceId":"d"}')
    write(join(dir, 'models.json'), '{"providers":{"local":{"apiKey":"k"}}}')
    write(join(dir, 'models-store.json'), '{}')
    write(join(dir, 'keybindings.json'), '{}')
    write(join(dir, 'sessions', '--work--', '2026_abc.jsonl'), '{}\n')
    write(join(dir, 'npm', 'node_modules', 'pkg', 'index.js'), '')
    return dir
  }

  async function piKeySession(access: SessionAccessStore): Promise<SessionId> {
    const sessionId = asSessionId('s-pi-api-key')
    access.remember(
      sessionId,
      {
        credentialId: KEY_CRED,
        delivery: { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: ANTHROPIC_KEY },
      },
      'pi',
    )
    return sessionId
  }

  it('a passed-in key runs Podium’s Pi with PI_CODING_AGENT_DIR on the Podium home', async () => {
    const own = personPi()
    const before = listing(own, true)
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await piKeySession(access)
    const context = await buildSessionHarnessContext(
      contextSource(access, piSnapshot(true)),
      'pi',
      sessionId,
    )
    const podium = join(root, 'state', 'homes', 'podium', 'pi')
    expect(context.harnessHome).toEqual({
      id: podiumHomeId('pi'),
      dir: podium,
      variable: 'PI_CODING_AGENT_DIR',
    })
    expect(context.installation.executable).toBe(PI_MANAGED_BIN)
    expect(context.roots.state).toBe(podium)
    expect(context.roots.transcripts).toBe(join(podium, 'sessions'))
    const child = harnessChildEnv(context, { sessionEnv: { ANTHROPIC_API_KEY: ANTHROPIC_KEY } })
    expect(child.env.PI_CODING_AGENT_DIR).toBe(podium)
    expect(child.env.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY)
    // The Podium home links nothing, and the person's folder is untouched.
    for (const target of Object.values(listing(podium))) expect(target).not.toContain(person)
    expect(listing(own, true)).toEqual(before)
  })

  it('with only Podium’s Pi on the machine, a passed-in key still runs in the Podium home', async () => {
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await piKeySession(access)
    const context = await buildSessionHarnessContext(
      contextSource(access, piSnapshot(true, false)),
      'pi',
      sessionId,
    )
    expect(context.harnessHome?.id).toBe(podiumHomeId('pi'))
    expect(context.installation.executable).toBe(PI_MANAGED_BIN)
  })

  it.each([
    false,
    true,
  ])('the person’s own login stays in ~/.pi/agent on the person’s binary (managed: %s)', async (managed) => {
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = asSessionId('s-pi-own-login')
    access.remember(
      sessionId,
      { credentialId: OWN_LOGIN, delivery: { kind: 'home', homeId: 'default' } },
      'pi',
    )
    const context = await buildSessionHarnessContext(
      contextSource(access, piSnapshot(managed)),
      'pi',
      sessionId,
    )
    expect(context.harnessHome).toBeUndefined()
    expect(context.installation.executable).toBe(PI_PERSON_BIN)
    expect(context.roots.state).toBe(join(person, '.pi', 'agent'))
  })

  it('without a managed install a passed-in key runs in the person’s folder, as built', async () => {
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await piKeySession(access)
    const context = await buildSessionHarnessContext(
      contextSource(access, piSnapshot(false)),
      'pi',
      sessionId,
    )
    expect(context.harnessHome).toBeUndefined()
    expect(context.installation.executable).toBe(PI_PERSON_BIN)
    expect(homes.podiumHome('pi')).toBeUndefined()
  })

  it('Podium’s Pi is never started in the person’s own folder', async () => {
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await piKeySession(access)
    const context = await buildSessionHarnessContext(
      contextSource(access, piSnapshot(true)),
      'pi',
      sessionId,
    )
    const { harnessHome: _home, ...outside } = context
    expect(() => harnessChildEnv(outside as HarnessContext, {})).toThrow(
      /never in your own pi folder/,
    )
  })

  it('the fill copies rules, skills, prompts, extensions, themes and the MCP servers, nothing else', () => {
    const dir = personPi()
    const before = listing(dir, true)
    const home = homes.ensurePodiumHome('pi').home
    // A server and a key of the home's own stay.
    write(join(home.dir, 'mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'm' } } }))
    const report = fillPodiumHome('pi', { dir }, home.dir)
    expect(report.left).toEqual([])
    expect(report.copied).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        'skills',
        'prompts',
        'extensions',
        'themes',
        'mcp.json mcpServers',
      ]),
    )
    expect(Object.keys(listing(home.dir)).sort()).toEqual(
      [
        FILLED_RECORD,
        'AGENTS.md',
        'APPEND_SYSTEM.md',
        'SYSTEM.md',
        'extensions',
        'extensions/tool.ts',
        'mcp.json',
        'prompts',
        'prompts/fix.md',
        'skills',
        'skills/review',
        'skills/review/SKILL.md',
        'themes',
        'themes/dusk.json',
      ].sort(),
    )
    expect(readJson(join(home.dir, 'mcp.json'))).toEqual({
      mcpServers: { mine: { command: 'm' }, docs: { command: 'docs-mcp', args: ['--stdio'] } },
    })
    // A second fill writes nothing; the person's folder is untouched.
    const filled = listing(home.dir, true)
    expect(fillPodiumHome('pi', { dir }, home.dir).copied).toEqual([])
    expect(listing(home.dir, true)).toEqual({ ...filled, [FILLED_RECORD]: expect.any(String) })
    expect(listing(dir, true)).toEqual(before)
  })

  it('a managed Pi appearing makes and fills the Podium home once, from PI_CODING_AGENT_DIR', async () => {
    const own = personPi()
    const moved = join(root, 'elsewhere', 'pi-agent')
    mkdirSync(dirname(moved), { recursive: true })
    // The person keeps their Pi folder elsewhere: the fill reads it there.
    symlinkSync(own, moved)
    const service = new PodiumHomes({
      homes,
      personFolder: async (harness) =>
        personFolderOf(harness, { home: person, env: { PI_CODING_AGENT_DIR: moved } }),
    })
    const [ready] = await service.reconcile((harness) => harness === 'pi')
    const podium = homes.podiumHome('pi')?.dir as string
    expect(ready?.fill?.copied).toEqual(expect.arrayContaining(['AGENTS.md', 'skills']))
    expect(readFileSync(join(podium, 'AGENTS.md'), 'utf8')).toBe('person rules')
    expect(existsSync(join(podium, 'auth.json'))).toBe(false)
    expect(await service.reconcile((harness) => harness === 'pi')).toEqual([])
  })

  it('a managed Pi launch in the Podium home trusts the folder and skips the version request', async () => {
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await piKeySession(access)
    const context = await buildSessionHarnessContext(
      contextSource(access, piSnapshot(true)),
      'pi',
      sessionId,
    )
    const manifest = manifestFor('pi')
    if (!manifest) throw new Error('no manifest for pi')
    const command = harnessCommand(
      context,
      { args: [] },
      launchTerms(manifest, {
        mode: 'terminal',
        posture: { mode: 'autonomous' },
        workdir: '/work',
        runtimeDir: join(root, 'runtime'),
        context,
        grants: {
          podiumCli: { name: 'podium', path: '/bin/podium' },
          uploadsDir: join(root, 'uploads'),
          mcpServers: [],
        },
      }),
    )
    expect(command.args).toContain('--approve')
    expect(command.env.PI_SKIP_VERSION_CHECK).toBe('1')
    // Trust is a launch flag: nothing is written into any Pi folder.
    expect(command.terms.homeEdits).toEqual([])
    expect(command.harnessHomeId).toBe(podiumHomeId('pi'))
  })

  describe('the conversation follows the session into the Podium home (§4.6 item 4)', () => {
    const PI_SESSION = '0b7c4a52-7f1e-4c3a-9d2e-5a6b7c8d9e0f'
    const sessionRel = join('sessions', '--work--', `2026-11-20T10-00-00-000Z_${PI_SESSION}.jsonl`)
    const SESSION = `${[
      JSON.stringify({ type: 'session', id: PI_SESSION, cwd: '/work' }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: 'My code word is FIG-7.' },
      }),
    ].join('\n')}\n`
    const deps = (managed: boolean) => ({
      account: { home: person, env: {} },
      homes,
      managedInstall: (harness: string) => managed && harness === 'pi',
      now: () => 1_700_000_000_000,
    })
    const request = (account: string, fromAccount?: string) => ({
      agentKind: 'pi' as const,
      cwd: '/work',
      resume: { kind: 'pi-session' as const, value: PI_SESSION },
      toHomeId: 'default',
      toDelivery: 'env' as const,
      account,
      ...(fromAccount ? { fromAccount } : {}),
    })

    it('a key session that ran in ~/.pi/agent continues from a copy in the Podium home', async () => {
      const original = write(join(person, '.pi', 'agent', sessionRel), SESSION)
      const placed = await prepareConversation(deps(true), request(KEY_CRED))
      const podium = homes.podiumHome('pi')?.dir as string
      expect(placed).toMatchObject({ ok: true, placed: 'copied', path: join(podium, sessionRel) })
      expect(readFileSync(join(podium, sessionRel), 'utf8')).toBe(SESSION)
      expect(readFileSync(original, 'utf8')).toBe(SESSION)
    })

    it('without a managed install it stays in the person’s folder', async () => {
      write(join(person, '.pi', 'agent', sessionRel), SESSION)
      expect(await prepareConversation(deps(false), request(KEY_CRED))).toMatchObject({
        ok: true,
        placed: 'in-place',
      })
      expect(homes.podiumHome('pi')).toBeUndefined()
    })

    it('switching between two passed-in keys resumes in place and copies nothing', async () => {
      const podium = homes.ensurePodiumHome('pi').home.dir
      write(join(podium, sessionRel), SESSION)
      const personBefore = listing(person)
      expect(
        await prepareConversation(deps(true), request(OTHER_KEY_CRED, KEY_CRED)),
      ).toMatchObject({ ok: true, placed: 'in-place', path: join(podium, sessionRel) })
      expect(listing(person)).toEqual(personBefore)
    })
  })
})
