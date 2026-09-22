/**
 * Wire-identity pins for POD-4539 (4.R deviation D2).
 *
 * Each of the five server sites now derives from the one closed set instead
 * of retyping it. These tests pin the DERIVED members to the pre-change
 * literal lists, so editing the list (or the slice) fails here first:
 * RED with the list edited, green with the derivation intact.
 */
import {
  AgentKind,
  BUILTIN_HARNESS_KINDS,
  CLOUD_HARNESS_KINDS,
  HANDOFF_HARNESS_KINDS,
  HarnessAgent,
} from '@podium/model'
import {
  SHIPWRIGHT_EVAL_SUPPORTED_HARNESS,
  SHIPWRIGHT_EVAL_UNSUPPORTED_HARNESS,
} from '@podium/runtime'
import { describe, expect, it } from 'vitest'
import { harnessSupportsNoTools } from './harness-manifest'

describe('POD-4539 derived harness enums — wire identity', () => {
  it('keeps the full closed set byte-identical (machines/rpc harnessExec, shipwright find)', () => {
    expect([...HarnessAgent.options]).toEqual([
      'claude-code',
      'codex',
      'grok',
      'opencode',
      'cursor',
      'pi',
    ])
    expect([...BUILTIN_HARNESS_KINDS]).toEqual([...HarnessAgent.options])
  })

  it('keeps the tool-belt kind enum byte-identical (AgentKind plus shell)', () => {
    expect([...AgentKind.options]).toEqual([
      'claude-code',
      'codex',
      'grok',
      'opencode',
      'cursor',
      'pi',
      'shell',
    ])
  })

  it('keeps the two-member subsets byte-identical (cloud-runtime, machines/rpc handoffExport)', () => {
    expect([...CLOUD_HARNESS_KINDS]).toEqual(['claude-code', 'codex'])
    expect([...HANDOFF_HARNESS_KINDS]).toEqual(['claude-code', 'codex'])
  })

  it('keeps the shipwright eval harness policy on a no-tools / no-no-tools pair', () => {
    expect(SHIPWRIGHT_EVAL_SUPPORTED_HARNESS).toBe('claude-code')
    expect(SHIPWRIGHT_EVAL_UNSUPPORTED_HARNESS).toBe('grok')
    expect(harnessSupportsNoTools(SHIPWRIGHT_EVAL_SUPPORTED_HARNESS)).toBe(true)
    expect(harnessSupportsNoTools(SHIPWRIGHT_EVAL_UNSUPPORTED_HARNESS)).toBe(false)
  })
})
