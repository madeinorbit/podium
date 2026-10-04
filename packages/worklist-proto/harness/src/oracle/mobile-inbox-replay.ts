/** Read-only ludovico replay. The export stays in memory. Only counts and
 * numeric field positions are emitted, including on failure. */
import { hostname } from 'node:os'
import { dedupeSessions, withKeyedInputs } from '@podium/client-core/engine'
import {
  allIssueViewModels,
  createKernelReplica,
  createSideCache,
  memoryStorage,
} from '@podium/client-core/replica'
import { sessionViews } from '@podium/client-core/session-values'
import { createWorklistPool } from '@podium/client-graph/create'
import {
  checkMobileInbox,
  MOBILE_CARD_FIELDS,
} from '@podium/client-graph/diagnostics/mobile-inbox-check'
import {
  MOBILE_INBOX_ENTITIES,
  MOBILE_INBOX_SOURCE_KEY,
  MOBILE_INBOX_SUMMARIES,
  MOBILE_INBOX_VIEW_KEY,
} from '@podium/client-graph/mobile-inbox-schema'
import { MobileInboxSource } from '@podium/client-graph/mobile-inbox-source'
import { createMobileInboxViews } from '@podium/client-graph/mobile-inbox-views'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { sessionUserStateRowId } from '@podium/model'
import type { PodiumTarget } from '@podium/protocol'
import { parseIssueRef, parseSessionRef } from '@podium/protocol'
import { runInAction } from 'mobx'
import { mobilePodiumRoute } from '../../../../../apps/mobile/src/lib/podium-route'
import { buildScreeningQueue } from '../../../../../apps/mobile/src/lib/screening'
import { seedCacheFromCorpus } from '../../../shared/src/scenarios'
import { readLive } from '../fixture/export-snapshot'
import { corpusFromLive } from '../fixture/live-snapshot'
import { sidebarReplayStore } from './sidebar-replay'

