// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL('../src/' + rel, import.meta.url)), 'utf8')

// These guard against reintroducing KNOWN-WRONG billing copy — the misleading
// wording must NOT reappear. (The positive anchor only proves the section still
// exists so the negative guard can't pass vacuously after a rename.)
describe('background LLM backend wording', () => {
  it('does not imply every API backend needs a separate key', () => {
    const src = read('features/settings/sections/shared.tsx')
    expect(src).toContain('Provider backend (API key or local login)') // anchor
    expect(src).not.toContain('API provider (key required)')
  })

  it('describes Claude Code harness usage without saying subscriptions are always API-billed', () => {
    const src = read('features/settings/sections/shared.tsx')
    expect(src).toContain('subscribers consume plan usage') // anchor
    expect(src).not.toContain('bills pay-per-use API rates even with a subscription')
  })
})
