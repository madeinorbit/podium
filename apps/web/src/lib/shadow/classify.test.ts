import { describe, expect, it } from 'vitest'
import {
  classifyKey,
  classifySample,
  contentDigest,
  type DivergenceClass,
  isDivergence,
  type Snapshot,
  snapshotKey,
} from './classify'

const snap = (entries: Record<string, { digest: string; revision?: number }>): Snapshot =>
  new Map(Object.entries(entries))

const only = (key: string, digest = 'd', revision?: number) => snap({ [key]: { digest, revision } })
const none: Snapshot = new Map()

const K = 'issue:i1'

function classify(
  parts: { kernel?: Snapshot; legacy?: Snapshot; authority?: Snapshot; scoped?: boolean } = {},
): DivergenceClass {
  return classifyKey(K, {
    kernel: parts.kernel ?? none,
    legacy: parts.legacy ?? none,
    authority: parts.authority ?? none,
    authorityScoped: parts.scoped ?? false,
  }).class
}

describe('the §2.2 classification table', () => {
  it('agree: all three hold it, digests and revisions equal', () => {
    expect(
      classify({ kernel: only(K, 'x', 3), legacy: only(K, 'x', 3), authority: only(K, 'x', 3) }),
    ).toBe('agree')
  })

  it('scoped-out: in L, not in K, and the AUTHORITY affirms it is outside the slice', () => {
    expect(classify({ legacy: only(K) })).toBe('scoped-out')
  })

  it('kernel-leak: the kernel path holds a row the Authority does not', () => {
    expect(classify({ kernel: only(K), legacy: only(K) })).toBe('kernel-leak')
    expect(classify({ kernel: only(K) })).toBe('kernel-leak')
  })

  it('kernel-missing: the Authority has it and the kernel path lost it', () => {
    expect(classify({ authority: only(K), legacy: only(K) })).toBe('kernel-missing')
  })

  it('legacy-leak: against a SCOPED authority, a row L holds and A does not', () => {
    expect(classify({ legacy: only(K), scoped: true })).toBe('legacy-leak')
    // …and the same shape against an unscoped authority is the benign one.
    expect(classify({ legacy: only(K), scoped: false })).toBe('scoped-out')
  })

  it('content-drift beats revision-drift when both differ', () => {
    expect(
      classify({ kernel: only(K, 'a', 1), legacy: only(K, 'b', 2), authority: only(K, 'a', 1) }),
    ).toBe('content-drift')
  })

  it('revision-drift: same content, different revision', () => {
    expect(
      classify({ kernel: only(K, 'a', 1), legacy: only(K, 'a', 2), authority: only(K, 'a', 1) }),
    ).toBe('revision-drift')
  })

  it('unclassified is REACHABLE and fails — the legacy path missing an entitled row', () => {
    // K and A hold it, L does not. §2.2 has no row for this, and the basis
    // document says such a case is reported as a hole in the table rather than
    // being quietly given a class here.
    const verdict = classify({ kernel: only(K), authority: only(K) })
    expect(verdict).toBe('unclassified')
    expect(isDivergence(verdict)).toBe(true)
  })

  it('every class except agree and scoped-out fails the gate', () => {
    const classes: DivergenceClass[] = [
      'agree',
      'scoped-out',
      'kernel-leak',
      'legacy-leak',
      'kernel-missing',
      'content-drift',
      'revision-drift',
      'unclassified',
    ]
    expect(classes.filter((c) => !isDivergence(c))).toEqual(['agree', 'scoped-out'])
  })
})

describe('classifySample', () => {
  it('classifies every key in K ∪ L ∪ A, not the intersection', () => {
    const sample = classifySample({
      kernel: snap({ 'issue:a': { digest: '1' }, 'issue:leak': { digest: '2' } }),
      legacy: snap({ 'issue:a': { digest: '1' }, 'session:old': { digest: '3' } }),
      authority: snap({ 'issue:a': { digest: '1' }, 'issue:lost': { digest: '4' } }),
      authorityScoped: false,
    })
    expect(sample.classifications.map((c) => c.key)).toEqual([
      'issue:a',
      'issue:leak',
      'issue:lost',
      'session:old',
    ])
    expect(sample.counts).toMatchObject({
      agree: 1,
      'kernel-leak': 1,
      'kernel-missing': 1,
      'scoped-out': 1,
    })
    expect(sample.divergences.map((d) => d.class).sort()).toEqual(['kernel-leak', 'kernel-missing'])
  })

  it('a clean sample has no divergences', () => {
    const rows = snap({ 'issue:a': { digest: '1', revision: 1 } })
    const sample = classifySample({
      kernel: rows,
      legacy: rows,
      authority: rows,
      authorityScoped: false,
    })
    expect(sample.divergences).toEqual([])
    expect(sample.counts.agree).toBe(1)
  })
})

describe('the content digest', () => {
  it('is insensitive to key ORDER — two paths built the row from different sources', () => {
    expect(contentDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(
      contentDigest({ b: { d: 3, c: 2 }, a: 1 }),
    )
  })

  it('still distinguishes different VALUES, including nested and array order', () => {
    expect(contentDigest({ a: 1 })).not.toBe(contentDigest({ a: 2 }))
    expect(contentDigest({ a: [1, 2] })).not.toBe(contentDigest({ a: [2, 1] }))
    expect(contentDigest({ a: { b: 1 } })).not.toBe(contentDigest({ a: { b: '1' } }))
  })

  it('excludes store bookkeeping — the legacy row carries TanStack `$` fields', () => {
    // The first live two-connection run reported content-drift on every row for
    // exactly this reason: `$collectionId` embeds a per-instance nonce, so it
    // can never agree between two replicas.
    expect(
      contentDigest({
        sessionId: 's1',
        name: 'One',
        $collectionId: 'podium.shadow-legacy.sessions#4',
        $key: 's1',
        $origin: 'local',
        $synced: false,
      }),
    ).toBe(contentDigest({ sessionId: 's1', name: 'One' }))
    // …and it does NOT swallow a real difference beside them.
    expect(contentDigest({ sessionId: 's1', name: 'One', $key: 's1' })).not.toBe(
      contentDigest({ sessionId: 's1', name: 'Two' }),
    )
  })

  it('treats an absent field and an explicitly undefined one as the same row', () => {
    expect(contentDigest({ a: 1, b: undefined })).toBe(contentDigest({ a: 1 }))
  })

  it('keys are `entity:entityId`', () => {
    expect(snapshotKey('issue', 'i1')).toBe('issue:i1')
  })
})
