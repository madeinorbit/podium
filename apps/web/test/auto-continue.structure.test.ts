// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL('../src/' + rel, import.meta.url)), 'utf8')

describe('auto-continue popup', () => {
  it('store gates the popup on shouldPromptAutoContinue after a manual continue', () => {
    const src = read('store.tsx')
    expect(src).toContain('shouldPromptAutoContinue')
    expect(src).toContain('autoContinuePromptSessionId')
    expect(src).toContain('closeAutoContinuePrompt')
  })

  it('dialog warns about runaway token cost and offers enable / not now', () => {
    const src = read('AutoContinueDialog.tsx')
    expect(src).toContain('Enable auto-continue')
    expect(src).toContain('Not now')
    expect(src).toContain('indefinitely')
    expect(src).toContain('tokens')
    expect(src).toContain('promptDismissed: true')
  })

  it('AppShell mounts the dialog', () => {
    const src = read('AppShell.tsx')
    expect(src).toContain('<AutoContinueDialog')
  })
})
