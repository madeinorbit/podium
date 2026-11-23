import {
  AgentRuntimeState,
  IssuePanelArtifact,
  LayoutKeyField,
  LayoutSnapshot,
  MessageRecordAttachment,
  MessageRecordWire,
  RepoProjection,
  repoFromWire,
  repoToWire,
  TranscriptItem,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import { encode } from './messages/codec'
import {
  RuntimeAttachmentRef,
  RuntimeAttachmentSource,
  StagedAttachmentRef,
} from './messages/runtime'
import { UpdateGrantMessage } from './messages/update'

// Independent inputs retain the legacy values that a schema-derived golden's
// arm selection can move past. These are compatibility assertions, not samples
// copied back from buildCorpus(). Authorization controls live in the server's
// two-member task/feed and receipt-send.guard tests.
const state = { phase: 'working', since: '2026-11-06T00:00:00Z', nativeSubagentCount: 0 }
const item = { id: 'entry-1', role: 'system', text: 'Harness notice' }
const artifact = { path: 'diagram.png', addedAt: '2026-11-06T00:00:00Z' }
const attachment = {
  id: 'upload-1',
  filename: 'diagram.png',
  mediaType: 'image/png',
  kind: 'image',
}

describe('wire compatibility behind the reviewed golden differences', () => {
  it('keeps legacy state without a compaction origin and retains the interrupted state', () => {
    expect(AgentRuntimeState.parse(state)).toEqual(state)
    const compacting = {
      ...state,
      phase: 'compacting',
      compactingFrom: {
        phase: 'idle',
        awaitingSubagents: false,
        idle: { kind: 'done', summary: '' },
      },
    }
    expect(JSON.parse(encode(AgentRuntimeState.parse(compacting) as never))).toEqual(compacting)
    expect(AgentRuntimeState.safeParse({ ...state, compactingFrom: null }).success).toBe(false)
  })

  it.each([
    'recap',
    'duration',
    'compaction',
    'file-changed',
    'tool-summary',
  ])('preserves transcript systemKind %s without adding summary or compaction fields', (systemKind) => {
    const legacy = { ...item, systemKind }
    expect(TranscriptItem.parse(legacy)).toEqual(legacy)
  })

  it('distinguishes absent summary/compaction data from empty and zero observations', () => {
    expect(TranscriptItem.parse(item)).toEqual(item)
    const observed = {
      ...item,
      summarizes: [],
      compaction: { preTokens: 0, postTokens: 0, idle: false, notice: '' },
    }
    expect(JSON.parse(encode(TranscriptItem.parse(observed) as never))).toEqual(observed)
    expect(TranscriptItem.safeParse({ ...item, summarizes: null }).success).toBe(false)
    expect(TranscriptItem.safeParse({ ...item, compaction: null }).success).toBe(false)
  })

  it('keeps old artifacts and both source kinds without manufacturing upload ownership', () => {
    expect(IssuePanelArtifact.parse(artifact)).toEqual(artifact)
    for (const sourceKind of ['terminal-evidence', 'creation-attachment']) {
      const legacy = { ...artifact, sourceKind }
      expect(IssuePanelArtifact.parse(legacy)).toEqual(legacy)
    }
    const saved = { ...artifact, chatUploadId: 'upload-1', chatUploadOwner: 'mem_alice' }
    expect(JSON.parse(encode(IssuePanelArtifact.parse(saved) as never))).toEqual(saved)
    for (const key of ['chatUploadId', 'chatUploadOwner']) {
      expect(IssuePanelArtifact.safeParse({ ...artifact, [key]: null }).success).toBe(false)
    }
  })

  it('carries a saved-upload id in message metadata while stripping the private staging path', () => {
    const legacy = {
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      kind: attachment.kind,
    }
    expect(MessageRecordAttachment.parse(legacy)).toEqual(legacy)
    expect(
      MessageRecordAttachment.parse({ ...attachment, path: '/private/session/upload.png' }),
    ).toEqual(attachment)
    expect(MessageRecordAttachment.safeParse({ ...legacy, id: null }).success).toBe(false)
  })

  it('keeps the initial-prompt marker absent for old messages and explicit true for the first prompt', () => {
    const legacy = {
      id: 'message-1',
      sessionId: 'session-alice',
      senderUserId: 'mem_alice',
      body: 'Start',
      createdAt: '2026-11-06T00:00:00Z',
      status: 'stored',
    }
    expect(MessageRecordWire.parse(legacy)).toEqual(legacy)
    const first = { ...legacy, initialPrompt: true, attachments: [attachment] }
    expect(JSON.parse(encode(MessageRecordWire.parse(first) as never))).toEqual(first)
    for (const initialPrompt of [false, null]) {
      expect(MessageRecordWire.safeParse({ ...legacy, initialPrompt }).success).toBe(false)
    }
  })

  it('accepts old staged refs and server-held refs, but requires a path at the daemon boundary', () => {
    expect(RuntimeAttachmentRef.parse(attachment)).toEqual(attachment)
    const staged = { ...attachment, path: '/uploads/session-alice/upload-1.png' }
    expect(RuntimeAttachmentRef.parse(staged)).toEqual(staged)
    expect(StagedAttachmentRef.parse(staged)).toEqual(staged)
    expect(StagedAttachmentRef.safeParse(attachment).success).toBe(false)
    expect(RuntimeAttachmentRef.safeParse({ ...attachment, path: null }).success).toBe(false)
  })

  it('leaves a legacy staging request id absent and preserves a supplied UUID', () => {
    const legacy = { dataBase64: 'AA==', filename: 'diagram.png', mediaType: 'image/png' }
    expect(RuntimeAttachmentSource.parse(legacy)).toEqual(legacy)
    const identified = { ...legacy, id: '00000000-0000-4000-8000-000000000000' }
    expect(RuntimeAttachmentSource.parse(identified)).toEqual(identified)
    expect(RuntimeAttachmentSource.safeParse({ ...legacy, id: '../another-session' }).success).toBe(
      false,
    )
    expect(RuntimeAttachmentSource.safeParse({ ...legacy, id: null }).success).toBe(false)
  })

  it('retains dockTab when the deterministic layout sample moves to tips.enabled', () => {
    for (const key of ['dockTab', 'tips.enabled']) expect(LayoutKeyField.parse(key)).toBe(key)
    const personal = { dockTab: 'files', 'tips.enabled': false }
    expect(LayoutSnapshot.parse(personal)).toEqual(personal)
    // Layout values are arbitrary JSON; null is a value, not an absent row.
    expect(LayoutSnapshot.parse({ dockTab: null })).toEqual({ dockTab: null })
    expect(LayoutKeyField.safeParse('podium.dockTab').success).toBe(false)
  })

  it('keeps a missing repo name absent on wire and null in storage, preserving an empty name', () => {
    const legacy = { id: 'repo-1' }
    expect(RepoProjection.parse(legacy)).toEqual(legacy)
    const durable = repoFromWire(RepoProjection.parse(legacy))
    expect(durable.name).toBeNull()
    expect(repoToWire(durable)).toEqual(legacy)
    expect(repoToWire({ ...durable, name: '' })).toEqual({ ...legacy, name: '' })
    expect(RepoProjection.safeParse({ ...legacy, name: null }).success).toBe(false)
  })

  it('keeps old update defaults and distinguishes omitted release context from empty context', () => {
    const legacy = {
      type: 'updateGrant',
      grantId: 'grant-1',
      target: { version: '1.0', artifacts: {} },
    }
    const parsed = UpdateGrantMessage.parse(legacy)
    expect(parsed.target).toEqual({ ...legacy.target, critical: false })
    const context = { releasedAt: '', branch: '', commits: [], commitCount: 0, addedMigrations: [] }
    expect(
      UpdateGrantMessage.parse({ ...legacy, target: { ...legacy.target, ...context } }).target,
    ).toEqual({ ...legacy.target, ...context, critical: false })
    for (const key of Object.keys(context)) {
      expect(
        UpdateGrantMessage.safeParse({ ...legacy, target: { ...legacy.target, [key]: null } })
          .success,
      ).toBe(false)
    }
  })
})
