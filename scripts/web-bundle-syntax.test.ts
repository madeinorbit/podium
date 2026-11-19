import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lowerDecorators } from './vite-standard-decorators'
import { browserSyntaxErrors } from './web-bundle-syntax'

const decorated = `class TranscriptState {
  @observable accessor justSent = false
  @lazy get ready() { return !this.justSent }
}`

describe('emitted browser JavaScript syntax', () => {
  it('rejects native decorators in a minified worker with no source map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-worker-syntax-'))
    try {
      mkdirSync(join(dir, 'assets', 'workers'), { recursive: true })
      writeFileSync(join(dir, 'assets', 'app.js'), 'export const ready = true')
      writeFileSync(
        join(dir, 'assets', 'workers', 'transcript.js'),
        'var State=class{pending=[];@observable accessor justSent=false;@lazy get ready(){return !this.justSent}};',
      )
      const result = browserSyntaxErrors(dir)
      expect(result.files).toBe(2)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatch(/assets\/workers\/transcript\.js:.*Unexpected character '@'/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts lowered worker decorators and ignores at-signs in strings and comments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-worker-syntax-'))
    try {
      const { code } = await lowerDecorators(decorated, '/fixture/transcript-model.ts')
      writeFileSync(join(dir, 'transcript.worker.js'), code)
      writeFileSync(join(dir, 'sw.js'), '/* @license */ const text = "@media @observable";')
      writeFileSync(join(dir, 'ignored.js.map'), '@this is not JavaScript')
      expect(browserSyntaxErrors(dir)).toEqual({ files: 2, errors: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
