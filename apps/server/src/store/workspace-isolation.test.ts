/**
 * EVERY REPOSITORY IS A WORKSPACE'S: THE COMPLETENESS PROOF (POD-6959 design 2.5, "the dynamic
 * complement"; task POD-7025).
 *
 * The eight `*.workspace.test.ts` files prove each group of repositories method by method.
 * This file proves nothing can be left out: it is driven by the repository list (every
 * repository a `SessionStore` builds, nested ones included) and by the workspace manifest
 * (every workspace table in `store/workspace-manifest.ts`), and it fails BY NAME on a
 * repository it does not exercise and on a workspace table no seed fills in both workspaces.
 *
 * THE SEEDS are the converted files' own, shared through `test-support/workspace-seeds/`: each
 * group's two workspaces hold the same ids and natural keys on one database, with content of
 * their own. Five repositories no group seeds (sync, settings, secrets, artifact uploads,
 * pending uploads) get one small seed here, built from the sessions and issues seeds' rows.
 *
 * THE CHECK, for every repository, in both directions (A then B, and B then A, each on a fresh
 * database):
 *   - a READ answers the same before and after the other workspace holds the same ids: the
 *     exercise's reads run once with only this workspace seeded and once after the other is
 *     seeded too, and the two answers must be equal (and not empty);
 *   - a WRITE leaves the other workspace's rows of every workspace table byte for byte as they
 *     were.
 * The exercises are a representative set of each repository's reads and writes, not every
 * method: the group files hold every method.
 *
 * THE PLANTED CASE: the same check run with one repository read replaced (in this test, not in
 * production code) by its statement without the workspace term must report that repository.
 */

