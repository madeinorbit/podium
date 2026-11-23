import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { carryCodexRecord, locateCodexConversation } from './conversation-file'

const reasoning = { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'x' } }
const message = { type: 'response_item', payload: { type: 'message', role: 'user', content: 'hi' } }
const meta = { type: 'session_meta', payload: { id: 't', model_provider: 'stub' } }

describe('carryCodexRecord (POD-6893 §3)', () => {
  it('leaves out encrypted reasoning only when the account changes', () => {
    expect(carryCodexRecord(reasoning, { accountChanged: true })).toBeUndefined()
    expect(carryCodexRecord(reasoning, { accountChanged: false })).toBe(reasoning)
    expect(carryCodexRecord(message, { accountChanged: true })).toBe(message)
  })

  it('records the provider the target runs on, and keeps a record already on it', () => {
    expect(carryCodexRecord(meta, { accountChanged: false, modelProvider: 'openai' })).toEqual({
      type: 'session_meta',
      payload: { id: 't', model_provider: 'openai' },
    })
    expect(carryCodexRecord(meta, { accountChanged: true, modelProvider: 'stub' })).toBe(meta)
    expect(carryCodexRecord(meta, { accountChanged: true })).toBe(meta)
  })
})

describe('locateCodexConversation', () => {
  it('finds the rollout by its name inside the home and nowhere else', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-locate-'))
    try {
      const dir = join(home, 'sessions', '2026', '11', '16')
      await mkdir(dir, { recursive: true })
      const path = join(dir, 'rollout-2026-11-16T10-00-00-thread-9.jsonl')
      await writeFile(path, '{}\n')
      expect(await locateCodexConversation({ stateDir: home, resumeValue: 'thread-9' })).toBe(path)
      expect(
        await locateCodexConversation({ stateDir: home, resumeValue: 'thread-0' }),
      ).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
