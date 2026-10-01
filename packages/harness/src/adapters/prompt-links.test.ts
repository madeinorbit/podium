import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeRecordToItems } from './claude-code/transcript.js'
import { codexRecordToItems } from './codex/transcript.js'
import { grokRecordToItems } from './grok/transcript.js'
import { readFileItems } from '../store/slice.js'

describe('submit hook ids on recorded prompts (POD-4834)', () => {
  it('Claude keeps promptId on the recorded human prompt', () => {
    const [item] = claudeRecordToItems({ type: 'user', uuid: 'user-id', promptId: 'prompt-id',
      promptSource: 'typed', message: { role: 'user', content: 'Yes' } })
    expect(item?.harnessRef).toEqual([{ kind: 'claude-prompt', id: 'prompt-id' }])
  })
  it('Codex keeps the turn_id on UserMessage completion', () => {
    const [item] = codexRecordToItems({ type: 'event_msg', payload: {
      type: 'item_completed', turn_id: 'turn-id', item: { type: 'UserMessage', id: 'item-id',
        content: [{ type: 'input_text', text: 'Yes' }] } } })
    expect(item?.harnessRef).toEqual([{ kind: 'codex-turn', id: 'turn-id' }])
  })
  it('Grok links only the immediately preceding submit hook_execution, including on a fresh read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-prompt-link-'))
    try {
      const hook = { params: { update: { sessionUpdate: 'hook_execution',
        event_name: 'user_prompt_submit', prompt_id: 'grok-id' } } }
      const chunk = { params: { _meta: { agentTimestampMs: 1790839175000 }, update: {
        sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Yes' } } } }
      const path = join(dir, 'updates.jsonl')
      await writeFile(path, [hook, chunk, chunk, hook, { params: { update: { sessionUpdate: 'turn_completed' } } }, chunk]
        .map((record) => JSON.stringify(record) + '\n').join(''))
      for (let read = 0; read < 2; read++) {
        const items = await readFileItems(path, 'updates', grokRecordToItems)
        expect(items.map((item) => item.harnessRef)).toEqual([[{ kind: 'grok-prompt', id: 'grok-id' }], undefined, undefined])
      }
      // Reading a chunk alone has no preceding record, and cannot borrow an id from another reader.
      expect(grokRecordToItems(chunk)[0]?.harnessRef).toBeUndefined()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
