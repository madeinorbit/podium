import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asAccountId, asSessionId } from '@podium/model'
import { abducoHasSession, isAbducoAvailable, killAbducoSession } from '@podium/pty'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acknowledgeDurableHeadlessTurn,
  buildClaudeDurableExec,
  createDurableProgressParser,
  runDurableHeadlessTurn,
} from './durable-headless.js'
import { testHarnessSnapshot } from './test-support/harness-snapshot.js'

const roots: string[] = []
const identity = {
  accountId: asAccountId('native:claude-code:test'),
  requestDigest: 'a'.repeat(64),
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('durable headless invocation', () => {
  it('publishes Codex session, tool, and assistant events as stdout lines arrive', () => {
    const events: Parameters<Parameters<typeof createDurableProgressParser>[1]>[0][] = []
    const parser = createDurableProgressParser('codex', (event) => events.push(event))

    parser.push('{"type":"thread.started","thread_id":"thread-live"}\n')
    expect(events).toEqual([{ kind: 'status', status: 'running', harnessSessionId: 'thread-live' }])

    // A partial line must stay buffered; the event appears only when the JSONL
    // record is complete, still well before any exit/result marker exists.
    parser.push(
      '{"type":"item.started","item":{"id":"tool-1","type":"mcp_tool_call","name":"sessions.status"}}',
    )
    expect(events).toHaveLength(1)
    parser.push('\n')
    expect(events.at(-1)).toEqual({
      kind: 'status',
      status: 'tool',
      label: 'sessions.status',
    })

    parser.push(
      '{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"First live update"}}\n',
    )
    expect(events.at(-1)).toEqual({
      kind: 'partial-text',
      text: 'First live update',
      itemHint: 'msg-1',
    })
  })

  it('publishes cumulative Claude partial text and tool activity from the journal', () => {
    const events: Parameters<Parameters<typeof createDurableProgressParser>[1]>[0][] = []
    const parser = createDurableProgressParser('claude-code', (event) => events.push(event))

    parser.push(
      `${[
        '{"type":"system","subtype":"init","session_id":"claude-live"}',
        '{"type":"stream_event","uuid":"msg-1","event":{"type":"message_start"}}',
        '{"type":"stream_event","uuid":"msg-1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Working"}}}',
        '{"type":"stream_event","uuid":"msg-1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":" live"}}}',
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
      ].join('\n')}\n`,
    )

    expect(events).toContainEqual({
      kind: 'status',
      status: 'running',
      harnessSessionId: 'claude-live',
    })
    expect(events).toContainEqual({
      kind: 'partial-text',
      text: 'Working live',
      itemHint: 'msg-1',
    })
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'tool', label: 'Read' })
  })

  it('uses Claude native auto mode and keeps machine context out of stdin', () => {
    const exec = buildClaudeDurableExec(
      {
        agent: 'claude-code',
        ...identity,
        cwd: '/repo',
        prompt: 'human text',
        contextPrompt: 'machine context',
        systemPrompt: 'orchestrator',
        permissionMode: 'bypassPermissions',
        sessionUuid: randomUUID(),
      },
      { mcp: '/tmp/mcp.json' },
    )
    expect(exec.stdin).toBe('human text')
    expect(exec.args).toContain('--permission-mode')
    expect(exec.args[exec.args.indexOf('--permission-mode') + 1]).toBe('auto')
    expect(exec.args).not.toContain('--dangerously-skip-permissions')
    expect(exec.args[exec.args.indexOf('--append-system-prompt') + 1]).toBe(
      'orchestrator\n\nmachine context',
    )
  })

  it('reapplies the current system prompt when resuming a Claude CLI thread', () => {
    const exec = buildClaudeDurableExec(
      {
        agent: 'claude-code',
        ...identity,
        cwd: '/repo',
        prompt: 'Why?',
        systemPrompt: 'NORMAL: HARD LIMIT 80 words total',
        resumeValue: 'claude-thread-1',
      },
      { mcp: '/tmp/mcp.json' },
    )

    expect(exec.stdin).toBe('Why?')
    expect(
      exec.args.slice(exec.args.indexOf('--resume'), exec.args.indexOf('--resume') + 2),
    ).toEqual(['--resume', 'claude-thread-1'])
    expect(exec.args[exec.args.indexOf('--append-system-prompt') + 1]).toBe(
      'NORMAL: HARD LIMIT 80 words total',
    )
  })

  it('removes Claude tools and MCP from a durable repair invocation', () => {
    const exec = buildClaudeDurableExec(
      {
        agent: 'claude-code',
        ...identity,
        cwd: '/repo',
        prompt: 'repair',
        toolPolicy: 'none',
        mcpConfig: '{"mcpServers":{"podium":{"url":"http://podium.invalid"}}}',
      },
      { mcp: '/tmp/mcp.json' },
    )
    expect(exec.args.slice(exec.args.indexOf('--tools'), exec.args.indexOf('--tools') + 2)).toEqual(
      ['--tools', ''],
    )
    expect(exec.args).not.toContain('--mcp-config')
    expect(
      exec.args.slice(
        exec.args.indexOf('--setting-sources'),
        exec.args.indexOf('--setting-sources') + 2,
      ),
    ).toEqual(['--setting-sources', ''])
  })
})

