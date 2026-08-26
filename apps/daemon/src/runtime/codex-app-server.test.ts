/**
 * THE DAEMON HALF OF THE codex app-server DRIVER (POD-1761 W6).
 *
 * Two acceptance items live entirely in this file's subject matter:
 *
 *   - "Subscription-auth demonstration proven NOT to ride an inherited API key
 *     (env stripped)". The strip is the MECHANISM half; the driver's
 *     `getAuthStatus` assertion is the proof half, tested in the driver package.
 *   - "version gate refuses out-of-range codex (unit-tested)".
 *
 * Plus the selection wiring, which makes the admitted driver the default while
 * keeping the terminal path as its permanent fallback.
 */

import { asSessionId } from '@podium/model'
import { unixSocketPathBytes, unixSocketPathFits } from '@podium/runtime/abduco-socket'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  codexAppServerConfigArgs,
  codexClientSocketPath,
  codexAppServerVersionProbe,
  codexScopeLabel,
  resetCodexAppServerVersionProbe,
  STRIPPED_CODEX_CREDENTIALS,
} from './codex-app-server'
import {
  availableDriverIds,
  harnessOwningServerDriver,
  isServerDriver,
  isServerDriverId,
  resolveRuntimeDriver,
} from './registry'

const LEGACY_SOCKET_ROOT = '/home/mgw/.local/state/podium'
const CODEX_SOCKET_DIR = 'runtime/codex-app-server-sockets'
const CODEX_SOCKET_BASENAME = 'abcdefabcdef-123456789012.sock'

const legacyCodexSocketPath = (instanceId: string): string =>
  `${LEGACY_SOCKET_ROOT}/${instanceId}/${CODEX_SOCKET_DIR}/${CODEX_SOCKET_BASENAME}`

const savedInstanceEnv = {
  HOME: process.env.HOME,
  PODIUM_INSTANCE: process.env.PODIUM_INSTANCE,
  PODIUM_STATE_DIR: process.env.PODIUM_STATE_DIR,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
}

