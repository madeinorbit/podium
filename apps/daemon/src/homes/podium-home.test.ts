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
    const sessionId = asSessionId('s-grok')
    access.remember(
      sessionId,
      { credentialId: KEY_CRED, delivery: { kind: 'env', variable: 'XAI_API_KEY', secret: 'x' } },
      'grok',
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
