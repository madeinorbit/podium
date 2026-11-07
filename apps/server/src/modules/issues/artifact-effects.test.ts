/**
 * AN ISSUE'S ARTIFACTS AS EFFECT RECORDS (POD-6420).
 *
 * The old `panelApply` artifact ops create an `issue.artifactAdd`,
 * `issue.artifactPublish` or `issue.artifactRemove` record through the entry
 * point, as their caller, and answer the issue as they always did once it
 * settles. The executor copies the bytes into the server's store under an id
 * keyed by the record, then commits the panel entry through the entry point,
 * which takes the entry from the record, never from the call. The record
 * carries a reference (a path, an upload id), never the bytes.
 *
 * Driven against the real composed server (`makeOracle`); only the daemon's two
 * file RPCs are faked.
 */

import { runsAsArtifactEffect, writesThroughEntry } from '@podium/commands'
import {
  ARTIFACT_UPLOAD_CHUNK_BYTES,
  type ArtifactId,
  asIssueId,
  type IssueId,
  mintDeviceId,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPERATOR } from '../../test-support/capabilities'
import {
  disposeOracles,
  makeOracle as makeBareOracle,
  type Oracle,
} from '../sessions/oracle-support'
import { envelope, submit } from '../sync-write/outbox-test-support'
import { artifactIdOfEffect, ISSUE_ARTIFACT_EFFECT_KIND } from './artifact-effect-record'
import type { ArtifactRpc } from './artifact-store'

afterEach(() => disposeOracles())

const WORKTREE = '/r/.worktrees/art'

/** The daemon's file reads, served from memory, counted. */
function fakeRpc(files: Record<string, Buffer>): ArtifactRpc & { reads: number } {
  const rpc = {
    reads: 0,
    async readAsset(input: { path: string; offset?: number; length?: number }) {
      rpc.reads++
      const buf = files[input.path]
      if (!buf) return { ok: false, error: 'not found' }
      const offset = input.offset ?? 0
      const length = input.length ?? buf.length
      return {
        ok: true,
        dataBase64: buf.subarray(offset, offset + length).toString('base64'),
        size: buf.length,
      }
    },
    async listDir(input: { path?: string; root: string }) {
      return { ok: false, path: input.path ?? input.root, entries: [], error: 'not a directory' }
    },
  }
  return rpc
}

async function setup(files: Record<string, string> = {}) {
  const o = await makeBareOracle()
  await o.store.repos.addRepo('/r', o.store.hostMachineId)
  const rpc = fakeRpc(
    Object.fromEntries(
      Object.entries(files).map(([rel, text]) => [`${WORKTREE}/${rel}`, Buffer.from(text)]),
    ),
  )
  ;(o.reg.modules.issueArtifacts as unknown as { rpc: ArtifactRpc }).rpc = rpc
  const issue = await o.reg.issues.crud.create(o.reg.issues.reports.store.serverWriter, { repoPath: '/r', title: 'art', startNow: false })
  await o.reg.issues.crud.update(o.reg.issues.reports.store.serverWriter, issue.id, { worktreePath: WORKTREE, branch: 'issue/art' })
  return { o, rpc, issueId: issue.id as IssueId }
}

const entries = async (o: Oracle, id: IssueId) =>
  (await o.reg.issues.reports.get(id))?.panel?.artifacts ?? []

const recordsOf = async (o: Oracle, kind: string, id: IssueId) =>
  (await o.store.effects.newestOnTarget(kind, { kind: 'issue', id }, 'succeeded')) ?? undefined

const stored = async (o: Oracle, id: IssueId, artifactId: ArtifactId, file: string) =>
  (await o.reg.modules.issueArtifacts.read(id, artifactId, file))?.bytes.toString() ?? null

