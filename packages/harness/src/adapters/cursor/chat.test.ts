/**
 * CURSOR CHAT ALLOCATION (moved behaviors from
 * apps/daemon/src/headless-drivers.test.ts in 1.5 with the code they pin).
 */

import { describe, expect, it } from 'vitest'
import type { ResolvedHarnessInventory } from '../../inventory/build-inventory.js'
import { cursorCreateChatInvocation, parseCursorChatId } from './chat.js'

function snapshot(): ResolvedHarnessInventory {
  return {
    executables: new Map([
      ['cursor', { kind: 'cursor', path: '/opt/cursor-agent', generation: 1 }],
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

describe('cursor create-chat allocation', () => {
  it('resolves the cursor executable off the adapter and passes bare create-chat', () => {
    expect(cursorCreateChatInvocation(snapshot())).toEqual({
      cmd: '/opt/cursor-agent',
      args: ['create-chat'],
    })
  })

  it('takes the chat id from the last stdout line', () => {
    // Callers hand over trimmed output (readAllStdout trims); the id rides
    // the last line of it.
    expect(parseCursorChatId('noise\n9e804279-978a-4644-adc4-f815f25a5728')).toBe(
      '9e804279-978a-4644-adc4-f815f25a5728',
    )
  })

  it('refuses a non-id print rather than pinning a turn to a missing conversation', () => {
    expect(() => parseCursorChatId('chat created\n')).toThrow(
      'cursor create-chat did not print a chat id',
    )
    expect(() => parseCursorChatId('')).toThrow('cursor create-chat did not print a chat id')
  })
})
