/**
 * POD-4445 — boot a real `ClientRuntime` over a fixture corpus for the web
 * entries. Mirrors G3's `startScenarioEngine` (`shared/src/scenarios.ts`) but
 * seeds from the G2 fixture (`buildCorpus(scale)`) instead of the scenario
 * seed: the browser pages measure the same live-shaped corpus the oracle
 * checks, at 1x/2x/4x.
 *
 * The fakes below (hub, router window, API) are the harness's own minimal
 * copies of the scenario shapes — G3's are module-local and the harness must
 * not depend on another issue's internals beyond its exported API
 * (`ScenarioCache` is imported; everything else here is local).
 */

import type { EntityRecord } from '@podium/sync/replica'
import type { PodiumClientApi } from '@podium/client-core/api'
import { createClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import {
  createKernelReplica,
  createSideCache,
  memoryStorage,
} from '@podium/client-core/replica'
import type { SocketHub } from '@podium/client-core/socket-transport'
import type { RouterWindow } from '@podium/client-core/ui-state'
import { asUserId } from '@podium/model'
import { ScenarioCache } from '../../shared/src/scenarios'
import type { FixtureCorpus } from './fixture/index'

export interface EngineBootstrap {
  engine: ReturnType<typeof createClientRuntime>
  replica: ReturnType<typeof createKernelReplica>
  cache: ScenarioCache
  settleMs: number
}

class FakeHub {
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>()
  on(kind: string, cb: (...a: unknown[]) => void): () => void {
    let set = this.handlers.get(kind)
    if (!set) {
      set = new Set()
      this.handlers.set(kind, set)
    }
    set.add(cb)
    return () => set.delete(cb)
  }
  connectionHealth() {
    return { status: 'down' as const, rttMs: null, since: 0 }
  }
  seedMetadata(): void {}
  connect(): void {}
  connectNow(): void {}
  dispose(): void {}
  setVisible(): void {}
  setViewState(): void {}
  sendSessionDraft(): void {}
  sendDraftEdit(): boolean {
    return true
  }
}

function fakeRouterWindow(): RouterWindow {
  const listeners = new Set<() => void>()
  return {
    location: { pathname: '/', search: '' },
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: (_t: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_t: string, cb: () => void) => listeners.delete(cb),
  } as unknown as RouterWindow
}

// biome-ignore lint/suspicious/noExplicitAny: API stub shaped per-test like the scenario one
function stubApi(repos: any[]): any {
  return {
    sync: {
      changesSince: {
        query: async () => ({
          kind: 'snapshot',
          sessions: [],
          issues: [],
          conversations: [],
          diagnostics: [],
          cursor: 0,
        }),
      },
    },
    discovery: {
      refreshRepos: {
        mutate: async () => ({ repositories: repos, diagnostics: [], machines: [] }),
      },
    },
    pins: { list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) } },
    tabs: { listOrders: { query: async () => ({}) } },
    settings: {
      get: {
        query: async () => ({ sidebar: { repoSort: 'lastUsed', repoOrder: [] } }),
      },
    },
    superagent: { listThreads: { query: async () => [] } },
    sessions: { markRead: { mutate: async () => ({}) } },
    issues: { markRead: { mutate: async () => ({}) } },
  }
}

/** Install the fixture rows as kernel entities, in bulk. */
export function seedCacheFromCorpus(corpus: FixtureCorpus): ScenarioCache {
  const cache = new ScenarioCache()
  const rows: { entity: string; entityId: string; value: unknown }[] = []
  for (const issue of corpus.issues) rows.push({ entity: 'issue', entityId: issue.id, value: issue })
  for (const projection of corpus.issueProjections)
    rows.push({ entity: 'issueProjection', entityId: projection.id, value: projection })
  for (const session of corpus.sessions)
    rows.push({ entity: 'session', entityId: session.sessionId, value: session })
  for (const repo of corpus.repoProjections)
    rows.push({ entity: 'repos', entityId: repo.id, value: repo })
  for (const dep of corpus.issueDeps)
    rows.push({ entity: 'issueDep', entityId: dep.id, value: dep })
  cache.install(rows)
  return cache
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Boot the runtime over the corpus and publish the seeded rows as ONE
 * addressed bootstrap — the same install the scenario engines perform, so
 * the page's row stream sees a single `replace` at mount.
 */
export async function startEngineFromCorpus(corpus: FixtureCorpus): Promise<EngineBootstrap> {
  const cache = seedCacheFromCorpus(corpus)
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  const engine = createClientRuntime({
    principal: asClientPrincipal(asUserId('operator')),
    config: { httpOrigin: 'http://x', wsClientUrl: 'ws://x' },
    api: stubApi(corpus.repos) as PodiumClientApi,
    onFatalError: (message) => {
      throw new Error(message)
    },
    createReplicaFn: () => replica,
    routerWindow: fakeRouterWindow(),
    createHub: () => new FakeHub() as unknown as SocketHub,
  })
  engine.start()
  const settleMs = corpus.issues.length > 1000 ? 600 : 60
  await settle(settleMs)
  replica.onKernelEvent({
    type: 'bootstrap-installed',
    cause: 'cold-start',
    snapshotSeq: 1,
    entityCount: (cache.records as EntityRecord[]).length,
    bufferedFramesApplied: 0,
  } as never)
  await settle(settleMs)
  return { engine, replica, cache, settleMs }
}