import { asIssueId, asSessionId, asUserId, type MutationId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { type SQL, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { MODEL_CATALOG_VERSION } from '../model-catalog'
import type { SessionStore } from '../store'
import { testStoreEngine } from '../test-support/pg-test-database'
import { storeSql } from '../test-support/store-sql'
import * as conversations from '../test-support/workspace-seeds/conversations'
import * as events from '../test-support/workspace-seeds/events'
import * as issues from '../test-support/workspace-seeds/issues'
import * as messages from '../test-support/workspace-seeds/messages'
import * as people from '../test-support/workspace-seeds/people'
import * as remaining from '../test-support/workspace-seeds/remaining'
import * as sessions from '../test-support/workspace-seeds/sessions'
import * as shipping from '../test-support/workspace-seeds/shipping'
import { openWorkspaceStores } from '../test-support/workspace-stores'
import { TABLE_MANIFEST, type TableOrigin } from './workspace-manifest'

type Tag = 'a' | 'b'
const otherOf = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')

/**
 * A whole store seen as a group's slice (`engine`, `all`, `run`): the slice seeds take that
 * shape, and a whole store holds every repository they write.
 */
function asSlice<T>(store: SessionStore): T {
  const view = Object.create(store) as Record<string, unknown>
  view.engine = storeSql(store).engine
  view.all = async (statement: SQL) => await storeSql(store).all(statement)
  view.run = async (statement: SQL) => {
    await storeSql(store).run(statement)
  }
  return view as T
}

// ---- the inventory ------------------------------------------------------------------------

/** Fields of a store that are no repository of a workspace's rows. */
const NOT_REPOSITORIES = new Set([
  'database',
  // An in-memory invalidation signal, covered by workspace-caches.test.ts.
  'tableWrites',
])

/**
 * Repositories whose rows are the INSTALL's, not a workspace's (design 2.1: `install` tables
 * and install keys of `meta`). Every workspace reads and writes the same rows, by design; the
 * group files prove that sharing.
 */
const INSTALL_REPOSITORIES: Record<string, string> = {
  updateRecovery:
    'the update recovery checkpoint is an install key of meta (remaining.workspace.test.ts)',
  'machines.recordContext':
    'the fleet channel and update execution are install keys of meta (people.workspace.test.ts)',
}

/** Repositories that hold no statement of their own: each nested repository is exercised. */
const FACADES: Record<string, string> = {
  conversations:
    'only ensureFts; its index, registry, mirror and transcript index are exercised by name',
  openedVault:
    "the workspace's vault: it holds no statement; its key rows are the credentials repository's (vault_key), exercised there",
  vaultKeyCheck:
    'the same vault, as the credentials repository asks it whether a key opens; no statement of its own',
}

const isInstance = (value: unknown): value is object =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof Map) &&
  !(value instanceof Set) &&
  Object.getPrototypeOf(value) !== Object.prototype

/**
 * Every repository a store builds, by path: its own fields that are class instances, and the
 * fields of those whose class is a repository (`…Repository`), each instance once.
 */
function repositoryPaths(store: SessionStore): string[] {
  const seen = new Set<object>()
  const top: [string, object][] = []
  for (const [name, value] of Object.entries(store)) {
    if (NOT_REPOSITORIES.has(name) || !isInstance(value)) continue
    top.push([name, value])
    seen.add(value)
  }
  const paths = top.map(([name]) => name)
  for (const [name, value] of top) {
    for (const [field, nested] of Object.entries(value)) {
      if (!isInstance(nested) || seen.has(nested)) continue
      if (!/Repository$/.test(nested.constructor.name)) continue
      seen.add(nested)
      paths.push(`${name}.${field}`)
    }
  }
  return paths.sort()
}

/** Every workspace table of the manifest that a migrated database holds. */
const WORKSPACE_TABLES = Object.entries(TABLE_MANIFEST)
  .filter(
    // No workspace table is planned today; the manifest's literal types know it.
    ([, entry]) => entry.class === 'workspace' && (entry.origin as TableOrigin) !== 'planned',
  )
  .map(([table]) => table)
  .sort()

/**
 * Workspace tables Postgres keeps in another shape, by the SQLite table: the row's workspace
 * lives in the Postgres-only table (`PG_ONLY_TABLES`, `migrations/pg/schema-overrides.ts`).
 */
const PG_WORKSPACE_TWINS: Readonly<Record<string, string>> = {
  // SQLite keeps each transcript search row's workspace in transcript_fts_keys beside the
  // FTS5 table; Postgres keeps the rows, workspace included, in transcript_text.
  transcript_fts_keys: 'transcript_text',
}

/** The workspace tables `engine` holds: the manifest's, with Postgres's twins in place. */
const workspaceTablesOf = (engine: 'sqlite' | 'pg'): string[] =>
  engine === 'pg'
    ? WORKSPACE_TABLES.map((table) => PG_WORKSPACE_TWINS[table] ?? table).sort()
    : WORKSPACE_TABLES

/**
 * Workspace tables no repository seed fills, each with the reason. A table here is still
 * held to the rule by the audit (`workspace-scope-audit.test.ts`) and the keys (POD-7024).
 */
const UNSEEDED: Record<string, string> = {
  approval_requests:
    'no repository writes or lists its rows: the machines sentinel scan only asks whether a row ' +
    'names the retired sentinel machine (people.workspace.test.ts holds it to its workspace)',
}

// ---- the groups ---------------------------------------------------------------------------

interface Context {
  readonly store: SessionStore
  readonly tag: Tag
  /** What this workspace's seed returned. */
  readonly seeded: unknown
}

interface Exercise {
  /** Reads whose answers must not change when the other workspace holds the same ids. */
  readonly read: (c: Context) => Promise<unknown>
  /** Writes that must leave the other workspace's rows as they were (none: a read-only
   *  repository). */
  readonly write?: (c: Context) => Promise<unknown>
}

interface Group {
  readonly name: string
  readonly ws: Record<Tag, string>
  readonly prepare?: (store: SessionStore) => Promise<void>
  readonly seed: (store: SessionStore, tag: Tag) => Promise<unknown>
  readonly exercises: Record<string, Exercise>
}

const ALICE = asUserId('user:alice')
const S1 = asSessionId('s1')
const ISS1 = asIssueId('iss-1')
const AT = '2026-11-17T10:00:00.000Z'
const LATER = '2099-01-01T00:00:00.000Z'

const sessionsGroup: Group = {
  name: 'sessions',
  ws: sessions.WS,
  seed: async (store, tag) => await sessions.seed(store, tag),
  exercises: {
    sessions: {
      read: async ({ store: { sessions: s } }) => ({
        live: await s.loadSessions(),
        deleted: await s.loadDeletedSessions(),
        one: await s.getSession(sessions.sid(1)),
        byResume: await s.findSessionByResumeValue('resume-1'),
        underPath: await s.sessionsUnderPath(sessions.ROOT),
        pins: await s.allPinsForBootReconcile(),
        tabs: await s.allTabOrdersForBootReconcile(),
        readAt: await s.listReadAt(sessions.ALICE),
        offers: await s.listOffers(),
        drafts: await s.loadDrafts(),
        docs: await s.loadDraftDocs(),
        owners: await s.bindingOwnersForMachine(sessions.MACHINE),
      }),
      write: async ({ store: { sessions: s }, tag }) => {
        await s.upsertSession(sessions.scope, sessions.session(tag, 1, { title: `${tag} renamed` }))
        await s.softDeleteSessions(sessions.scope, [sessions.sid(2)], AT, 'standalone')
        await s.purgeSession(sessions.scope, sessions.sid(4))
        await s.addPin(sessions.ALICE, 'repo', sessions.ROOT, AT)
        await s.removePinsOf('issue', sessions.iss(1))
        await s.markSessionRead(sessions.scope, sessions.BOB, sessions.sid(2), AT)
        await s.clearAllSnoozes(sessions.scope, sessions.sid(2))
        await s.clearOffer(sessions.scope, sessions.sid(1))
        await s.setTabOrder(sessions.ALICE, sessions.ROOT, [sessions.sid(3)])
        await s.setDraft(sessions.sid(1), `${tag} typed`)
        await s.detachDanglingIssueReferences()
      },
    },
    layout: {
      read: async ({ store }) => ({
        snapshot: await store.layout.getSnapshot(sessions.ALICE),
        all: await store.layout.allForBootReconcile(10),
      }),
      write: async ({ store }) => {
        await store.layout.set(sessions.scope, sessions.ALICE, 'dockTab', 'shell', AT)
        await store.layout.clear(sessions.scope, sessions.BOB, 'superOpen')
      },
    },
    dockShells: {
      read: async ({ store }) => ({
        alice: await store.dockShells.listForUser(sessions.ALICE),
        bob: await store.dockShells.get(sessions.BOB, `${sessions.ROOT}/w2`),
      }),
      write: async ({ store }) => {
        await store.dockShells.removeByWorktree(`${sessions.ROOT}/w1`)
        await store.dockShells.set(sessions.BOB, `${sessions.ROOT}/w9`, sessions.sid(9), AT)
      },
    },
    readPositions: {
      read: async ({ store }) => ({
        alice: await store.readPositions.getSnapshot(sessions.ALICE),
        bob: await store.readPositions.get(sessions.BOB, 'issueEvents'),
      }),
      write: async ({ store }) => {
        await store.readPositions.advance(
          sessions.scope,
          sessions.ALICE,
          'issueEvents',
          { lastEventId: 99, seenAt: AT },
          AT,
        )
      },
    },
    'settings.userPreferences': {
      read: async ({ store }) => ({
        alice: await store.settings.userPreferences.recordFor(sessions.ALICE),
        all: await store.settings.userPreferences.allRecordsForBootReconcile(),
      }),
      write: async ({ store }) => {
        await store.settings.userPreferences.set(sessions.ALICE, 'roles.coding.model', 'next', AT)
        await store.settings.userPreferences.clear(sessions.BOB, 'notifications.ntfyTopic')
      },
    },
  },
}

const issuesGroup: Group = {
  name: 'issues',
  ws: issues.WS,
  seed: async (store, tag) => await issues.seed(store, tag),
  exercises: {
    issues: {
      read: async ({ store: { issues: s } }) => ({
        rows: await s.listIssueRows(),
        one: await s.getIssue(issues.iss(1)),
        labels: await s.listLabels(),
        issueLabels: await s.getIssueLabels(issues.iss(1)),
        deps: await s.listAllIssueDeps(),
        comments: await s.listIssueComments(issues.iss(1)),
        history: await s.listIssueTextRevisions(issues.iss(1), 'description'),
        mail: await s.listIssueMessages(issues.iss(1)),
        markers: await s.listIssueUserStateRows(),
        nextSeq: await s.nextIssueSeq(issues.REPO),
        stats: await s.issueStatTotals({ repo: false, live: true, order: 'path-seq' }),
      }),
      write: async ({ store: { issues: s }, tag }) => {
        await s.upsertIssue(
          issues.scope,
          issues.issue(tag, 1, { title: `${tag} renamed`, revision: 2 }),
        )
        await s.setIssueLabels(issues.iss(2), ['ui'])
        await s.removeIssueDep(issues.iss(2), issues.iss(3))
        await s.deleteIssueComment(issues.comment(2))
        await s.markIssueMessagesRead(issues.ALICE, issues.iss(1), [issues.message(2)], LATER)
        await s.setIssueUserState(issues.scope, issues.ALICE, issues.iss(1), { tuckedAt: LATER })
        await s.allocateSessionLetter(issues.iss(1))
        await s.deleteIssue(issues.iss(3))
      },
    },
    'issues.panel': {
      read: async ({ store }) => ({
        read: await store.issues.panel.read(issues.iss(1)),
        state: await store.issues.panel.state(issues.iss(1)),
        next: await store.issues.panel.next('issuePanelTodo', issues.iss(1)),
      }),
      write: async ({ store, tag }) => {
        await store.issues.panel.save(issues.scope, 'issuePanelTodo', {
          id: issues.todo(2),
          issueId: issues.iss(1),
          position: 5,
          text: `${tag} second`,
          done: false,
        })
        await store.issues.panel.toggle(issues.scope, issues.iss(1), issues.todo(1), true)
        await store.issues.panel.remove(
          issues.scope,
          'issuePanelArtifact',
          issues.iss(1),
          issues.artifact(1),
        )
      },
    },
    'issues.gitStates': {
      read: async ({ store }) => ({ one: await store.issues.gitStates.get(issues.iss(2)) }),
      write: async ({ store }) => {
        await store.issues.gitStates.set(issues.scope, issues.iss(2), {
          updatedAt: LATER,
          branch: 'moved',
          shared: false,
          dirtyFiles: 9,
        })
      },
    },
  },
}

type MessageSlice = Parameters<typeof messages.seed>[0]
const messagesGroup: Group = {
  name: 'messages',
  ws: messages.WS,
  seed: async (store, tag) => await messages.seed(asSlice<MessageSlice>(store), tag),
  exercises: {
    janitorReads: {
      read: async ({ store }) => ({
        implicit: await store.janitorReads.implicitExpiryPage({ cutoff: LATER, limit: 50 }),
        explicit: await store.janitorReads.explicitExpiryPage({ now: LATER, limit: 50 }),
      }),
    },
    messages: {
      read: async ({ store: { messages: m } }) => ({
        one: await m.getMessage(messages.mid(1)),
        operator: await m.listMessagesFor({ kind: 'operator' }),
        queued: await m.listQueued(),
        ledger: await m.listLedger({ issueId: messages.iss(1), sessionId: messages.sid(1) }),
        receipts: [...(await m.readReceipts(messages.sid(1), [messages.mid(1), messages.mid(5)]))],
        cooldown: await m.getWakeCooldown(messages.COOLDOWN),
        chat: await m.confirmedChatWindow(10),
      }),
      write: async ({ store: { messages: m }, tag }) => {
        await m.markCancelled(messages.scope, messages.mid(1))
        await m.markAcked(messages.scope, messages.mid(3), `${tag}-ack`)
        await m.recordRead(messages.mid(2), messages.sid(1), AT)
        await m.recordWakeCooldown(messages.COOLDOWN, LATER)
      },
    },
    messagingTopics: {
      read: async ({ store }) => ({
        chat: await store.messagingTopics.listForChat(messages.CHAT),
      }),
      write: async ({ store }) => {
        await store.messagingTopics.upsert({
          issueId: messages.iss(1),
          chatId: messages.CHAT,
          threadRef: 'thread-2',
          superagentThreadId: 'moved' as never,
          updatedAt: LATER,
        })
      },
    },
    messagingSessionAttachments: {
      read: async ({ store }) => ({
        one: await store.messagingSessionAttachments.get(messages.CHAT, ''),
        session: await store.messagingSessionAttachments.listForSession(messages.sid(1)),
      }),
      write: async ({ store }) => {
        await store.messagingSessionAttachments.markRelayed(messages.CHAT, '', messages.sid(1), 'x')
        await store.messagingSessionAttachments.remove(messages.CHAT, '')
      },
    },
    telegramBindings: {
      read: async ({ store }) => ({ all: await store.telegramBindings.list() }),
      write: async ({ store }) => {
        await store.telegramBindings.removeForUser(messages.ALICE)
      },
    },
    notificationFacts: {
      read: async ({ store }) => ({
        active: await store.notificationFacts.hasActive(messages.fact(1), messages.TARGET, AT),
      }),
      write: async ({ store }) => {
        await store.notificationFacts.retireFactKeyPrefix('fact:', LATER)
        await store.notificationFacts.retireExpired(LATER)
      },
    },
  },
}

type PeopleSlice = Parameters<typeof people.seed>[0]
const superagentUsers = (store: SessionStore) =>
  (store.superagent as unknown as { users: SessionStore['users'] }).users
const peopleGroup: Group = {
  name: 'people',
  ws: people.WS,
  seed: async (store, tag) => await people.seed(asSlice<PeopleSlice>(store), tag),
  exercises: {
    janitorReads: {
      read: async ({ store }) => ({
        admin: await store.janitorReads.earliestAdminId(),
        remote: await store.janitorReads.remoteMachines({ localMachineId: 'none', limit: 50 }),
      }),
    },
    users: {
      read: async ({ store }) => ({
        all: await store.users.listIncludingDisabled(),
        alice: await store.users.get(people.user()),
        admins: [...(await store.users.activeAdminIds())],
        byEmail: await store.users.byEmail(people.SHARED.email('alice')),
      }),
      write: async ({ store, tag }) => {
        await store.users.memberRows.write(people.member(tag, 'dave'))
        await store.users.writeProfile(people.user(), `${tag} renamed`, null)
      },
    },
    machines: {
      read: async ({ store }) => ({
        all: await store.machines.listMachines(),
        token: await store.machines.getMachineByToken(people.machine(), people.token('a')),
        custodian: await store.machines.custodian(people.machine()),
      }),
      write: async ({ store }) => {
        await store.machines.renameMachine(people.machine(), 'renamed')
        await store.machines.revokeMachine(people.machine(2))
      },
    },
    grants: {
      read: async ({ store }) => ({
        issue: await store.grants.listForResource('issue', people.SHARED.issue),
        machine: await store.grants.loadForResource('machine', people.machine()),
      }),
      write: async ({ store }) => {
        await store.grants.removeAllForGrantee(people.user('bob'))
      },
    },
    repos: {
      read: async ({ store }) => ({
        all: await store.repos.listRepos(),
        prefix: await store.repos.prefixForPath(`${people.ROOT}/src`),
        branch: await store.repos.defaultParentBranchForRepoId(people.repoIdOf()),
      }),
      write: async ({ store }) => {
        await store.repos.setRepoDefaultParentBranch(people.machine(), people.ROOT, 'next')
        await store.repos.removeRepo(`${people.ROOT}-scratch`, people.machine(2))
      },
    },
    checkouts: {
      read: async ({ store }) => ({
        all: await store.checkouts.all(),
        lost: [...(await store.checkouts.lostOfMachines([people.machine()])).entries()],
      }),
      write: async ({ store }) => {
        await store.checkouts.apply(
          [],
          [{ machineId: people.machine(), path: `${people.ROOT}/w1`, root: people.ROOT }],
          AT,
        )
      },
    },
    nativeLogins: {
      read: async ({ store }) => ({
        optIns: await store.nativeLogins.optInsFor(people.user()),
        transfers: await store.nativeLogins.transfersFor(people.user()),
      }),
      write: async ({ store }) => {
        await store.nativeLogins.setOptIn(
          people.user(),
          'claude-code',
          people.SHARED.fingerprint,
          false,
          AT,
        )
      },
    },
    credentials: {
      read: async ({ store }) => ({
        one: await store.credentials.get(people.CREDENTIAL),
        visible: await store.credentials.listVisibleTo(people.user()),
        many: await store.credentials.getMany([people.CREDENTIAL]),
        machines: [...(await store.credentials.allowedMachinesOf([people.CREDENTIAL])).entries()],
        placements: await store.credentials.listPlacements(people.CREDENTIAL),
        live: await store.credentials.listLivePlacementsOfOwner(people.user()),
        secret: await store.credentials.latestSecret(people.CREDENTIAL),
        legacy: await store.credentials.legacyAccountRows(),
        sends: await store.credentials.legacyAccountSends(),
        vaultKey: await store.credentials.readVaultKey(),
      }),
      write: async ({ store, tag }) => {
        await store.credentials.rename(people.CREDENTIAL, `${tag} renamed`)
        await store.credentials.setPlacementState(
          { credentialId: people.CREDENTIAL, machineId: people.machine(), kind: 'home' },
          'removal-pending',
        )
        await store.credentials.disallowMachine(people.CREDENTIAL, people.machine())
        await store.credentials.remove(people.CREDENTIAL)
      },
    },
    signInCarryOver: {
      read: async ({ store }) => ({
        sealed: await store.signInCarryOver.sealedOf(people.SHARED.carried, AT),
        honoured: await store.signInCarryOver.countHonoured(),
        end: await store.signInCarryOver.periodEnd(),
      }),
      write: async ({ store }) => {
        await store.signInCarryOver.endByLabel('login')
        await store.signInCarryOver.deleteEverything()
      },
    },
    settingsAudit: {
      read: async ({ store }) => ({ trail: await store.settingsAudit.list() }),
      write: async ({ store }) => {
        await store.settingsAudit.append({
          command: 'members.remove',
          outcome: 'applied',
          actorKind: 'system',
          actorId: 'system:test',
          onBehalfOf: null,
          detail: {},
          redactedPaths: [],
          createdAt: AT,
        })
      },
    },
    agentProfiles: {
      read: async ({ store }) => ({
        all: await store.agentProfiles.list(),
        seqs: await store.agentProfiles.openIssueSeqsUsing(people.SHARED.profile),
      }),
      write: async ({ store }) => {
        await store.agentProfiles.delete(people.SHARED.profile)
      },
    },
    // The superagent's own handle on the members (a second UsersRepository of the workspace).
    'superagent.users': {
      read: async ({ store }) => ({
        all: await superagentUsers(store).listIncludingDisabled(),
        alice: await superagentUsers(store).get(people.user()),
      }),
      write: async ({ store, tag }) => {
        await superagentUsers(store).memberRows.write(people.member(tag, 'erin'))
      },
    },
    identityUpgrade: {
      read: async ({ store }) => ({ honoured: await store.signInCarryOver.countHonoured() }),
      write: async ({ store }) => {
        await store.identityUpgrade.retireSessions()
      },
    },
  },
}

type EventSlice = Parameters<typeof events.seed>[0]
const eventsGroup: Group = {
  name: 'events',
  ws: events.WS,
  seed: async (store, tag) => await events.seed(asSlice<EventSlice>(store), tag),
  exercises: {
    events: {
      read: async ({ store: { events: e } }) => ({
        log: await e.listEventsSince(0, { limit: 100 }),
        runtime: await e.listRuntimeEvents(events.sid(1)),
        checkpoint: await e.runtimeEventCheckpoint(events.sid(1)),
        steward: await e.getStewardState(events.STEWARD_KEY),
        subscriptions: await e.allSubscriptionsForBootReconcile(),
        max: await e.maxEventId(),
      }),
      write: async ({ store: { events: e }, tag }) => {
        await e.removeSubscription(events.sub(1))
        await e.setStewardState(events.STEWARD_KEY, `${tag}-changed`)
        await e.appendEventOnce({ ts: AT, kind: `${tag}.once`, subject: events.iss(1) })
        const plan = await e.planEventPrune({ maxAgeDays: -36_500, maxRows: 0 })
        while ((await e.pruneEventBatch(plan, 500)) > 0) {}
      },
    },
    effects: {
      read: async ({ store }) => ({
        live: await store.effects.liveByIds([1, 2, 3, 4, 5, 6].map((n) => events.eff(n))),
        one: await store.effects.get(events.eff(1)),
      }),
      write: async ({ store }) => {
        await store.effects.publishCopied(events.scope, 10)
        await store.effects.expireDue(events.scope, events.NOW_MS, 10)
        await store.effects.purgeTombstones(events.scope, events.NOW_MS + 1, 10)
      },
    },
    workflows: {
      read: async ({ store }) => ({
        all: await store.workflows.listWorkflows(),
        run: await store.workflows.getRun(events.RUN),
        steps: await store.workflows.getRunSteps(events.RUN),
        events: await store.workflows.listRunEvents(events.RUN),
      }),
      write: async ({ store, tag }) => {
        await store.workflows.updateRunStatus(events.RUN, 'complete', LATER)
        await store.workflows.appendEvent({
          runId: events.RUN,
          kind: `${tag}.done`,
          actor: events.OPERATOR,
          now: LATER,
        })
      },
    },
    automations: {
      read: async ({ store }) => ({
        all: await store.automations.list(),
        runs: await store.automations.listAllRuns(),
      }),
      write: async ({ store }) => {
        await store.automations.remove(events.scope, events.auto(1), LATER)
      },
    },
    interactions: {
      read: async ({ store }) => ({
        session: await store.interactions.listForSession(events.sid(1)),
      }),
      write: async ({ store }) => {
        await store.interactions.closeSession(events.sid(1), 'expired', LATER)
        await store.interactions.pruneResolvedBefore(LATER)
      },
    },
    superagent: {
      read: async ({ store }) => ({
        messages: await store.superagent.loadSuperagentMessages(events.THREAD),
        queued: await store.superagent.listQueuedInputs(),
        turns: await store.superagent.listPendingTurns(),
      }),
      write: async ({ store }) => {
        await store.superagent.deletePendingTurn('turn-1')
        await store.superagent.syncTurnRunningWithPendingTurns()
        await store.superagent.clearSuperagentMessages(events.THREAD)
      },
    },
    observationCheckpoints: {
      read: async ({ store }) => ({
        one: await store.observationCheckpoints.get(events.sid(1)),
        candidate: await store.observationCheckpoints.getTerminalCandidate(events.sid(1)),
      }),
      write: async ({ store }) => {
        await store.observationCheckpoints.cancelTerminalCandidate(events.sid(3))
        await store.observationCheckpoints.purge(events.sid(2))
      },
    },
    transcriptCosts: {
      read: async ({ store }) => ({
        attributed: await store.transcriptCosts.allAttributed(),
        since: await store.transcriptCosts.latestWindowSinceMs(),
      }),
      write: async ({ store }) => {
        await store.transcriptCosts.record(
          [
            {
              machineId: events.MACHINE,
              nativeId: 'native-1',
              path: '/repo/t1.jsonl',
              harness: 'codex',
              sessionId: events.sid(1),
              issueId: events.iss(1),
              scannedBytes: 99,
              firstTsMs: 1,
              lastTsMs: 3,
              models: [],
              windowModels: [],
              windowSinceMs: 7,
            },
          ] as never,
          LATER,
        )
      },
    },
    // Read only: the janitor proposes, the server's repositories write (POD-6993).
    janitorReads: {
      read: async ({ store }) => ({
        max: await store.janitorReads.maxEventId(),
        cap: await store.janitorReads.eventCapThroughId(1),
        steward: await store.janitorReads.stewardCursor(),
        due: await store.janitorReads.dueAutomations({ now: LATER, limit: 10 }),
        commands: await store.janitorReads.commandPruneCount(LATER),
        commandHead: await store.janitorReads.commandPruneHead(LATER),
        pruneHead: await store.janitorReads.eventPruneHead({ cutoff: LATER, capThroughId: 1e9 }),
        pruneCount: await store.janitorReads.eventPruneCount({ cutoff: LATER, capThroughId: 1e9 }),
      }),
    },
    maintenance: {
      read: async ({ store }) => ({
        one: await store.maintenance.getCommand('message-expiry', events.runKey(1)),
      }),
      write: async ({ store }) => {
        await store.maintenance.pruneCommandsBatch(LATER, 100)
      },
    },
    locks: {
      read: async ({ store }) => ({
        lock: await store.locks.getLock(events.REPO, events.LOCK),
        waiters: await store.locks.listWaiters(events.REPO, events.LOCK),
      }),
      write: async ({ store }) => {
        await store.locks.renewLock(events.REPO, events.LOCK, events.sid(1), LATER)
        await store.locks.deleteLock(events.REPO, events.LOCK)
      },
    },
  },
}

const remainingGroup: Group = {
  name: 'remaining',
  ws: remaining.WS,
  seed: async (store, tag) => await remaining.seed(store, tag),
  exercises: {
    readWatermarks: {
      read: async ({ store }) => ({
        mark: await store.readWatermarks.getRecapWatermark(remaining.READER, remaining.TARGET),
      }),
      write: async ({ store, tag }) => {
        await store.readWatermarks.setRecapWatermark(
          remaining.READER,
          remaining.TARGET,
          `${tag}-mark-2`,
          remaining.REMARKED_AT,
        )
      },
    },
    quotaHistory: {
      read: async ({ store }) => ({
        windows: await store.quotaHistory.list(0, remaining.SEEN),
        count: await store.quotaHistory.countAll(),
      }),
      write: async ({ store }) => {
        await store.quotaHistory.prune(Number.MAX_SAFE_INTEGER)
      },
    },
    notices: {
      read: async ({ store }) => ({
        open: await store.notices.listOpen(remaining.RECIPIENT, { limit: 10 }),
        byIds: await store.notices.openByIds([remaining.noticeId(1), remaining.noticeId(2)]),
        all: await store.notices.allOpen(),
        unread: await store.notices.countUnread(remaining.RECIPIENT),
      }),
      write: async ({ store }) => {
        await store.notices.markRead(
          remaining.RECIPIENT,
          remaining.noticeId(2),
          remaining.REMARKED_AT,
        )
        await store.notices.resolveReadEventsBeyond(remaining.RECIPIENT, 0, remaining.REMARKED_AT)
        await store.notices.markAllRead(remaining.RECIPIENT, remaining.REMARKED_AT)
        await store.notices.resolveByKey(remaining.NOTICE_KEY, remaining.REMARKED_AT)
      },
    },
    concertmaster: {
      read: async ({ store }) => {
        const pages = []
        for await (const page of store.concertmaster.entryPages(1)) pages.push(page)
        return {
          byIds: await store.concertmaster.entriesByIds([
            remaining.entryId(1),
            remaining.entryId(2),
          ]),
          pages,
          entry: await store.concertmaster.entry(remaining.entryId(1)),
          ask: await store.concertmaster.ask(remaining.TARGET, 1),
          asks: await store.concertmaster.asks(remaining.TARGET, 10),
          tail: await store.concertmaster.tail(remaining.TARGET, 10),
        }
      },
      write: async ({ store, tag }) => {
        await store.concertmaster.rewriteAsk(remaining.entryId(2), {
          title: `${tag}: reworded`,
          detail: null,
          options: null,
        })
        await store.concertmaster.settleAsk(remaining.entryId(2), {
          status: 'answered',
          answer: `${tag}: this one`,
          settledAt: remaining.REMARKED_AT,
          settledBy: 'user',
        })
        await store.concertmaster.addUserEntry({
          id: remaining.entryId(3),
          sessionId: remaining.TARGET,
          body: `${tag}: hello`,
          senderUserId: remaining.RECIPIENT,
          createdAt: remaining.REMARKED_AT,
        })
      },
    },
    operations: {
      read: async ({ store }) => ({
        history: await store.operations.history(),
        approved: await store.operations.approvedTarget('dev'),
      }),
      write: async ({ store }) => {
        await store.operations.markTerminal(remaining.opId('live'), 'failed', 2000)
        await store.operations.sweepRetention('test', 0)
      },
    },
  },
}

type ConversationSlice = Parameters<typeof conversations.seed>[0]
const conversationsGroup: Group = {
  name: 'conversations',
  ws: conversations.WS,
  prepare: async (store) => await store.conversations.ensureFts(true),
  seed: async (store, tag) => await conversations.seed(asSlice<ConversationSlice>(store), tag),
  exercises: {
    'conversations.index': {
      read: async ({ store }) => ({
        records: await store.conversations.index.records([
          conversations.nat(1),
          conversations.nat(2),
        ]),
        search: await store.conversations.index.search({ query: 'shared' }),
      }),
      write: async ({ store }) => {
        await store.conversations.index.setMeta(conversations.scope, conversations.nat(2), {
          name: 'renamed',
        })
        await store.conversations.index.delete(conversations.scope, conversations.MACHINE, [
          conversations.nat(1),
        ])
      },
    },
    'conversations.registry': {
      read: async ({ store }) => ({
        paths: [
          ...(
            await store.conversations.registry.pathsByNativeIds(conversations.MACHINE, [
              conversations.nat(1),
              conversations.nat(2),
            ])
          ).entries(),
        ],
        siblings: await store.conversations.registry.siblingSegments(
          conversations.MACHINE,
          conversations.nat(3),
        ),
      }),
      write: async ({ store }) => {
        await store.conversations.registry.ensureMany(conversations.MACHINE, [
          {
            nativeId: conversations.nat(2),
            providerId: 'p',
            path: '/lake/moved.jsonl',
            sizeBytes: 9,
          },
        ])
      },
    },
    'conversations.mirror': {
      read: async ({ store }) => ({
        cursor: await store.conversations.mirror.mirrorCursor(
          conversations.MACHINE,
          conversations.nat(1),
        ),
        incarnations: await store.conversations.mirror.incarnations(
          conversations.MACHINE,
          conversations.nat(1),
        ),
      }),
      write: async ({ store }) => {
        await store.conversations.mirror.setReportedBytes(
          conversations.MACHINE,
          conversations.nat(2),
          999,
        )
      },
    },
    'conversations.transcriptIndex': {
      read: async ({ store }) => ({
        rows: await store.conversations.transcriptIndex.rows(
          conversations.MACHINE,
          conversations.nat(1),
        ),
        matches: await store.conversations.transcriptIndex.searchCandidates('needle'),
      }),
      write: async ({ store }) => {
        await store.conversations.transcriptIndex.drop(conversations.MACHINE, conversations.nat(1))
      },
    },
  },
}

type ShippingSlice = Parameters<typeof shipping.seed>[0]
const shippingGroup: Group = {
  name: 'shipping',
  ws: shipping.WS,
  seed: async (store, tag) => await shipping.seed(asSlice<ShippingSlice>(store), tag),
  exercises: {
    shipping: {
      read: async ({ store }) => ({
        orders: await store.shipping.listOrders(),
        holds: await store.shipping.listHolds(),
        receipts: await store.shipping.listReceipts(),
        edges: await store.shipping.listNativeStackEdges(),
        leaders: await store.shipping.shippedLeadersOfOpenTrains(),
      }),
      write: async ({ store, seeded }) => {
        const mine = seeded as Awaited<ReturnType<typeof shipping.seed>>
        const at = '2026-11-17T11:00:00.000Z'
        await store.shipping.cancelAttemptAndOrder(shipping.scope, mine.queued.id, 'queued', at)
        await store.shipping.releaseTrain(shipping.scope, mine.manifest.id, at, 'done')
        await store.shipping.resolveHold(shipping.scope, mine.one.id, 2, 'retry', 'queued', at)
      },
    },
  },
}

/** The repositories no group seeds: one small seed from the sessions and issues seeds' rows. */
const MACHINE = sessions.MACHINE
const othersGroup: Group = {
  name: 'others',
  ws: sessions.WS,
  seed: async (store, tag) => {
    await store.sessions.upsertSession(sessions.scope, sessions.session(tag, 1))
    await store.issues.upsertIssue(issues.scope, issues.issue(tag, 1))
    await store.settings.setSettings(
      normalizeSettings({ gitWorkflow: { defaultParentBranch: `release-${tag}` } }),
    )
    await store.settings.setModelCatalog({
      machineId: MACHINE,
      byAgent: { claude: [{ value: `${tag}-model`, label: `${tag} model` }] },
      fetchedAt: 1,
      version: MODEL_CATALOG_VERSION,
    })
    await store.settings.recordSetupEnrollment('request', `${tag}-receipt`)
    await store.secrets.set('notifications.telegramBotToken', `${tag}-key`, AT)
    await store.sync.appendChanges(
      [{ entity: 'session', entityId: S1, op: 'upsert', payload: JSON.stringify({ tag }) }],
      1000,
    )
    await store.sync.recordAppliedMutation('mut-1' as MutationId, 'proc', `${tag}-result`, 1000)
    await store.sync.enqueueMessage({
      id: 'queued-1',
      sessionId: S1,
      text: `${tag} queued`,
      queuedAt: 1,
    })
    await store.artifactUploads.begin({
      issueId: ISS1,
      uploadId: 'upload-1',
      beginJson: JSON.stringify({ tag }),
      received: [tag === 'a' ? 1 : 2],
      createdAt: 1,
    })
    // No repository writes these two: the kind generations are bumped by migrations, and the
    // upstream outbox is archived (read only). Raw rows of this workspace, for their reads.
    await storeSql(store).run(
      sql`INSERT INTO sync_kind (workspace_id, kind, generation) VALUES (${sessions.WS[tag]}, 'isolation-kind', ${tag === 'a' ? 1 : 2})`,
    )
    await storeSql(store).run(
      sql`INSERT INTO upstream_outbox (workspace_id, mutation_id, proc, input, queued_at, queue_order) VALUES (${sessions.WS[tag]}, 'outbox-1', ${`${tag}.proc`}, '{}', ${tag === 'a' ? 1 : 2}, 1)`,
    )
    await store.pendingUploads.insert({
      id: 'pending-1',
      ownerUserId: ALICE,
      filename: `${tag}.txt`,
      entry: `${tag}.txt`,
      mediaType: 'text/plain',
      size: tag === 'a' ? 1 : 2,
      createdAt: 1,
    })
  },
  exercises: {
    settings: {
      read: async ({ store }) => ({
        settings: await store.settings.getSettings(),
        catalog: await store.settings.getModelCatalog(MACHINE),
        receipt: await store.settings.setupEnrollmentReceipt('request'),
      }),
      write: async ({ store, tag }) => {
        await store.settings.setSettings(
          normalizeSettings({ gitWorkflow: { defaultParentBranch: `${tag}-next` } }),
        )
        await store.settings.completeDataMigration('example-v1')
      },
    },
    secrets: {
      read: async ({ store }) => ({
        key: await store.secrets.get('notifications.telegramBotToken'),
        presence: await store.secrets.presence(),
      }),
      write: async ({ store }) => {
        await store.secrets.clear('notifications.telegramBotToken')
      },
    },
    sync: {
      read: async ({ store }) => ({
        feed: await store.sync.readFeedState(),
        changes: await store.sync.changesSince(0),
        applied: await store.sync.getAppliedMutation('mut-1' as MutationId),
        queued: await store.sync.listQueuedMessages(S1),
        kinds: await store.sync.readKindGenerations(),
        parked: await store.sync.listParkedUpstreamMutations(),
      }),
      write: async ({ store, tag }) => {
        await store.sync.appendChanges(
          [{ entity: 'session', entityId: S1, op: 'remove', payload: null }],
          2000,
        )
        await store.sync.deleteQueuedMessage('queued-1')
        await store.sync.recordAppliedMutation('mut-2' as MutationId, 'proc', `${tag}-2`, 2000)
      },
    },
    artifactUploads: {
      read: async ({ store }) => ({
        one: await store.artifactUploads.get(ISS1, 'upload-1'),
        page: await store.artifactUploads.page(undefined, 10),
      }),
      write: async ({ store }) => {
        await store.artifactUploads.deleteIssue(ISS1)
      },
    },
    pendingUploads: {
      read: async ({ store }) => ({
        one: await store.pendingUploads.get('pending-1'),
        page: await store.pendingUploads.page('', 10),
      }),
      write: async ({ store }) => {
        await store.pendingUploads.delete('pending-1')
      },
    },
  },
}

/**
 * The janitor's archive and worktree reads (POD-6993) find only FINISHED rows their owner
 * has read, which no group seeds: the issues seed plus a done top-level issue with a closed
 * worktree and a stopped session, each read by its owner, the same ids in both workspaces.
 * The janitor only reads (the server's repositories write), so the exercise has no write.
 */
const janitorGroup: Group = {
  name: 'janitor',
  ws: issues.WS,
  seed: async (store, tag) => {
    await issues.seed(store, tag)
    const reader = issues.owner(tag)
    await store.issues.upsertIssue(
      issues.scope,
      issues.issue(tag, 6, {
        stage: 'done',
        closedAt: AT,
        worktreePath: `${issues.ROOT}/.worktrees/six-${tag}`,
      } as never),
    )
    await store.issues.setIssueUserState(issues.scope, reader, issues.iss(6), { readAt: AT })
    await store.sessions.upsertSession(
      sessions.scope,
      sessions.session(tag, 7, { ownerUserId: reader, status: 'exited', stoppedAt: AT }),
    )
    await store.sessions.markSessionRead(sessions.scope, reader, sessions.sid(7), AT)
  },
  exercises: {
    janitorReads: {
      read: async ({ store }) => ({
        sessions: await store.janitorReads.sessionArchivePage({ cutoffReadAt: LATER, limit: 50 }),
        issues: await store.janitorReads.issueArchivePage({ cutoffReadAt: LATER, limit: 50 }),
        worktrees: await store.janitorReads.worktreeGcPage({ cutoffClosedAt: LATER, limit: 50 }),
      }),
    },
  },
}

const GROUPS: readonly Group[] = [
  sessionsGroup,
  janitorGroup,
  issuesGroup,
  messagesGroup,
  peopleGroup,
  eventsGroup,
  remainingGroup,
  conversationsGroup,
  shippingGroup,
  othersGroup,
]

// ---- the check ----------------------------------------------------------------------------

/** A value as JSON, with maps and sets spelled out, so two answers compare. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v instanceof Map ? { map: [...v.entries()] } : v instanceof Set ? { set: [...v] } : v,
  ) ?? 'undefined'

/** Whether an answer holds anything: an exercise whose reads find nothing proves nothing. */
const holdsSomething = (value: unknown): boolean =>
  Object.values(value as Record<string, unknown>).some(
    (v) =>
      v !== null &&
      v !== undefined &&
      v !== false &&
      v !== 0 &&
      !(Array.isArray(v) && v.length === 0) &&
      !(v instanceof Map && v.size === 0) &&
      !(
        typeof v === 'object' &&
        !Array.isArray(v) &&
        !(v instanceof Map) &&
        Object.keys(v).length === 0
      ),
  )

/** The workspace tables this database holds (search's key table exists only with search on). */
async function presentTables(store: SessionStore): Promise<string[]> {
  const rows = await storeSql(store).all<{ name: string }>(
    storeSql(store).engine === 'pg'
      ? sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`
      : sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
  )
  const names = new Set(rows.map((row) => row.name))
  return workspaceTablesOf(storeSql(store).engine).filter((table) => names.has(table))
}

/** Every workspace table's rows of one workspace, each as a set (sorted by text). */
async function workspaceRows(store: SessionStore, ws: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  for (const table of await presentTables(store)) {
    out[table] = (
      await storeSql(store).all(
        sql`SELECT * FROM ${sql.identifier(table)} WHERE workspace_id = ${ws}`,
      )
    )
      .map((row) => canonical(row))
      .sort()
  }
  return out
}

interface Plant {
  /** The repository the planted read belongs to. */
  readonly repository: string
  /** Replace one read of `store`'s repository with its statement minus the workspace term. */
  readonly install: (store: SessionStore) => void
}

interface Outcome {
  readonly findings: string[]
  /** Workspace tables with rows in both workspaces once both are seeded. */
  readonly filled: Set<string>
}

/**
 * One group on fresh databases, in both directions: `first` is seeded alone, its reads are
 * taken, the other workspace is seeded with the same ids, the reads are taken again and must
 * be equal; then each exercise's writes run in `first` and the other's rows must be as they
 * were.
 */
async function checkGroup(group: Group, plant?: Plant): Promise<Outcome> {
  const findings: string[] = []
  const filled = new Set<string>()
  for (const first of ['a', 'b'] as const) {
    const second = otherOf(first)
    const opened = await openWorkspaceStores([group.ws.a, group.ws.b], { path: ':memory:' })
    const stores: Record<Tag, SessionStore> = { a: opened[0], b: opened[1] }
    try {
      for (const tag of [first, second]) await group.prepare?.(stores[tag])
      if (plant) plant.install(stores[first])
      const seeded: Partial<Record<Tag, unknown>> = {}
      seeded[first] = await group.seed(stores[first], first)
      const context = (tag: Tag): Context => ({ store: stores[tag], tag, seeded: seeded[tag] })
      const before = new Map<string, string>()
      for (const [name, exercise] of Object.entries(group.exercises)) {
        const answer = await exercise.read(context(first))
        if (!holdsSomething(answer)) findings.push(`${name}: its reads found nothing in ${first}`)
        before.set(name, canonical(answer))
      }
      seeded[second] = await group.seed(stores[second], second)
      for (const table of await presentTables(stores.a)) {
        const counts: number[] = []
        for (const tag of ['a', 'b'] as const) {
          const [row] = await storeSql(stores.a).all<{ n: number | string }>(
            sql`SELECT count(*) AS n FROM ${sql.identifier(table)} WHERE workspace_id = ${group.ws[tag]}`,
          )
          counts.push(Number(row?.n ?? 0))
        }
        if (counts.every((n) => n > 0)) filled.add(table)
      }
      for (const [name, exercise] of Object.entries(group.exercises)) {
        const after = canonical(await exercise.read(context(first)))
        if (after !== before.get(name)) {
          findings.push(`${name}: a read in ${first} changed when ${second} held the same ids`)
        }
      }
      for (const [name, exercise] of Object.entries(group.exercises)) {
        if (exercise.write === undefined) continue
        const untouched = canonical(await workspaceRows(stores.a, group.ws[second]))
        await exercise.write(context(first))
        if (canonical(await workspaceRows(stores.a, group.ws[second])) !== untouched) {
          findings.push(`${name}: a write in ${first} changed ${second}'s rows`)
        }
      }
    } finally {
      await stores.a.close()
    }
  }
  return { findings, filled }
}

