/**
 * The envelope's two obligations, as tests rather than comments.
 *
 * 1. It carries DELIVERY facts and nothing else — the placement rule (ADR 4
 *    Amendment 1 D9.4). This is the test that fires if a future issue "just
 *    adds owner to the envelope while it's open".
 * 2. Read sites work on BOTH carriers, so POD-308 can nest the wire without
 *    touching the UI.
 */

import { IssueWire, IssueWireEntity, SessionMeta, SessionMetaEntity } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  entityOf,
  FLAT_PROVENANCE_KEYS,
  isPendingSync,
  isUpstreamStale,
  isViaHub,
  provenanceOf,
  ReplicatedProvenance,
  replicatedEnvelope,
  toEnvelope,
} from './envelope'

describe('the placement rule: replica provenance, not authorship', () => {
  it('carries exactly the three delivery flags', () => {
    expect(Object.keys(ReplicatedProvenance.shape).sort()).toEqual([
      'pendingSync',
      'upstreamStale',
      'viaHub',
    ])
  })

  it('does NOT carry owner, visibility, actor or on-behalf-of', () => {
    // These are authoritative facts about the ROW: they must survive bootstrap,
    // export and re-replication. An envelope field is droppable at a boundary,
    // and an authorization input that can be dropped fails OPEN.
    //
    // The counterfactual is the assertion above: the envelope is not simply
    // empty — it has three keys, and these four are excluded from them.
    const keys = Object.keys(ReplicatedProvenance.shape)
    for (const forbidden of ['owner', 'visibility', 'actor', 'onBehalfOf', 'grants']) {
      expect(keys, `${forbidden} must not live on the envelope`).not.toContain(forbidden)
    }
  })

  it('leaves server-authoritative needs-human attribution on the ENTITY', () => {
    // The placement decision POD-304 inherited, made and pinned: askedBy /
    // askedAt are attribution, so they stay entity data. The entity schema is
    // the one that must carry them — and it does, provenance-free.
    const entityKeys = Object.keys(IssueWireEntity.shape)
    expect(entityKeys).toContain('humanQuestionAskedBy')
    expect(entityKeys).toContain('humanQuestionAskedAt')
    expect(Object.keys(ReplicatedProvenance.shape)).not.toContain('humanQuestionAskedBy')
  })

  it('keeps the entity schemas provenance-free', () => {
    for (const key of FLAT_PROVENANCE_KEYS) {
      expect(Object.keys(SessionMetaEntity.shape), `SessionMetaEntity carries ${key}`).not.toContain(
        key,
      )
      expect(Object.keys(IssueWireEntity.shape), `IssueWireEntity carries ${key}`).not.toContain(key)
    }
    // The counterfactual: today's WIRE projections still carry them flat, which
    // is what keeps the golden fixtures byte-identical until POD-308.
    expect(Object.keys(SessionMeta.shape)).toContain('viaHub')
    expect(Object.keys(IssueWire.shape)).toContain('pendingSync')
  })

  it('declares the flags once, so the two entities cannot drift apart', () => {
    // SessionMeta has never carried pendingSync; both encodings are picks of
    // ONE group, so the meanings stay identical even though the shapes differ.
    expect(Object.keys(SessionMeta.shape)).not.toContain('pendingSync')
    expect(Object.keys(IssueWire.shape)).toContain('upstreamStale')
  })
})

describe('read accessors work on both carriers', () => {
  const flat = { sessionId: 's1', viaHub: true, upstreamStale: true }
  const nested = { entity: { sessionId: 's1' }, provenance: { viaHub: true, upstreamStale: true } }

  it('reads provenance off a flat row', () => {
    expect(provenanceOf(flat)).toEqual({ viaHub: true, upstreamStale: true })
    expect(isViaHub(flat)).toBe(true)
    expect(isUpstreamStale(flat)).toBe(true)
    expect(isPendingSync(flat)).toBe(false)
  })

  it('reads the same provenance off a nested row', () => {
    expect(provenanceOf(nested)).toEqual(provenanceOf(flat))
    expect(isViaHub(nested)).toBe(true)
    expect(entityOf(nested)).toEqual({ sessionId: 's1' })
  })

  it('reports a local row as neither via-hub nor stale', () => {
    const local = { sessionId: 's2' }
    expect(provenanceOf(local)).toEqual({})
    expect(isViaHub(local)).toBe(false)
    expect(isUpstreamStale(local)).toBe(false)
  })

  it('ignores non-boolean junk rather than treating it as true', () => {
    // A peer that sends `viaHub: "yes"` must not make a row read as hub-mirrored.
    expect(isViaHub({ viaHub: 'yes' } as unknown as object)).toBe(false)
    expect(provenanceOf({ viaHub: 1 } as unknown as object)).toEqual({})
  })

  it('splits a flat row into the nested shape POD-308 will carry', () => {
    const split = toEnvelope(flat)
    expect(split.provenance).toEqual({ viaHub: true, upstreamStale: true })
    expect(split.entity).toEqual({ sessionId: 's1' })
    // And the entity half really has lost the flags, not merely hidden them.
    for (const key of FLAT_PROVENANCE_KEYS) {
      expect(Object.keys(split.entity as object)).not.toContain(key)
    }
  })

  it('is idempotent on an already-nested row', () => {
    expect(toEnvelope(nested)).toBe(nested)
  })

  it('builds a parseable envelope schema over any entity', () => {
    // A minimal entity on purpose: the builder must be generic over the entity,
    // not coupled to one aggregate's required-field list.
    const schema = replicatedEnvelope(z.object({ sessionId: z.string() }))
    const parsed = schema.parse({ entity: { sessionId: 's1' }, provenance: { viaHub: true } })
    expect(isViaHub(parsed)).toBe(true)
    expect(Object.keys(parsed.entity)).not.toContain('viaHub')
  })
})
