/**
 * POD-7544 — SCREENS ON AN EMPTY DEVICE.
 *
 * Mount a web screen on a device that holds only what a real start loads
 * (`packages/client-graph/src/test-support/empty-device.test.fixture.ts`: the
 * real `MobxPool`, `CollectionLoader` and kernel Replica over a fake server
 * that holds every record and answers only the instances that were asked
 * for). The screen reads the device's pool through the app's pool hooks, so
 * a screen that never asks for its data shows nothing here, as it does in
 * the app. The old fixtures (every row in the pool, no loader) hid that: a
 * pool without a loader answers every collection "held".
 *
 * A test file wires the app's hooks to the device with three mocks, then
 * mounts:
 *
 * ```ts
 * vi.mock('@/app/store-worklist-pool', async () =>
 *   (await import('@/test-support/empty-device')).emptyDevicePoolHooks)
 * vi.mock('@podium/client-core/react', async (original) =>
 *   (await import('@/test-support/empty-device')).emptyDeviceCoreHooks(await original()))
 *
 * const screen = await mountOnEmptyDevice(<IssuePanelView cwd="/r" issueId="i1" />, {
 *   world: (server) => putIssueWithBodies(server, 'i1'),
 * })
 * expect(screen.requestedKeys()).toContain('issueDescription.ofIssue{"issueId":"i1"}')
 * ```
 *
 * `untilIdle()` runs the device until its loader has nothing due (inside
 * `act`), `requested()` lists the instances the screen asked the server for,
 * `offline()` cuts the connection, and `commands` records every command the
 * screen sent (`updateIssue`, …) without sending it anywhere.
 */
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import type { MobxPool } from '@podium/client-graph'
import type { MemberRosterAnswer } from '@podium/client-graph/member-roster'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { act, cleanup, type RenderResult, render } from '@testing-library/react'
import { type ReactElement, useMemo, useSyncExternalStore } from 'react'
import { afterEach, vi } from 'vitest'
import type { DeviceOptions } from '../../../../packages/client-graph/src/test-support/device.test.fixture'
import {
  type EmptyDevice,
  openEmptyDevice,
} from '../../../../packages/client-graph/src/test-support/empty-device.test.fixture'

export {
  BODY_KINDS,
  bodyOf,
  FULL_BODIES,
  type IssueBodies,
  openEmptyDevice,
  putIssueWithBodies,
  requestKey,
} from '../../../../packages/client-graph/src/test-support/empty-device.test.fixture'

/** The device the mounted screen reads; one at a time. */
let current: EmptyDevice | null = null

/** Every request client call a screen made: `issues.comments.query`, … with its input. */
export interface RequestCall {
  readonly path: string
  readonly input: unknown
}

/**
 * A test's own answer to a request client call, as the server would give it:
 * a value, or a thrown error (a refusal). `undefined` leaves the default.
 */
export type RequestAnswer = (path: string, input: unknown) => unknown

/**
 * A request client that answers every query with an empty list and every
 * mutation with an empty object, and records each call. The screens under
 * test read their record data from the pool; what they fetch on the side
 * (comments, history) is not what these tests are about. A test that is
 * about one call answers it through `answers` (`mountOnEmptyDevice`'s
 * `answer` option).
 */
function recordingRequestClient(
  calls: RequestCall[],
  answers: { current: RequestAnswer | undefined },
): unknown {
  const at = (path: readonly string[]): unknown =>
    new Proxy(() => {}, {
      get: (_target, key) => (typeof key === 'string' ? at([...path, key]) : undefined),
      apply: (_target, _this, args: unknown[]) => {
        const verb = path.at(-1)
        const name = path.join('.')
        calls.push({ path: name, input: args[0] })
        try {
          const answered = answers.current?.(name, args[0])
          if (answered !== undefined) return Promise.resolve(answered)
        } catch (error) {
          return Promise.reject(error)
        }
        return Promise.resolve(verb === 'query' ? [] : {})
      },
    })
  return at([])
}

/**
 * The store fields the client-core hooks read (`useCommands`, `useUiValue`,
 * `useRequestClient`): every command and setter is a spy, so a test can read
 * what the screen sent. `updateIssue` is the issue edit command.
 */
function screenState() {
  const requests: RequestCall[] = []
  const answers: { current: RequestAnswer | undefined } = { current: undefined }
  return {
    requests,
    answers,
    /** Every URL the screen fetched outside the request client. */
    fetched: [] as string[],
    trpc: recordingRequestClient(requests, answers),
    httpOrigin: '',
    issues: [] as unknown[],
    sessions: [] as unknown[],
    repos: [] as unknown[],
    machines: [] as unknown[],
    selectedIssueId: null as string | null,
    uiState: {
      get: (_key: string): string | null => null,
      set: vi.fn(),
      subscribe: () => () => {},
    },
    updateIssue: vi.fn(async (_id: string, _patch: Record<string, unknown>) => ({})),
    closeIssue: vi.fn(async () => ({})),
    deleteIssue: vi.fn(async () => ({})),
    deferIssue: vi.fn(async () => ({})),
    undeferIssue: vi.fn(async () => ({})),
    restoreIssue: vi.fn(async () => ({})),
    setIssueLabels: vi.fn(async () => ({})),
    setPinned: vi.fn(async () => ({})),
    startIssueSession: vi.fn(async () => ({})),
    issueAction: vi.fn(async () => 'effect'),
    markIssueRead: vi.fn(),
    markIssueUnread: vi.fn(),
    markSessionRead: vi.fn(),
    setPane: vi.fn(),
    setView: vi.fn(),
    setSelectedIssueId: vi.fn(),
    setOpenIssueId: vi.fn(),
    navigateToSession: vi.fn(),
    openArtifact: vi.fn(),
    openFileInWorktree: vi.fn(),
    renameSession: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}),
  }
}

