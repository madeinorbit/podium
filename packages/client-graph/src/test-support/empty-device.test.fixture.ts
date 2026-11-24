/**
 * POD-7544 — THE EMPTY DEVICE: a device that holds only what a real start
 * loads, against a server that holds everything.
 *
 * It is the device fixture (`device.test.fixture.ts`: the real kernel
 * Replica, the real `CollectionLoader`, the real row source and `MobxPool`)
 * with two changes:
 *
 * - The first download is the browser's real policy (the steps of
 *   `apps/server/src/sync/policy.ts`, rebuilt here from the same
 *   declarations), so the device starts with the policy collections and
 *   nothing else. An issue's body records (group `body`: description, brief,
 *   todos, artifacts, deferred items, state line) are not in it.
 * - The world writes an issue the way the real server syncs it: the issue
 *   record without its body fields (`withoutIssueBodies`), and each body as
 *   its own record. A screen sees a body only if it asked for it.
 *
 * The fake server answers only the collection instances the device asked for
 * (with what they come with, as the real route does) and the load recorder
 * keeps every request. `requested()` lists them. A screen that never asks for
 * its data reads empty on this device, where the old fixtures (a pool with
 * every row and no loader, which answers every collection "held") showed it.
 *
 * Use it from a screen test through the web harness
 * (`apps/web/src/test-support/empty-device.ts`), or directly for a view model:
 *
 * ```ts
 * const device = await openEmptyDevice({ world: (server) => putIssueWithBodies(server, 'i1') })
 * const opened = device.observe(() => new MissionScreen(device.pool, 'i1', opts), (s) => s.ready)
 * await device.untilIdle()
 * expect(device.requestedKeys()).toContain('issueDescription.ofIssue{"issueId":"i1"}')
 * ```
 */
import { DESIGN_COLLECTIONS, RECORDS, withoutIssueBodies } from '@podium/model'
import { autorun } from 'mobx'
import type { CollectionServer } from '../../../sync/src/conformance/collection-server'
import type { RecordedLoad } from '../../../sync/src/conformance/load-recorder'
import type { CachePolicy, InstanceRequest } from '../../../sync/src/replica/types'
import { type DeviceOptions, ISSUE, issueValue, openDevice } from './device.test.fixture'

/**
 * The browser's first download, step by step, as the server's policy
 * (`apps/server/src/sync/policy.ts`) declares it: what never grows with
 * history, the bounded windows, live and asking sessions; the visible view;
 * recent work; the sidebar; the issue stubs. No body record is in any step.
 */
export function realStartSteps(): CachePolicy['steps'] {
  const windows = RECORDS.filter((record) => record.group === 'windowed').map(
    (record) => `${record.kind}.window`,
  )
  return [
    {
      step: 'always',
      collections: [
        ...DESIGN_COLLECTIONS.always,
        ...windows,
        ...DESIGN_COLLECTIONS.live,
        ...DESIGN_COLLECTIONS.asking,
      ],
    },
    { step: 'view', collections: [] },
    { step: 'recent', collections: [...DESIGN_COLLECTIONS.recent] },
    { step: 'sidebar', collections: [...DESIGN_COLLECTIONS.sidebar] },
    { step: 'stubs', collections: [...DESIGN_COLLECTIONS.issueStubs] },
  ]
}

/** The record kinds of an issue's body (group `body` in the declarations). */
export const BODY_KINDS = RECORDS.filter((record) => record.group === 'body').map(
  (record) => record.kind,
)

/** The body instance of one kind for one issue: what a screen asks for to show it. */
export const bodyOf = (kind: string, issueId: string): InstanceRequest => ({
  collection: `${kind}.ofIssue`,
  args: { issueId },
  part: 'main',
})

/** The six body fields of an issue, as the server holds them. */
export interface IssueBodies {
  readonly description: string
  readonly brief: string
  readonly todos: readonly { readonly text: string; readonly done: boolean }[]
  readonly artifacts: readonly { readonly path: string; readonly title: string }[]
  readonly deferred: readonly string[]
  readonly stateLine: string
}

/** A body with every field written, each text naming its field. */
export const FULL_BODIES: IssueBodies = {
  description: 'The description the server holds.',
  brief: 'The brief the server holds.',
  todos: [{ text: 'The todo the server holds.', done: false }],
  artifacts: [{ path: 'proof.html', title: 'The artifact the server holds' }],
  deferred: ['The deferred item the server holds.'],
  stateLine: 'The state line the server holds.',
}