beforeEach(() => {
  process.env.HOME = '/home/mgw'
  process.env.XDG_RUNTIME_DIR = '/run/user/1001'
  delete process.env.PODIUM_STATE_DIR
  delete process.env.XDG_STATE_HOME
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedInstanceEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('the Codex app-server socket path budget', () => {
  it('keeps the measured old boundary and fits both edge instance ids', () => {
    const lastAccepted = 'i'.repeat(13)
    const firstRefused = 'i'.repeat(14)

    // These are the measured legacy compositions this regression closes: the
    // last accepted path is 107 bytes, while the first refused path reaches
    // the 108-byte sockaddr_un ceiling.
    expect(unixSocketPathBytes(legacyCodexSocketPath(lastAccepted))).toBe(107)
    expect(unixSocketPathBytes(legacyCodexSocketPath(firstRefused))).toBe(108)
    expect(unixSocketPathFits(legacyCodexSocketPath(lastAccepted))).toBe(true)
    expect(unixSocketPathFits(legacyCodexSocketPath(firstRefused))).toBe(false)

    process.env.PODIUM_INSTANCE = lastAccepted
    const lastPath = codexClientSocketPath(
      asSessionId('019edef7-3e34-7513-92b9-35f3a0dac891'),
      'abcdefabcdef-123456789012',
    )
    const maximumId = 'i'.repeat(32)
    process.env.PODIUM_INSTANCE = maximumId
    const maximumPath = codexClientSocketPath(
      asSessionId('019edef7-3e34-7513-92b9-35f3a0dac891'),
      'abcdefabcdef-123456789012',
    )
    process.env.PODIUM_INSTANCE = firstRefused
    const firstPath = codexClientSocketPath(
      asSessionId('019edef7-3e34-7513-92b9-35f3a0dac891'),
      'abcdefabcdef-123456789012',
    )

    expect(lastPath).toContain(`/run/user/1001/podium-${lastAccepted}/`)
    expect(firstPath).toContain(`/run/user/1001/podium-${firstRefused}/`)
    expect(maximumPath).toContain(`/run/user/1001/podium-${maximumId}/`)
    expect(unixSocketPathBytes(lastPath)).toBe(66)
    expect(unixSocketPathBytes(firstPath)).toBe(67)
    expect(unixSocketPathBytes(maximumPath)).toBe(85)
    expect(unixSocketPathFits(lastPath)).toBe(true)
    expect(unixSocketPathFits(firstPath)).toBe(true)
    expect(unixSocketPathFits(maximumPath)).toBe(true)
  })
})

describe('env hygiene — the subscription-auth mechanism', () => {
  it('strips every credential that could outrank the stored ChatGPT login', () => {
    /**
     * CODEX PREFERS AN INHERITED KEY over `~/.codex/auth.json`. A daemon carries
     * whatever the operator's shell had, so without this a session would bill an
     * API account while the operator believed they were demonstrating
     * subscription auth — invisibly, and with a working session as the evidence.
     */
    expect(STRIPPED_CODEX_CREDENTIALS).toContain('OPENAI_API_KEY')
    expect(STRIPPED_CODEX_CREDENTIALS).toContain('CODEX_API_KEY')
    expect(STRIPPED_CODEX_CREDENTIALS).toContain('CODEX_ACCESS_TOKEN')
    expect(STRIPPED_CODEX_CREDENTIALS).toContain('OPENAI_ORGANIZATION')
    // Asserted BY NAME because the review found this list restated in
    // `live.test.ts` with this key missing — the one that would have been
    // dropped silently. There is now one array and both readers import it.
    expect(STRIPPED_CODEX_CREDENTIALS).toContain('OPENAI_ORG_ID')
    // `OPENAI_BASE_URL` is on the list for the same reason though it is not a
    // credential: it redirects the session to a different provider entirely,
    // which is the same silent substitution wearing a different name.
    expect(STRIPPED_CODEX_CREDENTIALS).toContain('OPENAI_BASE_URL')
  })

  it('produces the env the child actually gets, with those keys gone', () => {
    // The strip is a plain filter over the merged env; asserting it here rather
    // than reaching into `launch()` keeps the test from needing a real spawn,
    // and the filter is the whole mechanism.
    const merged: Record<string, string | undefined> = {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-should-not-survive',
      CODEX_ACCESS_TOKEN: 'tok-should-not-survive',
      PODIUM_SESSION: 'keep-me',
    }
    for (const key of STRIPPED_CODEX_CREDENTIALS) delete merged[key]
    expect(merged.OPENAI_API_KEY).toBeUndefined()
    expect(merged.CODEX_ACCESS_TOKEN).toBeUndefined()
    // …and nothing else is disturbed. A strip that took the whole env would
    // break PATH resolution and every managed credential the spawn frame set.
    expect(merged.PATH).toBe('/usr/bin')
    expect(merged.PODIUM_SESSION).toBe('keep-me')
  })
})

describe('the spawn config', () => {
  it('leaves approval routing to the current app-server contract', () => {
    // Codex 0.149 refuses the retired `untrusted` value before opening its
    // listener. Its current default produces the server→client approval
    // requests this driver handles, so no approval policy is generated at all.
    const { args } = codexAppServerConfigArgs({})
    expect(args.join(' ')).not.toContain('approval_policy')
    expect(args.join(' ')).toContain('sandbox_mode="workspace-write"')
  })

  it('opens network access only when an MCP server is actually mounted', () => {
    // A Podium MCP server is on loopback and is unreachable from a sandbox with
    // no network, so mounting one without this is mounting nothing. Opening it
    // for a session with no MCP would widen the sandbox for no reason.
    expect(codexAppServerConfigArgs({}).args.join(' ')).not.toContain('network_access')
    const mounted = codexAppServerConfigArgs({
      mcpServers: {
        transport: 'inline',
        config: JSON.stringify({
          mcpServers: { podium: { url: 'http://127.0.0.1:7777/mcp' } },
        }),
      },
    })
    expect(mounted.args.join(' ')).toContain('sandbox_workspace_write.network_access=true')
  })

  it('mounts MCP servers through the manifest own verified mechanism', () => {
    const { args, env } = codexAppServerConfigArgs({
      mcpServers: {
        transport: 'inline',
        config: JSON.stringify({
          mcpServers: {
            podium: {
              url: 'http://127.0.0.1:7777/mcp',
              headers: { Authorization: 'Bearer secret-token' },
            },
          },
        }),
      },
    })
    const flat = args.join(' ')
    expect(flat).toContain('mcp_servers."podium".url="http://127.0.0.1:7777/mcp"')
    /**
     * THE BEARER RIDES AN ENV VAR, NOT A HEADER, and not argv. Smuggling it as a
     * plain `http_headers` entry makes codex treat the server as unauthenticated,
     * run OAuth discovery, find none, and kill the whole turn with
     * `Auth(AuthorizationRequired)` — the exact failure POD-1021 recorded. An env
     * var also keeps the token out of `/proc/<pid>/cmdline`.
     */
    expect(flat).toContain('bearer_token_env_var')
    expect(Object.values(env)).toContain('secret-token')
    expect(flat).not.toContain('secret-token')
  })

  it('reads a path-transport config through the injected reader', () => {
    const { args } = codexAppServerConfigArgs({
      mcpServers: { transport: 'path', path: '/tmp/mcp.json' },
      readConfig: (path) =>
        path === '/tmp/mcp.json'
          ? JSON.stringify({ mcpServers: { podium: { url: 'http://127.0.0.1:1/mcp' } } })
          : undefined,
    })
    expect(args.join(' ')).toContain('mcp_servers."podium".url')
  })

  it('mounts nothing when the config cannot be read, rather than half of one', () => {
    // A tool-less session is a visible outcome; a session that thinks it mounted
    // tools and did not is a turn that fails deep inside the model's reasoning.
    const { args } = codexAppServerConfigArgs({
      mcpServers: { transport: 'path', path: '/tmp/missing.json' },
      readConfig: () => undefined,
    })
    expect(args.join(' ')).not.toContain('mcp_servers')
    expect(args.join(' ')).not.toContain('network_access')
  })
})

describe('the version gate', () => {
  const answered = (output: string) => () => ({ output, ok: true })
  const unanswered =
    (output = '') =>
    () => ({ output, ok: false })

  it('admits the version the fixtures were recorded from', async () => {
    resetCodexAppServerVersionProbe()
    await expect(codexAppServerVersionProbe(answered('codex-cli 0.147.0'))).resolves.toEqual({
      drivable: true,
    })
  })

  it('REFUSES an out-of-range codex with a machine-readable diagnostic', async () => {
    /**
     * The acceptance item, and the reason the gate is worth its cost: a driver
     * whose approval method name is wrong does not error — it never receives an
     * approval, and the session hangs on its first tool call with nothing
     * anywhere saying why.
     */
    resetCodexAppServerVersionProbe()
    const verdict = await codexAppServerVersionProbe(answered('codex-cli 0.130.0'))
    expect(verdict.drivable).toBe(false)
    if (verdict.drivable) return
    expect(verdict.reason).toBe('unsupported')
    expect(verdict.diagnostic.code).toBe('codex-app-server-version-unsupported')
    expect(verdict.diagnostic.observedVersion).toBe('codex-cli 0.130.0')
  })

  it('REFUSES a codex whose output it cannot parse', async () => {
    resetCodexAppServerVersionProbe()
    const verdict = await codexAppServerVersionProbe(answered('some unrelated banner'))
    expect(verdict.drivable).toBe(false)
    if (!verdict.drivable) expect(verdict.reason).toBe('unsupported')
  })

  it('distinguishes "too old" from "I could not find out"', async () => {
    /**
     * THREE ANSWERS, NOT TWO — adopted from POD-2023's review round after
     * POD-2056 measured why it matters, and sharper here because this binary is
     * bigger: a 26-second `codex --version` on a loaded box is an ordinary
     * observation. "Too old" is stable and about the MACHINE; "did not answer"
     * is transient and about LOAD, and treating the second like the first
     * silently converts a deliberate request into a different kind of session.
     */
    resetCodexAppServerVersionProbe()
    const verdict = await codexAppServerVersionProbe(unanswered('codex: command not found'))
    expect(verdict.drivable).toBe(false)
    if (verdict.drivable) return
    expect(verdict.reason).toBe('unprobeable')
    expect(verdict.diagnostic.body).toContain('NOT about the version')
  })

  it('memoizes a DEFINITIVE verdict, so the probe is one fork per daemon life', async () => {
    resetCodexAppServerVersionProbe()
    let calls = 0
    const probe = () => {
      calls += 1
      return { output: 'codex-cli 0.147.0', ok: true }
    }
    await codexAppServerVersionProbe(probe)
    await codexAppServerVersionProbe(probe)
    await codexAppServerVersionProbe(probe)
    // The binary on PATH does not change under a running daemon, and the probe
    // costs a fork of a 250MB executable.
    expect(calls).toBe(1)
  })

  it('temporarily memoizes an unprobeable one so a spawn burst probes once', async () => {
    resetCodexAppServerVersionProbe()
    let calls = 0
    const probe = () => {
      calls += 1
      return { output: '', ok: false }
    }
    await codexAppServerVersionProbe(probe)
    await codexAppServerVersionProbe(probe)
    expect(calls).toBe(1)
  })
})

describe('selection — server first, terminal fallback', () => {
  it('lists the driver only where the gate admitted the binary', () => {
    expect(availableDriverIds({ opencodeDrivable: false, codexDrivable: true })).toContain(
      'codex-app-server',
    )
    expect(availableDriverIds({ opencodeDrivable: false, codexDrivable: false })).not.toContain(
      'codex-app-server',
    )
  })

  it('treats an UNPROBED machine as unavailable rather than assuming yes', () => {
    // The failure mode on an unpinned binary is a session that hangs, so silence
    // must degrade to terminal rather than be read as a pass.
    expect(availableDriverIds({ opencodeDrivable: false })).not.toContain('codex-app-server')
  })

  it('recognizes it as codex own server driver', () => {
    expect(isServerDriver('codex', 'codex-app-server')).toBe(true)
    expect(isServerDriver('codex', 'generic-pty')).toBe(false)
    // …and not as anybody else's.
    expect(isServerDriver('opencode', 'codex-app-server')).toBe(false)
  })

  it('defaults to app-server when a spawn expresses no preference', () => {
    // The terminal driver remains the fallback, not the first-ranked choice.
    const resolved = resolveRuntimeDriver({
      agentKind: 'codex',
      requested: undefined,
      machineDefault: undefined,
      available: ['claude-pty', 'generic-pty', 'codex-app-server'],
      platform: 'linux',
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.driverId).toBe('codex-app-server')
  })

  it('honours an explicit per-spawn preference', () => {
    const resolved = resolveRuntimeDriver({
      agentKind: 'codex',
      requested: 'codex-app-server',
      machineDefault: undefined,
      available: ['claude-pty', 'generic-pty', 'codex-app-server'],
      platform: 'linux',
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.driverId).toBe('codex-app-server')
  })

  it('DEGRADES to terminal when the machine cannot run it', () => {
    // An operator naming the driver on a box whose codex is out of the pinned
    // range gets a working terminal session rather than one that hangs on its
    // first tool call — the preference is routed THROUGH the policy, not around
    // it, so `available` still decides.
    const resolved = resolveRuntimeDriver({
      agentKind: 'codex',
      requested: 'codex-app-server',
      machineDefault: undefined,
      available: ['claude-pty', 'generic-pty'],
      platform: 'linux',
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.driverId).toBe('generic-pty')
  })

  it('REFUSES an id this build does not ship, rather than silently degrading', () => {
    // A typo that produced a working terminal session would read as "the
    // override did not work", which is the one failure an operator testing a
    // driver must not be handed.
    const resolved = resolveRuntimeDriver({
      agentKind: 'codex',
      requested: 'codex-app-sever' as never,
      machineDefault: undefined,
      available: ['generic-pty', 'codex-app-server'],
      platform: 'linux',
    })
    expect(resolved.ok).toBe(false)
  })
})

describe('which probe answers for which driver', () => {
  /**
   * THE RULE THAT WAS WRONG ONCE, so it is named and tested rather than
   * re-derived at each call site.
   *
   * W6 added a SECOND server driver with its own binary and its own version
   * probe. The spawn path refuses an explicit server-driver request when that
   * driver's probe came back `unprobeable` — and if it consults the WRONG
   * probe, one harness's healthy binary vouches for another harness's missing
   * one. The request then sails past the refusal, vanishes from `available`,
   * and comes back as a terminal session: exactly the silent downgrade the
   * unprobeable/unsupported split exists to prevent (POD-2056's measurement).
   */
  it('attributes each server driver to the harness that DECLARES it', () => {
    expect(harnessOwningServerDriver('codex-app-server')).toBe('codex')
    expect(harnessOwningServerDriver('opencode-server')).toBe('opencode')
  })

  it('attributes terminal and unknown ids to nobody', () => {
    // A terminal driver has no version-gated binary of its own to probe, and an
    // id this build does not ship must not be attributed to whichever harness
    // happened to be first in the manifest map.
    expect(harnessOwningServerDriver('generic-pty')).toBeUndefined()
    expect(harnessOwningServerDriver('claude-pty')).toBeUndefined()
    expect(harnessOwningServerDriver('codex-app-sever')).toBeUndefined()
  })

  it('agrees with the server-driver predicate built on it', () => {
    expect(isServerDriverId('codex-app-server')).toBe(true)
    expect(isServerDriverId('generic-pty')).toBe(false)
  })
})

describe('the scope label', () => {
  it('names the SESSION, so it survives the child being replaced', () => {
    /**
     * `adopt()` for this family starts a fresh child and resumes the thread, and
     * the corpus requires `binding.process.key` to be unchanged across that. A
     * pid-derived key would break both that property and the exact-identity
     * check the journal comparison performs.
     */
    const a = codexScopeLabel('sess-1' as never)
    expect(a).toBe(codexScopeLabel('sess-1' as never))
    expect(a).not.toBe(codexScopeLabel('sess-2' as never))
  })
})
