import { describe, expect, it, vi } from 'vitest'
import type { ResolvedHarnessInventory } from '@podium/harness'
import { HarnessExecRequestMessage } from '@podium/protocol'
import {
  BUFFERED_HARNESS_DEFAULT_TIMEOUT_MS,
  BUFFERED_HARNESS_MAX_BUFFER_BYTES,
  executeBufferedHarnessTurn,
  type BufferedHarnessRequest,
} from './buffered-harness.js'
import { execHandlers } from './control/exec.js'

function fakeSnapshot(kind: string, path: string): ResolvedHarnessInventory {
  return {
    inventory: { agents: [] },
    executables: new Map([[kind, { kind, path, generation: 7 }]]),
    commandEnvironment: {
      env: { PATH: '/usr/bin' },
      pathEntries: ['/usr/bin'],
      source: 'inherited',
      generation: 7,
      machineHome: '/home/op',
      loginShell: '/bin/bash',
      resolve: () => undefined,
    },
  } as unknown as ResolvedHarnessInventory
}

function req(overrides: Partial<BufferedHarnessRequest> = {}): BufferedHarnessRequest {
  return {
    type: 'harnessExecRequest',
    requestId: 'hx-1',
    agent: 'claude-code',
    prompt: 'summarize',
    ...overrides,
  } as BufferedHarnessRequest
}

