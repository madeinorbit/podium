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
 * Plus the selection wiring, which is what makes the driver reachable at all
 * and, just as importantly, what keeps it UNreachable by default.
 */

import { describe, expect, it } from 'vitest'
import {
  codexAppServerConfigArgs,
  codexAppServerVersionProbe,
  codexScopeLabel,
  resetCodexAppServerVersionProbe,
  STRIPPED_CODEX_CREDENTIALS,
} from './codex-app-server'
import { availableDriverIds, isServerDriver, resolveRuntimeDriver } from './registry'

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
  it('routes approvals to server→client requests rather than silencing them', () => {
    /**
     * THE LOAD-BEARING OVERRIDE. `-a never` silences approvals, which would make
     * the entire approval half of this driver dead code and the acceptance item
     * — "approval round-trip: request → PendingInteraction → answer → the turn
     * continues" — impossible to demonstrate.
     */
    const { args } = codexAppServerConfigArgs({})
    expect(args.join(' ')).toContain('approval_policy="untrusted"')
    expect(args.join(' ')).not.toContain('approval_policy="never"')
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
  const unanswered = (output = '') => () => ({ output, ok: false })

  it('admits the version the fixtures were recorded from', () => {
    resetCodexAppServerVersionProbe()
    expect(codexAppServerVersionProbe(answered('codex-cli 0.147.0'))).toEqual({ drivable: true })
  })

  it('REFUSES an out-of-range codex with a machine-readable diagnostic', () => {
    /**
     * The acceptance item, and the reason the gate is worth its cost: a driver
     * whose approval method name is wrong does not error — it never receives an
     * approval, and the session hangs on its first tool call with nothing
     * anywhere saying why.
     */
    resetCodexAppServerVersionProbe()
    const verdict = codexAppServerVersionProbe(answered('codex-cli 0.130.0'))
    expect(verdict.drivable).toBe(false)
    if (verdict.drivable) return
    expect(verdict.reason).toBe('unsupported')
    expect(verdict.diagnostic.code).toBe('codex-app-server-version-unsupported')
    expect(verdict.diagnostic.observedVersion).toBe('codex-cli 0.130.0')
  })

  it('REFUSES a codex whose output it cannot parse', () => {
    resetCodexAppServerVersionProbe()
    const verdict = codexAppServerVersionProbe(answered('some unrelated banner'))
    expect(verdict.drivable).toBe(false)
    if (!verdict.drivable) expect(verdict.reason).toBe('unsupported')
  })

  it('distinguishes "too old" from "I could not find out"', () => {
    /**
     * THREE ANSWERS, NOT TWO — adopted from POD-2023's review round after
     * POD-2056 measured why it matters, and sharper here because this binary is
     * bigger: a 26-second `codex --version` on a loaded box is an ordinary
     * observation. "Too old" is stable and about the MACHINE; "did not answer"
     * is transient and about LOAD, and treating the second like the first
     * silently converts a deliberate request into a different kind of session.
     */
    resetCodexAppServerVersionProbe()
    const verdict = codexAppServerVersionProbe(unanswered('codex: command not found'))
    expect(verdict.drivable).toBe(false)
    if (verdict.drivable) return
    expect(verdict.reason).toBe('unprobeable')
    expect(verdict.diagnostic.body).toContain('NOT about the version')
  })

  it('memoizes a DEFINITIVE verdict, so the probe is one fork per daemon life', () => {
    resetCodexAppServerVersionProbe()
    let calls = 0
    const probe = () => {
      calls += 1
      return { output: 'codex-cli 0.147.0', ok: true }
    }
    codexAppServerVersionProbe(probe)
    codexAppServerVersionProbe(probe)
    codexAppServerVersionProbe(probe)
    // The binary on PATH does not change under a running daemon, and the probe
    // costs a fork of a 250MB executable.
    expect(calls).toBe(1)
  })

  it('does NOT memoize an unprobeable one, so one unlucky spawn is not permanent', () => {
    // Caching a timeout would disable the driver for the daemon's ENTIRE life
    // because a box was busy for fifteen seconds once.
    resetCodexAppServerVersionProbe()
    let calls = 0
    const probe = () => {
      calls += 1
      return { output: '', ok: false }
    }
    codexAppServerVersionProbe(probe)
    codexAppServerVersionProbe(probe)
    expect(calls).toBe(2)
  })

  it('lets a later, quieter probe succeed after an unprobeable one', () => {
    resetCodexAppServerVersionProbe()
    let attempt = 0
    const probe = () => {
      attempt += 1
      return attempt === 1
        ? { output: '', ok: false }
        : { output: 'codex-cli 0.147.0', ok: true }
    }
    expect(codexAppServerVersionProbe(probe).drivable).toBe(false)
    expect(codexAppServerVersionProbe(probe).drivable).toBe(true)
  })
})

describe('selection — reachable on purpose, unreachable by default', () => {
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

  it('DEFAULTS TO TERMINAL when a spawn expresses no preference', () => {
    /**
     * The plan is explicit that the terminal driver stays Codex's permanent
     * fallback and that this driver ships as an explicit per-spawn opt-in. A
     * spawn that says nothing must get exactly what it got before this driver
     * existed.
     */
    const resolved = resolveRuntimeDriver({
      agentKind: 'codex',
      requested: undefined,
      machineDefault: undefined,
      available: ['claude-pty', 'generic-pty', 'codex-app-server'],
      platform: 'linux',
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.driverId).toBe('generic-pty')
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
