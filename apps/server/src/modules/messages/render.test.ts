import { parseMailPointer } from '@podium/commands/mail-pointer-nudge'
import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../../store'
import { MessageRenderer } from './render'

const renderer = new MessageRenderer({
  issues: { reports: { getMeta: async () => undefined, niceRef: async () => '' } },
  sessionById: async () => undefined,
} as unknown as ConstructorParameters<typeof MessageRenderer>[0])

const row = (id: string, fromKind: MessageRow['fromKind']) =>
  ({ id, fromKind, toKind: 'issue', body: '' }) as unknown as MessageRow

describe('MessageRenderer.pointerText (POD-2143)', () => {
  it('names each sender once with its message ids, in a shape the client parses', async () => {
    const text = await renderer.pointerText([
      row('msg_a', 'operator'),
      row('msg_b', 'superagent'),
      row('msg_c', 'operator'),
    ])
    expect(text).toMatch(
      /^\[podium\] 3 message\(s\) from operator \(msg_a, msg_c\), superagent \(msg_b\) — run 'podium issue mail inbox'/,
    )
    expect(text).not.toContain('\n')
    expect(parseMailPointer(text)).toEqual({
      count: 3,
      senders: [
        { from: 'operator', ids: ['msg_a', 'msg_c'] },
        { from: 'superagent', ids: ['msg_b'] },
      ],
      rest: '',
    })
  })
})