describe('buffered harness compatibility (POD-4304 F09)', () => {
  it('keeps the wire frame registered with old-peer result shape', () => {
    expect(typeof execHandlers.harnessExecRequest).toBe('function')
    const valid = HarnessExecRequestMessage.safeParse({
      type: 'harnessExecRequest',
      requestId: 'hx-1',
      agent: 'codex',
      prompt: 'orchestrate',
      mcpConfig: '{"mcpServers":{}}',
      timeoutMs: 600_000,
    })
    expect(valid.success).toBe(true)
    const missing = HarnessExecRequestMessage.safeParse({
      type: 'harnessExecRequest',
      requestId: 'hx-1',
      agent: 'codex',
    })
    expect(missing.success).toBe(false)
  })

  it('writes valid claude MCP config to a temp file, passes --mcp-config, cleans up, prompt on stdin', async () => {
    const written = new Map<string, string>()
    const removed: string[] = []
    const seen: { cmd: string; args: string[]; stdin: string }[] = []
    const result = await executeBufferedHarnessTurn(
      { homeDir: '/home/op', harnessRuntime: undefined },
      req({
        agent: 'claude-code',
        prompt: 'list my sessions',
        mcpConfig: JSON.stringify({ mcpServers: {} }),
        allowedTools: ['Read'],
      }),
      {
        snapshot: async () => fakeSnapshot('claude-code', '/usr/bin/claude'),
        runChild: async (cmd, args, _opts, stdin) => {
          seen.push({ cmd, args, stdin })
          return { stdout: '  hello world\n' }
        },
        writeTemp: (p, d) => void written.set(p, d),
        removeTemp: (p) => void removed.push(p),
        makeTempPath: () => '/tmp/podium-mcp-test.json',
      },
    )
    expect(result).toEqual({ ok: true, output: 'hello world' })
    expect(written.get('/tmp/podium-mcp-test.json')).toBe(JSON.stringify({ mcpServers: {} }))
    expect(removed).toEqual(['/tmp/podium-mcp-test.json'])
    expect(seen).toHaveLength(1)
    expect(seen[0]!.cmd).toBe('/usr/bin/claude')
    expect(seen[0]!.args).toContain('--mcp-config')
    expect(seen[0]!.args[seen[0]!.args.indexOf('--mcp-config') + 1]).toBe(
      '/tmp/podium-mcp-test.json',
    )
    // stdin-only prompt: claude's variadic --allowedTools would eat argv prompt.
    expect(seen[0]!.stdin).toBe('list my sessions')
    expect(seen[0]!.args).not.toContain('list my sessions')
  })

  it('refuses malformed codex MCP config without executing', async () => {
    const runChild = vi.fn(async () => ({ stdout: 'x' }))
    const makeTempPath = vi.fn(() => '/tmp/never.json')
    const result = await executeBufferedHarnessTurn(
      { homeDir: undefined, harnessRuntime: undefined },
      req({ agent: 'codex', prompt: 'p', mcpConfig: 'not json' }),
      {
        snapshot: async () => fakeSnapshot('codex', '/usr/bin/codex'),
        runChild,
        makeTempPath,
      },
    )
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/malformed MCP config/)
    expect(runChild).not.toHaveBeenCalled()
    expect(makeTempPath).not.toHaveBeenCalled()
  })

  it('passes codex MCP inline with no temp file and closes stdin', async () => {
    const seen: { args: string[]; stdin: string }[] = []
    const makeTempPath = vi.fn(() => '/tmp/never.json')
    const result = await executeBufferedHarnessTurn(
      { homeDir: undefined, harnessRuntime: undefined },
      req({
        agent: 'codex',
        prompt: 'go',
        mcpConfig: JSON.stringify({
          mcpServers: { podium: { type: 'http', url: 'http://127.0.0.1:1878/mcp' } },
        }),
      }),
      {
        snapshot: async () => fakeSnapshot('codex', '/usr/bin/codex'),
        runChild: async (_cmd, args, _opts, stdin) => {
          seen.push({ args, stdin })
          return { stdout: 'done' }
        },
        makeTempPath,
      },
    )
    expect(result).toEqual({ ok: true, output: 'done' })
    expect(makeTempPath).not.toHaveBeenCalled()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.args.at(-1)).toBe('go')
    expect(seen[0]!.stdin).toBe('')
  })

  it('uses the 240s default timeout and 4MiB cap, honouring timeoutMs', async () => {
    const opts: { timeout: number; maxBuffer: number }[] = []
    const snapshot = fakeSnapshot('grok', '/usr/bin/grok')
    await executeBufferedHarnessTurn(
      { homeDir: undefined, harnessRuntime: undefined },
      req({ agent: 'grok', prompt: 'p' }),
      {
        snapshot: async () => snapshot,
        runChild: async (_c, _a, o, _s) => {
          opts.push({ timeout: o.timeout, maxBuffer: o.maxBuffer })
          return { stdout: 'ok' }
        },
      },
    )
    expect(opts[0]).toEqual({
      timeout: BUFFERED_HARNESS_DEFAULT_TIMEOUT_MS,
      maxBuffer: BUFFERED_HARNESS_MAX_BUFFER_BYTES,
    })
    expect(BUFFERED_HARNESS_DEFAULT_TIMEOUT_MS).toBe(240_000)
    expect(BUFFERED_HARNESS_MAX_BUFFER_BYTES).toBe(4 * 1024 * 1024)
    await executeBufferedHarnessTurn(
      { homeDir: undefined, harnessRuntime: undefined },
      req({ agent: 'grok', prompt: 'p', timeoutMs: 5_000 }),
      {
        snapshot: async () => snapshot,
        runChild: async (_c, _a, o, _s) => {
          opts.push({ timeout: o.timeout, maxBuffer: o.maxBuffer })
          return { stdout: 'ok' }
        },
      },
    )
    expect(opts[1]!.timeout).toBe(5_000)
  })

  it('cleans the temp file when the child fails', async () => {
    const removed: string[] = []
    const result = await executeBufferedHarnessTurn(
      { homeDir: undefined, harnessRuntime: undefined },
      req({ agent: 'claude-code', prompt: 'p', mcpConfig: '{"mcpServers":{}}' }),
      {
        snapshot: async () => fakeSnapshot('claude-code', '/usr/bin/claude'),
        runChild: async () => {
          throw new Error('boom')
        },
        writeTemp: () => {},
        removeTemp: (p) => void removed.push(p),
        makeTempPath: () => '/tmp/podium-mcp-fail.json',
      },
    )
    expect(result).toEqual({ ok: false, output: 'boom' })
    expect(removed).toEqual(['/tmp/podium-mcp-fail.json'])
  })

  it('refuses a temp-write failure rather than running tool-less', async () => {
    const runChild = vi.fn(async () => ({ stdout: 'x' }))
    const result = await executeBufferedHarnessTurn(
      { homeDir: undefined, harnessRuntime: undefined },
      req({ agent: 'claude-code', prompt: 'p', mcpConfig: '{"mcpServers":{}}' }),
      {
        snapshot: async () => fakeSnapshot('claude-code', '/usr/bin/claude'),
        runChild,
        writeTemp: () => {
          throw new Error('no space')
        },
        removeTemp: () => {},
        makeTempPath: () => '/tmp/podium-mcp-nospace.json',
      },
    )
    expect(result).toEqual({ ok: false, output: 'no space' })
    expect(runChild).not.toHaveBeenCalled()
  })

  it('returns a truthful result for an unknown harness without substituting', async () => {
    const runChild = vi.fn(async () => ({ stdout: 'x' }))
    const result = await executeBufferedHarnessTurn(
      { homeDir: undefined, harnessRuntime: undefined },
      req({ agent: 'shell' as unknown as BufferedHarnessRequest['agent'], prompt: 'p' }),
      {
        snapshot: async () => fakeSnapshot('shell', '/bin/bash'),
        runChild,
      },
    )
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/no harness manifest/)
    expect(runChild).not.toHaveBeenCalled()
  })

  it('refetches a stale generation once before executing', async () => {
    const stale = fakeSnapshot('claude-code', '/stale/claude')
    const fresh = fakeSnapshot('claude-code', '/fresh/claude')
    const seen: string[] = []
    const current = vi
      .fn<() => Promise<ResolvedHarnessInventory>>()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(fresh)
    const isCurrent = vi.fn((s: ResolvedHarnessInventory) => s === fresh)
    const result = await executeBufferedHarnessTurn(
      { homeDir: undefined, harnessRuntime: { current, isCurrent } },
      req({ agent: 'claude-code', prompt: 'p' }),
      {
        runChild: async (cmd) => {
          seen.push(cmd)
          return { stdout: 'ok' }
        },
      },
    )
    expect(result).toEqual({ ok: true, output: 'ok' })
    expect(current).toHaveBeenCalledTimes(2)
    expect(seen).toEqual(['/fresh/claude'])
  })

  it('wire adapter echoes requestId with old-peer result shape', async () => {
    const sent: unknown[] = []
    const ctx = {
      homeDir: undefined,
      harnessRuntime: {
        current: async () => fakeSnapshot('shell', '/bin/bash'),
        isCurrent: () => true,
      },
      send: (m: unknown) => void sent.push(m),
    } as unknown as Parameters<typeof execHandlers.harnessExecRequest>[0]
    execHandlers.harnessExecRequest(
      ctx,
      req({
        agent: 'shell' as unknown as BufferedHarnessRequest['agent'],
        requestId: 'hx-old-peer',
      } as Partial<BufferedHarnessRequest>),
    )
    for (let i = 0; i < 100 && sent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(sent).toEqual([
      {
        type: 'harnessExecResult',
        requestId: 'hx-old-peer',
        ok: false,
        output: expect.stringMatching(/no harness manifest/),
      },
    ])
  })
})