async function main() {
  if (hostname() !== 'ludovico' || !process.argv.includes('--live'))
    throw new Error('Local replay only')
  const { raw, sessionHomes, snapshotSeq } = await readLive('http://127.0.0.1:18787')
  const corpus = {
    ...corpusFromLive(raw, Date.now()),
    issueProjections: raw.issueProjections,
    issueUserStates: raw.issueUserStates ?? [],
    issueGitStates: raw.issueGitStates ?? [],
    repoProjections: raw.repoProjections,
  }
  const cache = seedCacheFromCorpus(corpus)
  cache.install([
    ...sessionHomes.sessions.map((value) => ({
      entity: 'session' as const,
      entityId: value.sessionId,
      value,
    })),
    ...sessionHomes.userStates.map((value) => ({
      entity: 'sessionUserState' as const,
      entityId: sessionUserStateRowId(value.userId, value.sessionId),
      value,
    })),
    ...sessionHomes.machines.map((value) => ({
      entity: 'machine' as const,
      entityId: value.id,
      value,
    })),
  ])
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  replica.onKernelEvent({
    type: 'bootstrap-installed',
    cause: 'cold-start',
    snapshotSeq,
    entityCount: cache.records.length,
    bufferedFramesApplied: 0,
  })
  const store = sidebarReplayStore(corpus, replica)
  store.sessions = dedupeSessions(
    sessionViews(replica.rows('sessions'), {
      userId: sessionHomes.userId,
      userStatesLoaded: true,
      userStates: replica.rows('sessionUserStates'),
      repos: replica.rows('repos'),
      machines: replica.rows('machines'),
    }),
  )
  const runtime = withKeyedInputs({
    principal: { userId: sessionHomes.userId },
    replica,
    getSnapshot: () => store,
    subscribe: () => () => {},
    pendingOverlaysByRow: () => new Map(),
  })
  const rows = createRowSource(runtime, replica, { mode: 'overlaid' }),
    locals = createEngineLocals(runtime)
  const handle = createWorklistPool(
    {
      ...rows.source,
      issueIdByRef: (ref) => rows.source.issueIdsByRef?.(ref)[0] ?? rows.source.issueIdByRef?.(ref),
    },
    locals.source,
    { summaries: MOBILE_INBOX_SUMMARIES },
  )
  try {
    const pool = handle.pool
    pool.header.apply([
      {
        kind: 'window',
        id: 'window',
        value: { view: 'workspace', paneA: null, fileTabs: [], outboxSize: 0 },
      },
    ])
    await pool.sources.ensure(MOBILE_INBOX_SOURCE_KEY, MOBILE_INBOX_ENTITIES, () => {
      pool.sources.view(MOBILE_INBOX_VIEW_KEY, () => createMobileInboxViews(pool))
      return new MobileInboxSource(runtime, pool)
    })
    const issues = allIssueViewModels(replica, store.issueProjections, store.issueUserStates),
      queue = buildScreeningQueue(issues).map((issue) => issue.id)
    const issueTargets: PodiumTarget[] = issues.flatMap((issue) => [
      { kind: 'issue' as const, issue: issue.id },
      ...(issue.displayRef ? [{ kind: 'issue' as const, issue: issue.displayRef }] : []),
    ])
    const sessionTargets: PodiumTarget[] = store.sessions.flatMap((session) => [
      { kind: 'session' as const, session: session.sessionId },
      ...(session.displayRef ? [{ kind: 'session' as const, session: session.displayRef }] : []),
    ])
    // All issue cards/refs, plus addressed direct/birth session targets. Replay
    // validates every value without writing any operator values to disk.
    const targets = process.argv.includes('--issue-routes-only')
      ? issueTargets
      : [...issueTargets, ...sessionTargets]
    const tokens = issues.flatMap((issue) =>
      issue.prefix && issue.displayRef
        ? [{ token: issue.displayRef, kind: 'issue' as const, prefix: issue.prefix }]
        : [],
    )
    const input = {
      now: corpus.fixedNow,
      targets,
      tokens,
      screeningIds: issues.map((issue) => issue.id),
    }
    const legacy = {
      issues,
      sessions: store.sessions,
      booting: false,
      queue,
      outboxSize: 0,
      routes: targets.map((target) =>
        mobilePodiumRoute(target, { issues, sessions: store.sessions }),
      ),
    }
    const locations: { sectionIndex: number; rowIndex: number | null; field: string }[] = []
    const compare = () => {
      locations.length = 0
      return checkMobileInbox(pool, legacy, input, (location) => locations.push(location))
    }
    let result = runInAction(compare)
    for (let round = 0; round < 64 && result.pending; round++) {
      pool.hydrate()
      await Promise.resolve()
      result = runInAction(compare)
    }
    const fields: readonly string[] = [
      'booting',
      'outboxSize',
      ...MOBILE_CARD_FIELDS,
      'route',
      'model',
      'known',
      'title',
      'summary',
      'tone',
      'time',
      'agentState',
      'offer',
      'agentColor',
      'busy',
      'issue',
    ]
    // Nested field paths can contain values in other diagnostics; export only
    // vocabulary positions from this check, never the path or mismatch value.
    const first = result.first
      ? {
          sectionPosition: result.first.sectionIndex,
          rowPosition: result.first.rowIndex,
          fieldPosition: fields.indexOf(result.first.field.split('.')[0] ?? ''),
        }
      : null
    console.log(
      JSON.stringify({
        issues: issues.length,
        sessions: store.sessions.length,
        targets: targets.length,
        positions: result.positions,
        differences: result.differences,
        pending: result.pending,
        first,
        locations: locations.slice(0, 20).map((location) => {
          const target =
            location.sectionIndex === 7 && location.rowIndex !== null
              ? targets[location.rowIndex]
              : undefined
          const index =
            target?.kind === 'issue'
              ? issues.findIndex(
                  (issue) =>
                    mobilePodiumRoute(target, { issues: [issue], sessions: [] }) ===
                    legacy.routes[location.rowIndex!],
                )
              : -1
          return {
            sectionPosition: location.sectionIndex,
            rowPosition: location.rowIndex,
            targetKindPosition: target?.kind === 'issue' ? 0 : target?.kind === 'session' ? 1 : -1,
            issuePosition: index,
            draftCount: index >= 0 ? Number(issues[index]!.isDraftVessel) : 0,
            parsedCount:
              target?.kind === 'issue'
                ? Number(!!parseIssueRef(target.issue))
                : target?.kind === 'session'
                  ? Number(!!parseSessionRef(target.session))
                  : 0,
            expectedFoundCount: Number(
              location.rowIndex !== null && !!legacy.routes[location.rowIndex],
            ),
            actualFoundCount: Number(
              !!(
                target &&
                runInAction(() =>
                  pool.sources
                    .view(MOBILE_INBOX_VIEW_KEY, () => createMobileInboxViews(pool))
                    .route(target),
                )
              ),
            ),
          }
        }),
      }),
    )
    if (result.differences || result.pending) process.exitCode = 1
  } finally {
    handle.dispose()
    locals.dispose()
    rows.dispose()
  }
}
if (import.meta.main)
  main().catch(() => {
    console.log(JSON.stringify({ failed: 1 }))
    process.exitCode = 1
  })