describe('artifact-add as an issue.artifactAdd record', () => {
  it('the old route creates the record, copies the bytes, and answers the issue', async () => {
    const { o, issueId } = await setup({ 'shots/a.png': 'PNG-1' })
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')

    const answer = await o.call.issues.panelApply({
      id: issueId,
      op: 'artifact-add',
      path: 'shots/a.png',
      title: 'Shot',
    })

    // Through the entry point: the record's create, then its commit.
    expect(entry.mock.calls.map(([env]) => env.command)).toEqual([
      'effects.create',
      'issues.panelApply',
    ])
    const record = await recordsOf(o, ISSUE_ARTIFACT_EFFECT_KIND.add, issueId)
    expect(record).toMatchObject({ status: 'succeeded', attempts: 1 })
    const artifactId = artifactIdOfEffect(record?.id ?? '')
    expect(answer.panel?.artifacts).toEqual([
      expect.objectContaining({ path: 'shots/a.png', title: 'Shot', artifactId, entry: 'a.png' }),
    ])
    expect(await stored(o, issueId, artifactId, 'a.png')).toBe('PNG-1')
    // A reference on the record, never the bytes.
    expect(record?.input).toEqual({ path: 'shots/a.png', title: 'Shot' })
    expect(JSON.stringify(record)).not.toContain(Buffer.from('PNG-1').toString('base64'))
  })

  it('the in-process MCP surface (the relay pipeline) takes the same record path', async () => {
    const { o, issueId } = await setup({ 'r.md': '# report' })
    const mcp = o.reg.issueCommands.asIssueTrpc(OPERATOR)

    await mcp.issues.panelApply.mutate({ id: issueId, op: 'artifact-add', path: 'r.md' })

    const record = await recordsOf(o, ISSUE_ARTIFACT_EFFECT_KIND.add, issueId)
    expect(record?.status).toBe('succeeded')
    expect(await entries(o, issueId)).toEqual([
      expect.objectContaining({ path: 'r.md', artifactId: artifactIdOfEffect(record?.id ?? '') }),
    ])
  })

  it('a refusal answers with the message it always had, and nothing is added', async () => {
    const { o, issueId } = await setup()

    await expect(
      o.call.issues.panelApply({ id: issueId, op: 'artifact-add', path: '/elsewhere/x.png' }),
    ).rejects.toThrow(/is outside the owning issue worktree/)
    expect(await entries(o, issueId)).toEqual([])

    const bare = await o.reg.issues.crud.create(o.reg.issues.reports.store.serverWriter, { repoPath: '/r', title: 'none', startNow: false })
    await expect(
      o.call.issues.panelApply({ id: bare.id, op: 'artifact-add', path: 'x.png' }),
    ).rejects.toThrow(/has no owning worktree/)
  })

  it('re-adding a path replaces its entry in place and drops the old snapshot', async () => {
    const { o, issueId } = await setup({ 'a.png': 'one', 'b.png': 'two' })
    await o.call.issues.panelApply({ id: issueId, op: 'artifact-add', path: 'a.png', title: 'A' })
    await o.call.issues.panelApply({ id: issueId, op: 'artifact-add', path: 'b.png' })
    const first = (await entries(o, issueId))[0]?.artifactId as ArtifactId

    await o.call.issues.panelApply({ id: issueId, op: 'artifact-add', path: 'a.png' })

    const after = await entries(o, issueId)
    expect(after.map((a) => a.path)).toEqual(['a.png', 'b.png'])
    expect(after[0]?.title).toBe('A')
    expect(after[0]?.artifactId).not.toBe(first)
    expect(await stored(o, issueId, first, 'a.png')).toBeNull()
  })

  it('a second run of the same record finds its entry and pulls nothing', async () => {
    const { o, rpc, issueId } = await setup({ 'a.png': 'one' })
    await o.call.issues.panelApply({ id: issueId, op: 'artifact-add', path: 'a.png' })
    const record = await recordsOf(o, ISSUE_ARTIFACT_EFFECT_KIND.add, issueId)
    const reads = rpc.reads
    const executor = o.reg.modules.effects?.executors.get(ISSUE_ARTIFACT_EFFECT_KIND.add)

    const again = await executor?.run({
      record: { ...record, status: 'running' },
      input: record?.input,
      stage: async () => {},
    } as never)

    expect(again?.status).toBe('succeeded')
    expect(rpc.reads).toBe(reads)
    expect(await entries(o, issueId)).toHaveLength(1)
  })
})

