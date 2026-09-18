import { asSessionId } from '@podium/model'
import { expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'
import { dispatchInputBytes } from './legacy-terminal-input'

const sessionId = asSessionId('legacy-input')
const bytes = Buffer.from('prompt\r')
it.each(['terminal', 'server', 'embedded', undefined] as const)(
  'keeps compatibility bridge-only for family=%s', (family) => {
    const writeBytes = vi.fn()
    const input = vi.fn(() => true)
    const onInputByte = vi.fn()
    const recordInputOrigin = vi.fn()
    const ctx = {
      agentRuntime: {
        has: () => family !== undefined,
        handleFor: () => family ? { binding: { family } } : undefined,
      },
      bridges: new Map([[sessionId, { writeBytes }]]),
      nativeClientRequests: new Set([sessionId]),
      clientTerminals: { input },
      composerEngine: { onInputByte },
      observers: { recordInputOrigin },
    } as unknown as DaemonContext
    dispatchInputBytes(ctx, { sessionId, inputOrigin: 'controller' }, bytes)
    const accepted = family === 'terminal' || family === undefined
    expect(writeBytes).toHaveBeenCalledTimes(accepted ? 1 : 0)
    expect(onInputByte).toHaveBeenCalledTimes(accepted ? 1 : 0)
    expect(recordInputOrigin).toHaveBeenCalledTimes(accepted ? 1 : 0)
    ctx.bridges.clear()
    dispatchInputBytes(ctx, { sessionId, inputOrigin: 'controller' }, bytes)
    expect(input).not.toHaveBeenCalled()
    expect(onInputByte).toHaveBeenCalledTimes(accepted ? 1 : 0)
  },
)
