import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import { directPtyDurableForTests } from '@podium/process/durable'
import { withHardRepaint } from '@podium/process/screen'
import { expect, it } from 'vitest'
import type { DaemonContext } from './context'
import { sessionHandlers } from './session'
import { attachTestTerminal, testSessions } from '../session/testing.js'

it('round-trips human shell bytes without a driver and redraw never submits the line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-host-input-'))
  const sessionId = asSessionId('plain-shell-boundary')
  const bridge = withHardRepaint(await directPtyDurableForTests().spawn({
    label: 'native-host-input',
    cmd: '/bin/bash', args: ['--noprofile', '--norc', '-i'],
    cwd: root, cols: 80, rows: 24,
    env: { HOME: root, HISTFILE: '/dev/null', PS1: 'HOST_READY> ' },
    stripEnv: ['BASH_ENV', 'ENV', 'PROMPT_COMMAND'],
  }), true)
  let output = ''
  const unsubscribe = bridge.onFrame((frame) => { output += Buffer.from(frame.data).toString() })
  const sessions = testSessions()
  attachTestTerminal({ sessions }, sessionId, bridge)
  const ctx = {
    sessions,
    observers: { recordInputOrigin: () => {} },
    composerEngine: { onInputByte: () => {} },
    outputScheduler: { flushNow: () => {} },
  } as unknown as DaemonContext
  const type = (text: string) => sessionHandlers.input(ctx, {
    type: 'input', sessionId, inputOrigin: 'human', data: Buffer.from(text).toString('base64'),
  })
  try {
    await expect.poll(() => output).toContain('HOST_READY>')
    type("printf '%s' delivered > receipt")
    await expect.poll(() => output).toContain('receipt')
    const before = output.length
    sessionHandlers.redraw(ctx, { type: 'redraw', sessionId })
    await expect.poll(() => output.length).toBeGreaterThan(before)
    expect(existsSync(join(root, 'receipt'))).toBe(false)
    type('\r')
    await expect.poll(() => existsSync(join(root, 'receipt'))).toBe(true)
    expect(readFileSync(join(root, 'receipt'), 'utf8')).toBe('delivered')
    expect(ctx.agentRuntime).toBeUndefined()
  } finally {
    unsubscribe()
    bridge.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