describe('recovering an artifact record the server lost mid-run', () => {
  async function runningRecord(o: Oracle, issueId: IssueId, input: object) {
    const id = mintDeviceId('eff_')
    await submit(
      o,
      envelope(
        'effects.create',
        { id, kind: ISSUE_ARTIFACT_EFFECT_KIND.add, target: { kind: 'issue', id: issueId }, input },
        `mut_${id}`,
      ),
    )
    return id
  }

  it('a snapshot staged but not committed is committed on recovery', async () => {
    const { o, issueId } = await setup({ 'a.png': 'one' })
    const executor = o.reg.modules.effects?.executors.get(ISSUE_ARTIFACT_EFFECT_KIND.add)
    // Stop the record before its own run: the runner picks it up after commit.
    // Held until the oracle stops, then left `running`, as a lost run is.
    vi.spyOn(executor as NonNullable<typeof executor>, 'run').mockImplementation(
      (ctx) =>
        new Promise((resolve) =>
          ctx.stopped.addEventListener('abort', () => resolve({ status: 'running' })),
        ),
    )
    const id = await runningRecord(o, issueId, { path: 'a.png' })
    await vi.waitFor(async () => expect((await o.store.effects.get(id))?.status).toBe('running'))
    // What a run had done when the server stopped: the bytes copied, the entry staged.
    const plan = await o.reg.issues.crud.planArtifactAdd(issueId, { path: 'a.png' })
    const staged = await o.reg.issues.crud.snapshotArtifact(plan, artifactIdOfEffect(id))
    await o.store.effects.setStage(fixtureWriteScope(), id, 'committing', Date.now(), staged)
    const record = await o.store.effects.get(id)

    const outcome = await executor?.recover?.({ record, input: { path: 'a.png' } } as never)

    expect(outcome?.status).toBe('succeeded')
    expect(await entries(o, issueId)).toEqual([
      expect.objectContaining({ path: 'a.png', artifactId: artifactIdOfEffect(id) }),
    ])
  })

  it('nothing staged: failed as interrupted, the partial copy removed, nothing added', async () => {
    const { o, issueId } = await setup({ 'a.png': 'one' })
    const executor = o.reg.modules.effects?.executors.get(ISSUE_ARTIFACT_EFFECT_KIND.add)
    const id = 'eff_lost'
    const plan = await o.reg.issues.crud.planArtifactAdd(issueId, { path: 'a.png' })
    await o.reg.issues.crud.snapshotArtifact(plan, artifactIdOfEffect(id))

    const outcome = await executor?.recover?.({
      record: { id, target: { kind: 'issue', id: issueId }, result: undefined },
      input: { path: 'a.png' },
    } as never)

    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'interrupted' } })
    expect(await stored(o, issueId, artifactIdOfEffect(id), 'a.png')).toBeNull()
    expect(await entries(o, issueId)).toEqual([])
  })
})

describe('a CLI upload published by an issue.artifactPublish record', () => {
  const uploadId = '7b0c4a3e-2d55-4c8e-9a51-0f3c1e2d4b6a'
  const bytes = Buffer.from('report body')

  async function send(o: Oracle, issueId: IssueId, upload: object) {
    return await o.call.issues.panelApply({
      id: issueId,
      op: 'artifact-upload',
      upload: upload as never,
    })
  }

  it('the byte packets stage privately; the commit publishes through a record', async () => {
    const { o, issueId } = await setup()
    await send(o, issueId, {
      action: 'begin',
      uploadId,
      path: 'report.md',
      entry: 'report.md',
      files: [{ path: 'report.md', size: bytes.length }],
    })
    await send(o, issueId, {
      action: 'chunk',
      uploadId,
      file: 'report.md',
      offset: 0,
      dataBase64: bytes.toString('base64'),
    })
    // No record for the transport, and nothing on the panel yet.
    expect(
      await o.store.effects.newestOnTarget(
        ISSUE_ARTIFACT_EFFECT_KIND.publish,
        { kind: 'issue', id: issueId },
        'active',
      ),
    ).toBeUndefined()
    expect(await entries(o, issueId)).toEqual([])

    const answer = await send(o, issueId, { action: 'commit', uploadId })

    const record = await recordsOf(o, ISSUE_ARTIFACT_EFFECT_KIND.publish, issueId)
    expect(record?.input).toEqual({ uploadId })
    const artifactId = artifactIdOfEffect(record?.id ?? '')
    expect(answer.panel?.artifacts).toEqual([
      expect.objectContaining({ path: 'report.md', artifactId }),
    ])
    expect(await stored(o, issueId, artifactId, 'report.md')).toBe('report body')
    expect(JSON.stringify(record)).not.toContain(bytes.toString('base64'))
    expect(bytes.length).toBeLessThan(ARTIFACT_UPLOAD_CHUNK_BYTES)
  })

  it('a commit with nothing staged is refused and adds nothing', async () => {
    const { o, issueId } = await setup()
    await expect(send(o, issueId, { action: 'commit', uploadId })).rejects.toThrow(
      /nothing is staged/,
    )
    expect(await entries(o, issueId)).toEqual([])
  })
})

