import { normalizeSettings, type PodiumSettings } from '@podium/runtime'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { LlmClient, LlmMessage } from './llm'
import { completeForRole, jsonSchema, resolveOneShotBackend } from './llm-roles'

const settings = (patch: Partial<PodiumSettings> = {}): PodiumSettings =>
  normalizeSettings({
    workLlm: { kind: 'api', provider: 'openrouter', model: 'bg-model' },
    superagent: { kind: 'api', provider: 'anthropic', model: 'sa-model' },
    apiKeys: { openrouter: 'or-key', anthropic: 'an-key', openai: '' },
    ...patch,
  })

/** A fake llmClient factory: records what it was built with, returns fixed text. */
function fakeLlm(text: string) {
  const calls: { model: string; messages: LlmMessage[] }[] = []
  const factory = ((backend: { model: string }): LlmClient => ({
    label: `fake · ${backend.model}`,
    complete: async (messages: LlmMessage[]) => {
      calls.push({ model: backend.model, messages })
      return { text, toolCalls: [] }
    },
  })) as unknown as Parameters<typeof completeForRole>[0]['llm']
  return { factory, calls }
}

describe('resolveOneShotBackend', () => {
  it('maps background→workLlm and superagent→superagent', () => {
    const s = settings()
    expect(resolveOneShotBackend(s, 'background').model).toBe('bg-model')
    expect(resolveOneShotBackend(s, 'superagent').model).toBe('sa-model')
  })
})

describe('completeForRole', () => {
  it('resolves the role backend, calls the client, returns raw text by default', async () => {
    const { factory, calls } = fakeLlm('hello world')
    const r = await completeForRole(
      { settings: settings(), llm: factory },
      { role: 'background', messages: [{ role: 'user', content: 'hi' }] },
    )
    expect(r.data).toBe('hello world')
    expect(r.text).toBe('hello world')
    expect(calls[0]!.model).toBe('bg-model') // used the workLlm backend
  })

  it('parses into structured data when given parse', async () => {
    const { factory } = fakeLlm('the title is:\n```json\n{"title":"Fix login"}\n```')
    const r = await completeForRole(
      { settings: settings(), llm: factory },
      {
        role: 'background',
        messages: [{ role: 'user', content: 'name it' }],
        parse: jsonSchema(z.object({ title: z.string() })),
      },
    )
    expect(r.data).toEqual({ title: 'Fix login' })
  })

  it('returns null data (not a throw) when the model output cannot be parsed', async () => {
    const { factory } = fakeLlm('no json here, sorry')
    const r = await completeForRole(
      { settings: settings(), llm: factory },
      {
        role: 'background',
        messages: [{ role: 'user', content: 'x' }],
        parse: jsonSchema(z.object({ title: z.string() })),
      },
    )
    expect(r.data).toBeNull()
  })
})

describe('jsonSchema', () => {
  const parse = jsonSchema(z.object({ a: z.number() }))
  it('extracts a braced object from surrounding prose', () => {
    expect(parse('sure: {"a": 1} done')).toEqual({ a: 1 })
  })
  it('extracts a fenced json block', () => {
    expect(parse('```json\n{"a": 2}\n```')).toEqual({ a: 2 })
  })
  it('returns null on schema mismatch', () => {
    expect(parse('{"a": "not a number"}')).toBeNull()
  })
  it('returns null when no object is present', () => {
    expect(parse('plain text')).toBeNull()
  })
})