/** When the bodies were written: a fixed time, inside every "recent" window. */
const WRITTEN_AT = '2026-11-17T12:00:00.000Z'

/**
 * Write an issue and its six body records on the server, as the server syncs
 * them: the issue record carries no body field, each body is its own record.
 * Recent and open by default, so the issue itself is in the first download.
 */
export function putIssueWithBodies(
  server: CollectionServer,
  id: string,
  fields: Readonly<Record<string, unknown>> = {},
  bodies: IssueBodies = FULL_BODIES,
): void {
  server.put(
    ISSUE,
    id,
    withoutIssueBodies(
      issueValue(id, {
        title: `Task ${id}`,
        updatedAt: WRITTEN_AT,
        // Stored fields every synced issue record carries, which the issue
        // page and the panel draw.
        labels: [],
        deps: [],
        blockedByNotes: [],
        priority: 2,
        type: 'task',
        needsHuman: false,
        defaultAgent: 'claude-code',
        defaultModel: 'auto',
        defaultEffort: 'auto',
        parentBranch: 'main',
        revision: 1,
        ...fields,
      }) as Record<string, unknown>,
    ),
  )
  server.put('issueDescription', id, { id, text: bodies.description })
  server.put('issueBrief', id, { id, text: bodies.brief })
  server.put('issuePanelState', id, { id, text: bodies.stateLine, updatedAt: WRITTEN_AT })
  bodies.todos.forEach((todo, position) => {
    const itemId = `${id}-todo-${position}`
    server.put('issuePanelTodo', itemId, { id: itemId, issueId: id, position, ...todo })
  })
  bodies.artifacts.forEach((artifact, position) => {
    const itemId = `${id}-artifact-${position}`
    server.put('issuePanelArtifact', itemId, {
      id: itemId,
      issueId: id,
      position,
      addedAt: WRITTEN_AT,
      ...artifact,
    })
  })
  bodies.deferred.forEach((text, position) => {
    const itemId = `${id}-deferred-${position}`
    server.put('issuePanelDeferred', itemId, {
      id: itemId,
      issueId: id,
      position,
      text,
      addedAt: WRITTEN_AT,
    })
  })
}

/** One requested instance as a readable key: `collection{args}`. */
export const requestKey = (instance: InstanceRequest): string =>
  `${instance.collection}${instance.args === undefined ? '' : JSON.stringify(instance.args)}`

export type EmptyDevice = Awaited<ReturnType<typeof openEmptyDevice>>

/**
 * Open a device that holds only the real start's policy collections. The
 * first download is done when it returns; `requested()` counts from here.
 */
export async function openEmptyDevice(options: DeviceOptions = {}) {
  const device = await openDevice({
    ...options,
    policy: { steps: realStartSteps(), ...options.policy },
  })
  const firstDownload = device.recorder.loads.length
  /** Every collection fetch after the first download, offline attempts included. */
  const loads = (): readonly RecordedLoad[] =>
    device.recorder.loads.slice(firstDownload).filter((load) => load.route === 'collections')
  return Object.assign(device, {
    /** Every instance the device asked the server for after its first download, in order. */
    requested(): readonly InstanceRequest[] {
      return loads().flatMap((load) => load.instances)
    },
    /** `requested()` as readable keys (`requestKey`). */
    requestedKeys(): readonly string[] {
      return this.requested().map(requestKey)
    },
    /** The requests the device made while offline: refused before the server. */
    refused(): readonly InstanceRequest[] {
      return loads()
        .filter((load) => load.offline)
        .flatMap((load) => load.instances)
    },
    /** Whether the device holds the instance complete (it was asked for and answered). */
    holds(instance: InstanceRequest): boolean {
      return device.loader.isComplete(instance) !== undefined
    },
    /**
     * Run the device until nothing is due: the loader's batch window, each
     * answer and each install. Throws when it never goes quiet (a chain of
     * loads that does not end), so a test cannot read a half-loaded device.
     */
    async untilIdle(): Promise<void> {
      if (!(await device.settle())) throw new Error('the device never went idle')
    },
    /**
     * Open a view model on the device as a screen does: `read` runs inside a
     * reaction, so what it reads is observed (and held) until `close()`.
     */
    observe<T>(make: () => T, read: (model: T) => unknown): { model: T; close(): void } {
      const model = make()
      const stop = autorun(() => {
        read(model)
      })
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        stop()
        ;(model as { close?: () => void } | null)?.close?.()
      }
      device.onDispose(close)
      return { model, close }
    },
  })
}
