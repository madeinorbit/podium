import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { jsonSchema } from './llm-roles'

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