describe.skipIf(!isAbducoAvailable())('durable headless abduco lifecycle', () => {
  it('reattaches the same in-flight turn after the local daemon handle is disposed', async () => {
    // Keep paths SHORT: the abduco socket lives at
    // $ABDUCO_SOCKET_DIR/abduco/<label> and unix sun_path caps at ~107 bytes.
    // Under the per-run TMPDIR containment (/tmp/podium-test-run-XXXXXX) a long
    // prefix + full-UUID label overflows it: "create-session: File name too long".
    const root = mkdtempSync(join(tmpdir(), 'pod-hl-'))
    roots.push(root)
    const binDir = join(root, 'bin')
    const socketDir = join(root, 'abduco')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(socketDir, { recursive: true })
    const grok = join(binDir, 'grok')
    // Keep the fake agent alive long enough that the dispose→reattach→assert
    // sequence below cannot race its natural exit under CI load. It also
    // observes the real detached process environment: a manifest-declared
    // provider key inherited by the daemon must be absent in the harness.
    writeFileSync(
      grok,
      '#!/bin/sh\nif [ -n "${XAI_API_KEY+x}" ]; then echo "leaked XAI_API_KEY" >&2; exit 42; fi\nsleep 2\nprintf "reply:%s\\n" "$*"\n',
    )
    chmodSync(grok, 0o755)

    const previous = {
      PATH: process.env.PATH,
      PODIUM_STATE_DIR: process.env.PODIUM_STATE_DIR,
      ABDUCO_SOCKET_DIR: process.env.ABDUCO_SOCKET_DIR,
      PODIUM_NO_SCOPE: process.env.PODIUM_NO_SCOPE,
      XAI_API_KEY: process.env.XAI_API_KEY,
    }
    process.env.PATH = `${binDir}:${previous.PATH ?? ''}`
    const snapshot = testHarnessSnapshot({ grok: join(binDir, 'grok') })
    process.env.PODIUM_STATE_DIR = join(root, 'state')
    process.env.ABDUCO_SOCKET_DIR = socketDir
    process.env.PODIUM_NO_SCOPE = '1'
    process.env.XAI_API_KEY = 'inherited-daemon-key'

    const sessionId = asSessionId(randomUUID().slice(0, 8)) // short: label feeds the socket path
    const turnId = randomUUID()
    const label = `podium-${sessionId}`
    const spec = {
      agent: 'grok' as const,
      accountId: asAccountId('native:grok:test'),
      requestDigest: 'b'.repeat(64),
      cwd: root,
      prompt: 'survive',
      contextPrompt: 'hidden context',
      permissionMode: 'auto',
      sessionUuid: randomUUID(),
      timeoutMs: 15_000,
    }
    try {
      const first = runDurableHeadlessTurn(turnId, sessionId, spec, () => {}, snapshot)
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await abducoHasSession(label)) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(await abducoHasSession(label)).toBe(true)
      expect(() =>
        runDurableHeadlessTurn(
          turnId,
          sessionId,
          { ...spec, prompt: 'changed input', requestDigest: 'c'.repeat(64) },
          () => {},
          snapshot,
        ),
      ).toThrow(/replay identity mismatch/)
      acknowledgeDurableHeadlessTurn({
        sessionId: asSessionId('different-session'),
        turnId,
        accountId: spec.accountId,
        requestDigest: spec.requestDigest,
      })
      expect(() =>
        acknowledgeDurableHeadlessTurn({
          sessionId,
          turnId,
          accountId: spec.accountId,
          requestDigest: 'c'.repeat(64),
        }),
      ).toThrow(/mismatched durable headless acknowledgement/)
      first.dispose?.()

      const reattached = runDurableHeadlessTurn(turnId, sessionId, spec, () => {}, snapshot)
      // Poll rather than one-shot: reattach latency varies under load.
      let stillAlive = false
      for (let attempt = 0; attempt < 100; attempt++) {
        stillAlive = await abducoHasSession(label)
        if (stillAlive) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(stillAlive).toBe(true)
      reattached.dispose?.()

      // Let the harness finish with no daemon attachment. The next daemon must
      // recover the completed output journal rather than treating the vanished
      // socket as a failed turn. Wait for the abduco session to actually end
      // instead of a fixed sleep.
      for (let attempt = 0; attempt < 300; attempt++) {
        if (!(await abducoHasSession(label))) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
      const recovered = runDurableHeadlessTurn(turnId, sessionId, spec, () => {}, snapshot)
      await expect(recovered.done).resolves.toMatchObject({
        harnessSessionId: spec.sessionUuid,
        output: expect.stringContaining('survive'),
      })
      acknowledgeDurableHeadlessTurn({
        sessionId,
        turnId,
        accountId: spec.accountId,
        requestDigest: spec.requestDigest,
      })
    } finally {
      await killAbducoSession(label)
      process.env.PATH = previous.PATH
      if (previous.PODIUM_STATE_DIR === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = previous.PODIUM_STATE_DIR
      if (previous.ABDUCO_SOCKET_DIR === undefined) delete process.env.ABDUCO_SOCKET_DIR
      else process.env.ABDUCO_SOCKET_DIR = previous.ABDUCO_SOCKET_DIR
      if (previous.PODIUM_NO_SCOPE === undefined) delete process.env.PODIUM_NO_SCOPE
      else process.env.PODIUM_NO_SCOPE = previous.PODIUM_NO_SCOPE
      if (previous.XAI_API_KEY === undefined) delete process.env.XAI_API_KEY
      else process.env.XAI_API_KEY = previous.XAI_API_KEY
    }
  }, 60_000)
})