describe('POD-7025 — no repository and no workspace table is left out', () => {
  it('every repository a store builds is exercised, or named as the install’s or a facade', async () => {
    const [store] = await openWorkspaceStores(['ws_a', 'ws_b'], { path: ':memory:' })
    try {
      const exercised = new Set(GROUPS.flatMap((group) => Object.keys(group.exercises)))
      const accounted = new Set([
        ...exercised,
        ...Object.keys(INSTALL_REPOSITORIES),
        ...Object.keys(FACADES),
      ])
      const paths = repositoryPaths(store)
      expect(paths.filter((path) => !accounted.has(path))).toEqual([])
      // And no exercise names a repository the store does not build.
      expect([...accounted].filter((path) => !paths.includes(path))).toEqual([])
      expect(paths.length).toBeGreaterThan(40)
    } finally {
      await store.close()
    }
  })

  const outcomes = new Map<string, Outcome>()

  for (const group of GROUPS) {
    it(`${group.name}: every read answers only its own workspace, every write leaves the other’s rows`, async () => {
      const outcome = await checkGroup(group)
      outcomes.set(group.name, outcome)
      expect(outcome.findings).toEqual([])
    })
  }

  it('every workspace table holds rows in both workspaces of some group, or says why not', () => {
    // Runs after the groups above (vitest runs a file's cases in order).
    expect(outcomes.size).toBe(GROUPS.length)
    const filled = new Set([...outcomes.values()].flatMap((outcome) => [...outcome.filled]))
    const missing = workspaceTablesOf(testStoreEngine()).filter(
      (table) => !filled.has(table) && !(table in UNSEEDED),
    )
    expect(missing).toEqual([])
    // And no reason stays once a seed fills its table.
    expect(Object.keys(UNSEEDED).filter((table) => filled.has(table))).toEqual([])
  })

  it('a repository read with its workspace term removed (planted here) is caught', async () => {
    const plant: Plant = {
      repository: 'readWatermarks',
      install: (store) => {
        // The read's own statement, less `workspace_id = ?`: the newest row of the key wins.
        store.readWatermarks.getRecapWatermark = async (reader, sessionId) => {
          // The second workspace's row first (ws_b sorts after ws_a): Postgres has no rowid to
          // order the newest by, and both rows carry the same update time.
          const [row] = await storeSql(store).all<{ watermark: string }>(
            sql`SELECT watermark FROM recap_watermarks WHERE reader = ${reader} AND session_id = ${sessionId} ORDER BY workspace_id DESC LIMIT 1`,
          )
          return row?.watermark ?? null
        }
      },
    }
    const { findings } = await checkGroup(remainingGroup, plant)
    expect(findings).toContain(`${plant.repository}: a read in a changed when b held the same ids`)
  })
})
