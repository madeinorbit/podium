import { act, renderHook } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { useWorkflowEditDraft } from './use-workflow-edit-draft'

const first = { revisionId: 'rev-1', instructions: 'Original', steps: '[]' }
const next = { revisionId: 'rev-2', instructions: 'Someone else', steps: '[\n  "new step"\n]' }

// The editor's previous buffers, retained as an independent comparison on the
// same revision fixtures before replacing the effect in WorkflowLibrary.
function useLegacyBuffers(head: typeof first) {
  const [instructions, setInstructions] = useState(head.instructions)
  const [steps, setSteps] = useState(head.steps)
  useEffect(() => {
    setInstructions(head.instructions)
    setSteps(head.steps)
    // biome-ignore lint/correctness/useExhaustiveDependencies: the original revision-id effect.
  }, [head.revisionId])
  return { instructions, steps, setInstructions, setSteps }
}

describe('revision draft compared with the previous editor', () => {
  it('matches the old answer when a clean editor follows a new head', () => {
    const { result, rerender } = renderHook((head) => ({
      old: useLegacyBuffers(head),
      next: useWorkflowEditDraft(head),
    }), { initialProps: first })
    rerender(next)
    expect(result.current.next.instructions).toBe(result.current.old.instructions)
    expect(result.current.next.steps).toBe(result.current.old.steps)
    expect(result.current.next.hasNewVersion).toBe(false)
  })

  it('matches the old answer for a same-revision refresh while typing', () => {
    const { result, rerender } = renderHook((head) => ({
      old: useLegacyBuffers(head),
      next: useWorkflowEditDraft(head),
    }), { initialProps: first })
    act(() => {
      result.current.old.setInstructions('Mine')
      result.current.next.setInstructions('Mine')
      result.current.old.setSteps('["mine"]')
      result.current.next.setSteps('["mine"]')
    })
    rerender({ ...first })
    expect(result.current.next.instructions).toBe(result.current.old.instructions)
    expect(result.current.next.steps).toBe(result.current.old.steps)
    expect(result.current.next.hasNewVersion).toBe(false)
  })

  it('preserves both texts where the old answer silently replaces them', () => {
    const { result, rerender } = renderHook((head) => ({
      old: useLegacyBuffers(head),
      next: useWorkflowEditDraft(head),
    }), { initialProps: first })
    act(() => {
      result.current.old.setInstructions('Mine')
      result.current.next.setInstructions('Mine')
      result.current.old.setSteps('["mine"]')
      result.current.next.setSteps('["mine"]')
    })
    rerender(next)
    expect(result.current.old.instructions).toBe(next.instructions)
    expect(result.current.old.steps).toBe(next.steps)
    expect(result.current.next.instructions).toBe('Mine')
    expect(result.current.next.steps).toBe('["mine"]')
    expect(result.current.next.hasNewVersion).toBe(true)
  })
})

describe('revision draft', () => {
  it('follows the new head after edits are reverted to the base', () => {
    const { result, rerender } = renderHook(useWorkflowEditDraft, { initialProps: first })
    act(() => result.current.setInstructions('Mine'))
    rerender(next)
    act(() => result.current.setInstructions(first.instructions))
    expect(result.current.instructions).toBe(next.instructions)
    expect(result.current.steps).toBe(next.steps)
    expect(result.current.hasNewVersion).toBe(false)
  })

  it('keeps typing during a save against the acknowledged revision', () => {
    const { result, rerender } = renderHook(useWorkflowEditDraft, { initialProps: first })
    act(() => result.current.setInstructions('Submitted'))
    act(() => result.current.setInstructions('More typing'))
    rerender({ ...first, revisionId: 'rev-mine', instructions: 'Submitted' })
    act(() => result.current.saved({ instructions: 'Submitted', steps: '[]' }))
    expect(result.current.instructions).toBe('More typing')
    expect(result.current.hasNewVersion).toBe(false)
    rerender(next)
    expect(result.current.instructions).toBe('More typing')
    expect(result.current.hasNewVersion).toBe(true)
  })

  it('waits for the saved head when the acknowledgement arrives first', () => {
    const { result, rerender } = renderHook(useWorkflowEditDraft, { initialProps: first })
    act(() => result.current.setInstructions('Mine'))
    rerender(next)
    act(() => result.current.saved({ instructions: 'Mine', steps: '[]' }))
    expect(result.current.instructions).toBe('Mine')
    expect(result.current.hasNewVersion).toBe(true)
    rerender({ ...first, revisionId: 'rev-mine', instructions: 'Mine' })
    expect(result.current.instructions).toBe('Mine')
    expect(result.current.hasNewVersion).toBe(false)
  })
})