let state = screenState()
const owner = withKeyedInputs({ getSnapshot: () => state, subscribe: () => () => {} })

/** The pool hooks of `@/app/store-worklist-pool`, reading the mounted device. */
export const emptyDevicePoolHooks = {
  useWorklistPool(): MobxPool | null {
    return current?.pool ?? null
  },
  useWorklistPoolProjection<T>(read: (pool: MobxPool) => T, empty: T): T {
    const pool = current?.pool ?? null
    const projection = useMemo(() => (pool ? createPoolProjection(pool, read) : null), [read, pool])
    return useSyncExternalStore(
      projection?.subscribe ?? (() => () => {}),
      projection?.getSnapshot ?? (() => empty),
    )
  },
}

/** `@podium/client-core/react` with its runtime and UI hooks bound to the screen state. */
export async function emptyDeviceCoreHooks<T extends object>(actual: T) {
  const { fixtureRuntimeHooks } = await import('@podium/client-core/test-support/command-hooks')
  const { fixtureUiHooks } = await import('@podium/client-core/test-support/react')
  return {
    ...actual,
    ...fixtureRuntimeHooks(() => owner),
    ...fixtureUiHooks(() => owner),
    useHarnessDescriptors: () => ({ served: [] }),
  }
}

/** The commands and setters a screen can call, each a spy. */
export type ScreenState = ReturnType<typeof screenState>
/** One instance the device can ask for. */
type Instance = Parameters<EmptyDevice['holds']>[0]

/** A screen mounted on an empty device. */
export interface MountedScreen {
  readonly device: EmptyDevice
  readonly view: RenderResult
  readonly pool: MobxPool
  /** The commands the screen sent, by name: `commands.updateIssue.mock.calls`, … */
  readonly commands: ScreenState
  /** Every request client call the screen made. */
  readonly requests: readonly RequestCall[]
  /** Every URL the screen fetched outside the request client. */
  readonly fetched: readonly string[]
  /** Every instance the device asked the server for after its first download. */
  requested(): readonly Instance[]
  /** `requested()` as readable keys (`requestKey`). */
  requestedKeys(): readonly string[]
  /** Run the device until its loader has nothing due, and let React draw what it installed. */
  untilIdle(): Promise<void>
  /** Hold an instance by hand, as a screen reader would, and run until it is in. */
  hold(instance: Instance): Promise<void>
  /** Cut the device's connection: loads are refused before the server. */
  offline(): void
  online(): void
}

function mounted(device: EmptyDevice, view: RenderResult): MountedScreen {
  const screen = state
  return {
    device,
    view,
    pool: device.pool,
    commands: screen,
    requests: screen.requests,
    fetched: screen.fetched,
    requested: () => device.requested(),
    requestedKeys: () => device.requestedKeys(),
    async untilIdle(): Promise<void> {
      await act(async () => {
        await device.untilIdle()
      })
    },
    // The control for a screen that does not ask for an instance itself: a
    // reader that holds it until the test ends.
    async hold(instance: Instance): Promise<void> {
      device.observe(
        () => null,
        () => device.pool.collections.held(instance),
      )
      await this.untilIdle()
    },
    offline(): void {
      act(() => device.offline())
    },
    online(): void {
      act(() => device.online())
    },
  }
}

export interface EmptyDeviceScreenOptions extends DeviceOptions {
  /**
   * The member directory (`/auth/members/directory`). Unset, the directory
   * cannot load, which is the one-member answer (`useMemberRoster`).
   */
  readonly members?: MemberRosterAnswer
  /** Answers request client calls as the server would (`RequestAnswer`). */
  readonly answer?: RequestAnswer
}

/**
 * The screen's only network: the member directory when the test names one.
 * Every other fetch fails, as with no server, and is recorded.
 */
function fakeNetwork(fetched: string[], members: MemberRosterAnswer | undefined) {
  return async (input: unknown): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input)
    fetched.push(url)
    if (
      members !== undefined &&
      new URL(url, 'http://device.invalid').pathname === '/auth/members/directory'
    )
      return new Response(JSON.stringify(members), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    throw new TypeError('Failed to fetch (the empty-device harness has no network)')
  }
}

/**
 * Open an empty device with `options.world` on its server, mount `element`
 * on it and run it until idle. The device and the screen are disposed after
 * the test.
 */
export async function mountOnEmptyDevice(
  element: ReactElement,
  options: EmptyDeviceScreenOptions = {},
): Promise<MountedScreen> {
  if (current !== null) throw new Error('one empty device at a time')
  state = screenState()
  state.answers.current = options.answer
  vi.stubGlobal('fetch', fakeNetwork(state.fetched, options.members))
  const device = await openEmptyDevice(options)
  current = device
  let view: RenderResult | undefined
  act(() => {
    view = render(element)
  })
  if (view === undefined) throw new Error('the screen did not render')
  const screen = mounted(device, view)
  await screen.untilIdle()
  return screen
}

afterEach(() => {
  cleanup()
  current?.dispose()
  current = null
  vi.unstubAllGlobals()
})
