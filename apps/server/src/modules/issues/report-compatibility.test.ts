import { actorUser, firstAdminMemberId } from '@podium/model'
import { afterEach, expect, it, vi } from 'vitest'
import { resolvePrincipal } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { appRouter } from '../../router'
import { OPERATOR } from '../../test-support/capabilities'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.dispose()
})

async function fixture() {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(registry)
  await registry.sessionStore.repos.addRepo('/report-fixture', registry.sessionStore.hostMachineId)
  const user = firstAdminMemberId()
  const capability = { ...OPERATOR, actorUser: user, onBehalfOf: user }
  const api = appRouter.createCaller({
    registry,
    repos: {} as never,
    superagent: {} as never,
    capability,
    principal: resolvePrincipal(capability, { parentSessionOf: () => undefined }),
  }).issues
  return { registry, api, user }
}

it('keeps requested issue JSON fields on create, update, get, list and tree', async () => {
  const { registry, api } = await fixture()
  const created = await api.create({
    repoPath: '/report-fixture',
    title: 'Report contract fixture',
    description: 'Plain text body',
    type: 'epic',
    startNow: false,
  })
  const child = await api.create({
    repoPath: '/report-fixture',
    title: 'Child fixture',
    parentId: created.id,
    startNow: false,
  })
  await api.addComment({ id: created.id, body: 'Comment fetched separately' })
  const updated = await api.update({
    id: created.id,
    patch: { notes: 'Plain text note', pinned: true },
  })
  const shown = await api.get({ id: created.id })
  const listed = (await api.list({ repoPath: '/report-fixture' })).find(
    (row) => row.id === created.id,
  )
  const required = {
    id: created.id,
    title: 'Report contract fixture',
    description: 'Plain text body',
    repoPath: '/report-fixture',
    displayRef: expect.any(String),
    revision: expect.any(Number),
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    origin: 'human',
    audience: 'human',
    draft: false,
    readAt: null,
    tuckedAt: null,
    commentCount: 1,
    childCount: 1,
    childDoneCount: 0,
    notes: 'Plain text note',
    pinned: true,
    deps: [],
    dependents: [{ id: child.id, type: 'parent-child' }],
    ready: true,
    blocked: false,
    deferred: false,
  }
  for (const result of [updated, shown, listed]) {
    const json = JSON.parse(JSON.stringify(result))
    expect(json).toMatchObject(required)
    for (const key of [
      'owner',
      'visibility',
      'createdBy',
      'lastLifecycleActor',
      'asked',
      'intentOrigin',
      'isDraftVessel',
    ]) {
      expect(json).not.toHaveProperty(key)
    }
  }
  expect(created).toMatchObject({
    commentCount: 0,
    childCount: 0,
    pinned: false,
    draft: false,
    origin: 'human',
  })
  const tree = await api.tree({ id: created.id, maxNodes: 1000 })
  expect(tree.root).toMatchObject({
    id: created.id,
    title: created.title,
    description: 'Plain text body',
    closed: false,
    ready: true,
    blocked: false,
    blocksDeps: [],
    sessions: [],
    omittedChildren: 0,
    children: [expect.objectContaining({ id: child.id, children: [] })],
  })
  const snapshot = await registry.modules.sessions.syncChangesSince(null)
  expect(snapshot.kind).toBe('snapshot')
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot')
  expect(snapshot.issues).toEqual([])
  expect(snapshot.issueProjections?.find((row) => row.id === created.id)?.description).toEqual({
    value: 'Plain text body',
  })
})

it('records the authenticated asking user without inventing a session delivery address', async () => {
  const { registry, api, user } = await fixture()
  const issue = await api.create({
    repoPath: '/report-fixture',
    title: 'Question fixture',
    startNow: false,
  })
  const report = await api.setNeedsHuman({
    id: issue.id,
    question: 'Which option?',
    options: ['One', 'Two'],
  })
  expect(report).toMatchObject({
    needsHuman: true,
    humanQuestion: 'Which option?',
    humanQuestionOptions: ['One', 'Two'],
  })
  expect(report.humanQuestionAskedBy).toBeUndefined()
  const row = await registry.sessionStore.issues.getIssue(issue.id)
  expect(row?.humanQuestionAttribution).toEqual({ actor: actorUser(user), onBehalfOf: user })
  const snapshot = await registry.modules.sessions.syncChangesSince(null)
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot')
  expect(snapshot.issueProjections?.find((row) => row.id === issue.id)?.asked).toMatchObject({
    question: 'Which option?',
    attribution: { actor: actorUser(user), onBehalfOf: user },
  })
})

it('joins an issue list once per request and never counts comments per issue', async () => {
  const { registry, api } = await fixture()
  for (let index = 0; index < 12; index++) {
    await api.create({
      repoPath: '/report-fixture',
      title: `Report fixture ${index}`,
      startNow: false,
    })
  }
  const repository = registry.sessionStore.issues
  const deps = vi.spyOn(repository, 'listAllIssueDeps')
  const labels = vi.spyOn(repository, 'listIssueLabelsByIssue')
  const counts = vi.spyOn(repository, 'countIssueCommentsByIssue')
  const scalar = vi.spyOn(repository, 'countIssueComments')
  try {
    expect(await api.list({ repoPath: '/report-fixture' })).toHaveLength(12)
    expect(deps).toHaveBeenCalledTimes(1)
    expect(labels).toHaveBeenCalledTimes(1)
    expect(counts).toHaveBeenCalledTimes(1)
    expect(scalar).not.toHaveBeenCalled()
  } finally {
    for (const spy of [deps, labels, counts, scalar]) spy.mockRestore()
  }
})

it('reuses only own-row projections while labels, hierarchy, comments and personal state stay fresh', async () => {
  const { registry, api } = await fixture()
  const parent = await api.create({
    repoPath: '/report-fixture',
    title: 'Cached report parent',
    startNow: false,
  })
  const read = async () =>
    (await api.list({ repoPath: '/report-fixture' })).find((row) => row.id === parent.id)!
  expect(await read()).toMatchObject({ labels: [], commentCount: 0, childCount: 0, pinned: false })
  await registry.sessionStore.issues.setIssueLabels(parent.id, ['alpha'])
  expect(await read()).toMatchObject({ labels: ['alpha'] })
  await registry.sessionStore.issues.setIssueLabels(parent.id, ['beta'])
  await api.addComment({ id: parent.id, body: 'Fresh comment count' })
  const child = await api.create({
    repoPath: '/report-fixture',
    title: 'Fresh child count',
    parentId: parent.id,
    startNow: false,
  })
  await api.update({ id: parent.id, patch: { pinned: true, title: 'Changed report parent' } })
  expect(await read()).toMatchObject({
    title: 'Changed report parent',
    labels: ['beta'],
    commentCount: 1,
    childCount: 1,
    childDoneCount: 0,
    pinned: true,
  })
  await api.close({ id: child.id })
  expect(await read()).toMatchObject({ childCount: 1, childDoneCount: 1 })
  const labels = vi.spyOn(registry.sessionStore.issues, 'listIssueLabelsByIssue')
  const counts = vi.spyOn(registry.sessionStore.issues, 'countIssueCommentsByIssue')
  try {
    expect((await api.tree({ id: parent.id, maxNodes: 1000 })).totalNodes).toBe(2)
    expect(labels).not.toHaveBeenCalled()
    expect(counts).not.toHaveBeenCalled()
  } finally {
    labels.mockRestore()
    counts.mockRestore()
  }
})
