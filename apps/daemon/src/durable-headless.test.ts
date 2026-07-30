import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abducoHasSessionAsync, isAbducoAvailable, killAbducoSession } from '@podium/agent-bridge'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acknowledgeDurableHeadlessTurn,
  buildClaudeDurableExec,
  runDurableHeadlessTurn,
} from './durable-headless.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('durable headless invocation', () => {
  it('uses Claude native auto mode and keeps machine context out of stdin', () => {
    const exec = buildClaudeDurableExec(
      {
        agent: 'claude-code',
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
    // sequence below cannot race its natural exit under CI load.
    writeFileSync(grok, '#!/bin/sh\nsleep 2\nprintf "reply:%s\\n" "$*"\n')
    chmodSync(grok, 0o755)

    const previous = {
      PATH: process.env.PATH,
      PODIUM_STATE_DIR: process.env.PODIUM_STATE_DIR,
      ABDUCO_SOCKET_DIR: process.env.ABDUCO_SOCKET_DIR,
      PODIUM_NO_SCOPE: process.env.PODIUM_NO_SCOPE,
    }
    process.env.PATH = `${binDir}:${previous.PATH ?? ''}`
    process.env.PODIUM_STATE_DIR = join(root, 'state')
    process.env.ABDUCO_SOCKET_DIR = socketDir
    process.env.PODIUM_NO_SCOPE = '1'

    const sessionId = randomUUID().slice(0, 8) // short: label feeds the socket path
    const turnId = randomUUID()
    const label = `podium-${sessionId}`
    const spec = {
      agent: 'grok' as const,
      cwd: root,
      prompt: 'survive',
      contextPrompt: 'hidden context',
      permissionMode: 'auto',
      sessionUuid: randomUUID(),
      timeoutMs: 15_000,
    }
    try {
      const first = runDurableHeadlessTurn(turnId, sessionId, spec, () => {}, {
        opencode: () => 'opencode',
        cursor: () => 'cursor-agent',
      })
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await abducoHasSessionAsync(label)) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(await abducoHasSessionAsync(label)).toBe(true)
      first.dispose?.()

      const reattached = runDurableHeadlessTurn(turnId, sessionId, spec, () => {}, {
        opencode: () => 'opencode',
        cursor: () => 'cursor-agent',
      })
      // Poll rather than one-shot: reattach latency varies under load.
      let stillAlive = false
      for (let attempt = 0; attempt < 100; attempt++) {
        stillAlive = await abducoHasSessionAsync(label)
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
        if (!(await abducoHasSessionAsync(label))) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
      const recovered = runDurableHeadlessTurn(turnId, sessionId, spec, () => {}, {
        opencode: () => 'opencode',
        cursor: () => 'cursor-agent',
      })
      await expect(recovered.done).resolves.toMatchObject({
        harnessSessionId: spec.sessionUuid,
        output: expect.stringContaining('survive'),
      })
      acknowledgeDurableHeadlessTurn(turnId)
    } finally {
      killAbducoSession(label)
      process.env.PATH = previous.PATH
      if (previous.PODIUM_STATE_DIR === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = previous.PODIUM_STATE_DIR
      if (previous.ABDUCO_SOCKET_DIR === undefined) delete process.env.ABDUCO_SOCKET_DIR
      else process.env.ABDUCO_SOCKET_DIR = previous.ABDUCO_SOCKET_DIR
      if (previous.PODIUM_NO_SCOPE === undefined) delete process.env.PODIUM_NO_SCOPE
      else process.env.PODIUM_NO_SCOPE = previous.PODIUM_NO_SCOPE
    }
  }, 60_000)
})