describe('artifact-remove as an issue.artifactRemove record', () => {
  it('removes the entry it named and its snapshot; a bad index is refused as before', async () => {
    const { o, issueId } = await setup({ 'a.png': 'one', 'b.png': 'two' })
    await o.call.issues.panelApply({ id: issueId, op: 'artifact-add', path: 'a.png' })
    await o.call.issues.panelApply({ id: issueId, op: 'artifact-add', path: 'b.png' })
    const a = (await entries(o, issueId))[0]?.artifactId as ArtifactId

    await expect(
      o.call.issues.panelApply({ id: issueId, op: 'artifact-remove', index: 5 }),
    ).rejects.toThrow('no item 5 (list has 2)')
    const answer = await o.call.issues.panelApply({ id: issueId, op: 'artifact-remove', index: 1 })

    expect(answer.panel?.artifacts.map((x) => x.path)).toEqual(['b.png'])
    const record = await recordsOf(o, ISSUE_ARTIFACT_EFFECT_KIND.remove, issueId)
    expect(record?.input).toEqual({ path: 'a.png', artifactId: a })
    expect(await stored(o, issueId, a, 'a.png')).toBeNull()
  })
})

describe("the entry point's artifact commit", () => {
  it('an artifact op without a record is not the entry point to write', async () => {
    const { o, issueId } = await setup()
    const reply = await submit(
      o,
      envelope('issues.panelApply', { id: issueId, op: 'artifact-add', path: 'a.png' }, 'mut_raw'),
    )
    expect(reply).toMatchObject({ outcome: 'rejected', refusal: { kind: 'invalid' } })
  })

  it('a commit naming a record that is not its own running artifact effect is refused', async () => {
    const { o, issueId } = await setup({ 'a.png': 'one' })
    await o.call.issues.panelApply({ id: issueId, op: 'artifact-add', path: 'a.png' })
    const done = await recordsOf(o, ISSUE_ARTIFACT_EFFECT_KIND.add, issueId)
    const other = await o.reg.issues.crud.create(o.reg.issues.reports.store.serverWriter, { repoPath: '/r', title: 'b', startNow: false })

    for (const [mutation, input] of [
      // Settled: no longer running.
      ['mut_settled', { id: issueId, op: 'artifact-add', effectId: done?.id }],
      // Another issue's record.
      ['mut_other', { id: other.id, op: 'artifact-add', effectId: done?.id }],
      // No such record.
      ['mut_none', { id: issueId, op: 'artifact-add', effectId: 'eff_nope' }],
      // An add's record used for a remove.
      ['mut_kind', { id: issueId, op: 'artifact-remove', effectId: done?.id }],
    ] as const) {
      const reply = await submit(o, envelope('issues.panelApply', input, mutation))
      expect(reply.outcome, mutation).toBe('rejected')
    }
    expect(await entries(o, issueId)).toHaveLength(1)
    expect(await entries(o, asIssueId(other.id))).toEqual([])
  })
})

describe('which panelApply calls are written through the entry point', () => {
  it('an artifact op runs as a record on its route; its commit and every other op go through', () => {
    for (const op of ['artifact-add', 'artifact-upload', 'artifact-remove']) {
      expect(runsAsArtifactEffect('panelApply', { op }), op).toBe(true)
      expect(writesThroughEntry('panelApply', { op }), op).toBe(false)
      expect(writesThroughEntry('panelApply', { op, effectId: 'eff_1' }), op).toBe(true)
    }
    expect(writesThroughEntry('panelApply', { op: 'todo-add' })).toBe(true)
    expect(runsAsArtifactEffect('setState', { op: 'artifact-add' })).toBe(false)
  })
})
