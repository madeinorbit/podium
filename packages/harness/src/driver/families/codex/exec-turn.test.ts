/**
 * THE CODEX EXEC TURN (moved behaviors from
 * apps/daemon/src/headless-drivers.test.ts in 1.5 with the code they pin).
 *
 * Argv off the adapter's `headless.buildExec` section, and the JSONL fold
 * over a stand-in binary — the same hermetic shape as the daemon's pi
 * stand-in suite, pointed at a fake `codex exec --json`.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { HeadlessTurnEvent } from '@podium/protocol'
import type { ResolvedHarnessInventory } from '../../../inventory/build-inventory.js'
import { buildCodexExecTurn, runCodexExecTurn } from './exec-turn.js'
import { manifestFor } from '../../../registry.js'

/** The real headless section, handed in (tests may read the registry). */
function headlessSections() {
  return { headless: manifestFor('codex')!.headless }
}

function snapshot(): ResolvedHarnessInventory {
  return {
    executables: new Map([
      ['codex', { kind: 'codex', path: '/opt/codex', generation: 1 }],
    ]),
    commandEnvironment: {
      env: { PATH: '/opt:/usr/bin:/bin', HOME: '/tmp' },
      pathEntries: ['/opt', '/usr/bin', '/bin'],
      source: 'inherited',
      generation: 1,
      machineHome: '/tmp',
      loginShell: '/bin/sh',
      resolve: () => undefined,
    },
  } as unknown as ResolvedHarnessInventory
}

describe('buildCodexExecTurn argv shapes', () => {
  it('first turn: exec --json with positional prompt, no resume subcommand', () => {
    const { cmd, args } = buildCodexExecTurn({ prompt: 'hi there' }, snapshot(), headlessSections())
    expect(cmd).toBe('/opt/codex')
    expect(args).toEqual(['exec', '--json', '--skip-git-repo-check', 'hi there'])
  })

  it('resume turn: exec resume <id> subcommand before flags', () => {
    const { args } = buildCodexExecTurn(
      { prompt: 'go on', resumeValue: '019f-abc', model: 'gpt-5.2-codex' },
      snapshot(),
      headlessSections(),
    )
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '019f-abc'])
  })
})

describe('runCodexExecTurn against a stand-in binary', () => {
  /** A fake `codex exec --json`: prints a thread start, a tool item and an
   *  agent message echoing the positional prompt. */
  const script = [
    `const args = process.argv.slice(2)`,
    `const resumeIx = args.indexOf('resume')`,
    `const thread = resumeIx >= 0 ? args[resumeIx + 1] : 'thr-fake-1'`,
    `const prompt = args[args.length - 1]`,
    `console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }))`,
    `console.log(JSON.stringify({ type: 'item.started', item: { id: 'i1', type: 'todo' } }))`,
    `console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'done:' + prompt } }))`,
  ].join('\n')

  function runTurn(prompt: string) {
    const events: HeadlessTurnEvent[] = []
    const turn = runCodexExecTurn({
      prompt,
      cwd: '/tmp',
      timeoutMs: 10_000,
      env: {},
      sections: headlessSections(),
      snapshot: snapshot(),
      emit: (event) => events.push(event),
      spawnChild: (cmd, args, opts) => {
        expect(cmd).toBe('/opt/codex')
        const child = spawn(process.execPath, ['-e', script, ...args], {
          cwd: opts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...opts.env },
        }) as ChildProcess
        child.stdin?.end()
        return child
      },
    })
    return { turn, events }
  }

  it('captures the thread id and the agent message', async () => {
    const { turn, events } = runTurn('hello')
    const outcome = await turn.done
    expect(outcome.harnessSessionId).toBe('thr-fake-1')
    expect(outcome.output).toBe('done:hello')
    expect(events).toContainEqual({ kind: 'status', status: 'tool', label: 'todo' })
    expect(events).toContainEqual({
      kind: 'partial-text',
      text: 'done:hello',
      itemHint: 'i2',
    })
  })

  it('fails a turn that ends without a thread id, rather than orphaning it', async () => {
    const events: HeadlessTurnEvent[] = []
    const turn = runCodexExecTurn({
      prompt: 'hello',
      cwd: '/tmp',
      timeoutMs: 10_000,
      env: {},
      sections: headlessSections(),
      snapshot: snapshot(),
      emit: (event) => events.push(event),
      spawnChild: () => {
        const child = spawn(process.execPath, ['-e', ''], {
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as ChildProcess
        child.stdin?.end()
        return child
      },
    })
    await expect(turn.done).rejects.toThrow('codex turn ended without reporting a thread id')
  })
})
