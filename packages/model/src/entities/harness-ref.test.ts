import { describe, expect, it } from 'vitest'
import { HARNESS_REF_MAX, HarnessRef, mergeHarnessRefs } from './transcript'

describe("the agent program's own ids for a message (POD-4841)", () => {
  it('keeps every id once, in the order first learned', () => {
    expect(
      mergeHarnessRefs(
        [{ kind: 'codex-turn', id: 't1' }],
        undefined,
        [
          { kind: 'codex-turn', id: 't1' },
          { kind: 'codex-client-message', id: 'msg_1' },
        ],
      ),
    ).toEqual([
      { kind: 'codex-turn', id: 't1' },
      { kind: 'codex-client-message', id: 'msg_1' },
    ])
  })

  it('keeps two ids of one kind: a list only grows, nothing known is replaced', () => {
    expect(
      mergeHarnessRefs([{ kind: 'codex-turn', id: 't1' }], [{ kind: 'codex-turn', id: 't2' }]),
    ).toEqual([
      { kind: 'codex-turn', id: 't1' },
      { kind: 'codex-turn', id: 't2' },
    ])
  })

  it('says nothing for no ids, and drops an entry with an empty kind or id', () => {
    expect(mergeHarnessRefs()).toBeUndefined()
    expect(mergeHarnessRefs([], undefined)).toBeUndefined()
    expect(mergeHarnessRefs([{ kind: '', id: 'x' }, { kind: 'k', id: '' }])).toBeUndefined()
  })

  it('stops at the cap, keeping the first ids', () => {
    const many = Array.from({ length: HARNESS_REF_MAX + 4 }, (_, i) => ({
      kind: 'k',
      id: `id-${i}`,
    }))
    const merged = mergeHarnessRefs(many)
    expect(merged).toHaveLength(HARNESS_REF_MAX)
    expect(merged?.[0]).toEqual({ kind: 'k', id: 'id-0' })
    expect(HarnessRef.safeParse(merged).success).toBe(true)
  })

  it('takes a kind it does not know as data', () => {
    expect(HarnessRef.safeParse([{ kind: 'a-kind-from-a-newer-daemon', id: 'x' }]).success).toBe(
      true,
    )
  })
})
