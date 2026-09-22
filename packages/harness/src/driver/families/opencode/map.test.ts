import { opencodePartToItems } from '../../../adapters/opencode/transcript.js'
import { stampOpencodeItems } from '../../../store/sources/sqlite.js'
import { describe, expect, it } from 'vitest'
import messagesFixture from './__fixtures__/messages-permission-turn.json'
import { deltaItemIdForPart, deltaItemIdOf, partToItems } from './map.js'
import { OpencodeMessageWithParts } from './protocol.js'

describe('OpenCode live and replay identity', () => {
  it('gives every recorded history item exactly one live identity, including result slots', () => {
    const bytes = JSON.stringify(messagesFixture)
    const parse = () =>
      (JSON.parse(bytes) as unknown[]).map((value) => OpencodeMessageWithParts.parse(value))
    const historyIds: string[] = []
    const liveIds: string[] = []
    let resultSlots = 0
    for (const message of parse()) {
      for (const part of message.parts) {
        const sessionId = message.info.sessionID
        const row = {
          sessionId,
          messageId: message.info.id,
          partId: part.id,
          timeCreated: message.info.time?.created ?? 0,
          timeUpdated: 1_800_000_000_000,
          messageData: JSON.stringify(message.info),
          partData: JSON.stringify(part),
        }
        const history = stampOpencodeItems([row], sessionId)
        const live = partToItems(sessionId, message.info, part)
        expect(live.map((item) => item.id)).toEqual(history.map((item) => item.id))
        expect(opencodePartToItems(row).map((item) => item.id)).toEqual(
          history.map((item) => item.id),
        )
        history.forEach((item, sub) => {
          expect(deltaItemIdForPart(sessionId, part.id, sub)).toBe(item.id)
          expect(deltaItemIdOf(live, sub)).toBe(item.id)
          if (sub > 0) resultSlots++
          historyIds.push(item.id)
          liveIds.push(deltaItemIdForPart(sessionId, part.id, sub))
        })
      }
    }
    expect(resultSlots).toBeGreaterThan(0)
    expect(historyIds.length).toBeGreaterThan(0)
    expect(new Set(historyIds).size).toBe(historyIds.length)
    for (const id of historyIds) expect(liveIds.filter((liveId) => liveId === id)).toHaveLength(1)
    const replayed = parse().flatMap((message) =>
      message.parts.flatMap((part) =>
        partToItems(message.info.sessionID, message.info, part).map((item) => item.id),
      ),
    )
    expect(replayed).toEqual(historyIds)
  })

  it('uses item identity directly, even when its paging cursor is different', () => {
    expect(
      deltaItemIdOf([{ id: 'durable-id', cursor: 'paging-only', role: 'assistant', text: 'a' }]),
    ).toBe('durable-id')
    expect(deltaItemIdOf([])).toBeUndefined()
  })
})
