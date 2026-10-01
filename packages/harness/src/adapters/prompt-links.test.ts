import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeRecordToItems } from './claude-code/transcript.js'
import { codexRecordToItems } from './codex/transcript.js'
import { grokRecordToItems } from './grok/transcript.js'
import { readFileItems } from '../store/slice.js'
import { tailTranscript } from '../store/tailer.js'

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

  it('Grok retains its preceding submit id across tail polls and clears it on truncation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-tail-link-'))
    const path = join(dir, 'updates.jsonl')
    const hook = { params: { update: { sessionUpdate: 'hook_execution',
      event_name: 'user_prompt_submit', prompt_id: 'tailed-id' } } }
    const chunk = { params: { _meta: { agentTimestampMs: 1790839175000 }, update: {
      sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Yes' } } } }
    const line = (record: unknown) => JSON.stringify(record) + '\n'
    const items: import('@podium/model').TranscriptItem[] = []
    let seeded!: () => void
    const seed = new Promise<void>((resolve) => { seeded = resolve })
    await writeFile(path, line(hook))
    const tailer = tailTranscript(path, (batch) => items.push(...batch), {
      resumeValue: 'grok-tail', pollMs: 10, recordToItems: grokRecordToItems,
      seedGate: async (read) => { await read(); seeded() },
    })
    const until = async (count: number) => {
      const deadline = Date.now() + 2000
      while (items.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2))
      expect(items).toHaveLength(count)
    }
    try {
      await seed
      await appendFile(path, line(chunk))
      await until(1)
      expect(items[0]?.harnessRef).toEqual([{ kind: 'grok-prompt', id: 'tailed-id' }])
      await writeFile(path, line(chunk))
      await until(2)
      expect(items[1]?.harnessRef).toBeUndefined()
    } finally {
      tailer.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
