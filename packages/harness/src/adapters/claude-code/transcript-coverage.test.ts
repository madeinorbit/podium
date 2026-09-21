import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import corpus from '../../store/__fixtures__/claude-corpus-shapes.json'
import {
  ATTACHMENT_TYPES,
  EFFECT_KEYS,
  IGNORED_EFFECT_KEYS,
  RECORD_TYPES,
  SYSTEM_TYPES,
  uncoveredClaudeShapes,
} from '../shared/claude-coverage.js'
import { claudeToolEffects } from '../shared/tool-effects.js'

describe('Claude corpus conformance', () => {
  it('classifies the real corpus and optional fresh JSONL corpus with a frequency threshold of 3', () => {
    expect(corpus.provenance.transcripts).toBe(12)
    expect(corpus.shapes.reduce((sum, shape) => sum + shape.count, 0)).toBe(
      corpus.provenance.records,
    )
    expect(corpus.provenance.records).toBeGreaterThan(20_000)
    const shapes: { count: number; record: Record<string, unknown> }[] = [...corpus.shapes]
    const directory = process.env.CLAUDE_CONFORMANCE_CORPUS
    if (directory) {
      const files = readdirSync(directory).filter((file) => file.endsWith('.jsonl'))
      expect(files.length).toBeGreaterThan(0)
      for (const file of files)
        for (const line of readFileSync(join(directory, file), 'utf8').split('\n').filter(Boolean))
          shapes.push({ count: 1, record: JSON.parse(line) })
    }
    expect(uncoveredClaudeShapes(shapes)).toEqual([])
  })

  it('every deliberate omission has a reason and is distinct from handled effects', () => {
    for (const registry of [IGNORED_EFFECT_KEYS, RECORD_TYPES, ATTACHMENT_TYPES, SYSTEM_TYPES])
      for (const reason of Object.values(registry)) expect(reason.length).toBeGreaterThan(10)
    for (const key of Object.keys(IGNORED_EFFECT_KEYS)) expect(EFFECT_KEYS.has(key)).toBe(false)
    for (const shape of corpus.shapes) {
      const unknown = claudeToolEffects(
        'toolUseResult' in shape.record ? shape.record.toolUseResult : undefined,
      ).filter((effect) => effect.kind === 'unknown')
      // Rare shapes remain visibly unknown until their frequency crosses admission.
      for (const effect of unknown)
        expect(Object.hasOwn(IGNORED_EFFECT_KEYS, effect.key)).toBe(false)
    }
  })

  it('counts unseen record, attachment, system and effect shapes independently', () => {
    const shapes = [
      { count: 3, record: { type: 'new-record' } },
      { count: 3, record: { type: 'attachment', attachment: { type: 'new-attachment' } } },
      { count: 3, record: { type: 'system', subtype: 'new-system' } },
      { count: 3, record: { type: 'user', toolUseResult: { newEffect: true } } },
    ]
    expect(uncoveredClaudeShapes(shapes)).toEqual([
      'attachment:new-attachment: 3',
      'effect:newEffect: 3',
      'record:new-record: 3',
      'system:new-system: 3',
    ])
    expect(claudeToolEffects({ newEffect: true })).toEqual([{ kind: 'unknown', key: 'newEffect' }])
  })
})
