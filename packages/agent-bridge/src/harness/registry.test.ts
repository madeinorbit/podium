import { AGENT_CAPABILITIES, HarnessAgent } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { agentStateProviderFor, HARNESS_ADAPTERS, harnessAdapterFor } from './registry.js'

const CAPABILITY_FIELDS = [
  'argvPrompt',
  'effortFlag',
  'systemPromptFlag',
  'quota',
  'cloud',
  'composerScrape',
  'oscTitle',
  'subagentModelEnv',
  'hookInstall',
] as const

describe('harness adapter registry', () => {
  it('has one adapter per harness kind with every capability field declared', () => {
    // 'New harness = one adapter file + registry entry': every HarnessAgent has
    // an adapter, keyed by its own kind, embedding its protocol capability row
    // with ALL fields present (no partial rows sneaking in via casts).
    for (const kind of HarnessAgent.options) {
      const adapter = HARNESS_ADAPTERS[kind]
      expect(adapter, `missing adapter for ${kind}`).toBeDefined()
      expect(adapter.kind).toBe(kind)
      expect(adapter.capabilities).toBe(AGENT_CAPABILITIES[kind])
      for (const field of CAPABILITY_FIELDS) {
        expect(adapter.capabilities[field], `${kind}.capabilities.${field}`).toBeDefined()
      }
      // Every axis is declared: launch/exec builders, headless strategy,
      // discovery provider, transcript source.
      expect(typeof adapter.launch).toBe('function')
      expect(typeof adapter.exec).toBe('function')
      expect(typeof adapter.inventory.binCandidates).toBe('function')
      expect(typeof adapter.inventory.detectLogin).toBe('function')
      expect(adapter.headless.driver).toBeDefined()
      expect(adapter.headless.resumeIdAllocation).toBeDefined()
      expect(adapter.discovery.agentKind).toBe(kind)
      expect(adapter.transcript.storage).toMatch(/^(file-chain|sqlite)$/)
      expect(typeof adapter.transcript.sourceFor).toBe('function')
      expect(typeof adapter.resumeKind).toBe('string')
    }
  })

  it('file-chain adapters declare chainPaths; the sqlite adapter does not need one', () => {
    for (const kind of HarnessAgent.options) {
      const adapter = HARNESS_ADAPTERS[kind]
      if (adapter.transcript.storage === 'file-chain') {
        expect(typeof adapter.transcript.chainPaths, kind).toBe('function')
      }
    }
  })

  it('child-process headless drivers declare buildExec; the SDK driver does not', () => {
    for (const kind of HarnessAgent.options) {
      const adapter = HARNESS_ADAPTERS[kind]
      if (adapter.headless.driver === 'claude-sdk') {
        expect(adapter.headless.buildExec).toBeUndefined()
      } else {
        expect(typeof adapter.headless.buildExec, kind).toBe('function')
      }
    }
  })

  it('classifies own-domain browser opens: oauth paths are logins, the rest links', () => {
    const claude = HARNESS_ADAPTERS['claude-code']
    expect(
      claude.classifyBrowserOpen?.(new URL('https://claude.ai/oauth/authorize?client_id=x')),
    ).toEqual({ intent: 'login' })
    expect(
      claude.classifyBrowserOpen?.(
        new URL('https://claude.ai/code/artifact/abc?via=auto_preview'),
      ),
    ).toEqual({ intent: 'link' })
    expect(claude.classifyBrowserOpen?.(new URL('https://example.com/'))).toBeUndefined()

    const codex = HARNESS_ADAPTERS.codex
    expect(codex.classifyBrowserOpen?.(new URL('https://auth.openai.com/oauth/authorize'))).toEqual(
      { intent: 'login' },
    )
    expect(codex.classifyBrowserOpen?.(new URL('https://chatgpt.com/share/x'))).toEqual({
      intent: 'link',
    })
    expect(codex.classifyBrowserOpen?.(new URL('https://example.com/'))).toBeUndefined()
  })

  it('shell and unknown kinds have no adapter', () => {
    expect(harnessAdapterFor('shell')).toBeUndefined()
    expect(harnessAdapterFor('not-a-kind')).toBeUndefined()
    expect(agentStateProviderFor('shell')).toBeUndefined()
  })
})
