/**
 * PLACING A CONVERSATION FOR ANOTHER CREDENTIAL (credential management §9
 * "Switching a session to another credential", §10 "Homes"; epic plan Task 11).
 *
 * A harness keeps a conversation as a file under its configuration directory,
 * and every Podium home is such a directory. Before a session resumes on a
 * credential, the server asks this daemon to make sure the conversation is in
 * the home it resumes in (`conversationPrepareRequest`):
 *
 * - The newest copy in any home of the harness is the conversation. The default
 *   directory counts as a home (`default`).
 * - In another home: it is copied to the same path relative to the target
 *   home's state root, with its side files. The source stays as it was.
 * - When the account changes and the harness declares records that only their
 *   own account may send (Codex's encrypted reasoning, POD-6893 §3), the copy is
 *   written without them. In the same home the original is kept beside it as
 *   `<file>.before-switch-<ms>`, a name no harness reads as a conversation.
 * - Then the harness's own bookkeeping (`afterPlace`: Codex forgets the target's
 *   index row, which would otherwise win over the file).
 *
 * Nothing secret is read or written: a conversation file holds no credential,
 * and the request names credentials by id only.
 */

import { copyFile, cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import {
  declaredValue,
  type HarnessEnvironment,
  type HarnessHandoffTranscript,
  harnessAccount,
  manifestFor,
  withHomeScope,
} from '@podium/harness'
import { createLogger } from '@podium/logger'
import {
  type ConversationPlacement,
  type ConversationPrepareRequestMessage,
  DEFAULT_HOME_ID,
} from '@podium/protocol'
import type { ControlHandlers } from '../control/context'
import { resolveManagementAccount } from '../harness-management'
import type { HarnessHome } from './registry'

const log = createLogger('daemon:conversation')

/** The harness's own login: the account a `none` switch runs on. */
export const NO_CREDENTIAL = 'none'

export type ConversationPrepareRequest = Pick<
  ConversationPrepareRequestMessage,
  'agentKind' | 'cwd' | 'resume' | 'toHomeId' | 'account' | 'fromAccount' | 'modelProvider'
>

export interface ConversationDeps {
  /** The account HOME and machine env the harness's roots resolve from. */
  account: { home: string; env: HarnessEnvironment }
  /** Podium's homes on this machine; absent: only the default directory. */
  homes?: { list(): readonly HarnessHome[] }
  now?: () => number
}

export type ConversationPrepared =
  | { ok: true; placed: ConversationPlacement; droppedReasoning: boolean; path: string }
  | { ok: false; error: string }

interface HomeRoot {
  homeId: string
  /** The credential the home belongs to; undefined for the default directory. */
  credentialId?: string
  stateDir: string
}

function rootsFor(kind: string, deps: ConversationDeps): HomeRoot[] {
  const account = harnessAccount(kind, deps.account.home, deps.account.env)
  const roots: HomeRoot[] = [{ homeId: DEFAULT_HOME_ID, stateDir: account.roots.state }]
  for (const home of deps.homes?.list() ?? []) {
    if (home.harness !== kind) continue
    roots.push({
      homeId: home.homeId,
      credentialId: home.credentialId,
      stateDir: withHomeScope(kind, account, home.dir).roots.state,
    })
  }
  return roots
}

/** Put the conversation where a resume in `toHomeId` on `account` finds it. */
export async function prepareConversation(
  deps: ConversationDeps,
  request: ConversationPrepareRequest,
): Promise<ConversationPrepared> {
  const manifest = manifestFor(request.agentKind)
  const transcript: HarnessHandoffTranscript | undefined = manifest
    ? declaredValue(manifest.handoffTranscript)
    : undefined
  if (!transcript?.locateInHome) {
    return { ok: false, error: `${request.agentKind} does not say where its conversations are` }
  }
  const roots = rootsFor(request.agentKind, deps)
  const target = roots.find((root) => root.homeId === request.toHomeId)
  if (!target) return { ok: false, error: `the home ${request.toHomeId} is not on this machine` }

  let source: { root: HomeRoot; path: string; mtimeMs: number } | undefined
  for (const root of roots) {
    const path = await transcript.locateInHome({
      stateDir: root.stateDir,
      cwd: request.cwd,
      resumeValue: request.resume.value,
    })
    if (!path) continue
    const mtimeMs = (await stat(path)).mtimeMs
    // The newest copy is the conversation; on a tie the target's own wins.
    if (!source || mtimeMs > source.mtimeMs || (mtimeMs === source.mtimeMs && root === target)) {
      source = { root, path, mtimeMs }
    }
  }
  if (!source) return { ok: false, error: 'not-found' }

  const accountChanged =
    request.fromAccount !== undefined
      ? request.fromAccount !== request.account
      : source.root.credentialId !== undefined
        ? source.root.credentialId !== request.account
        : source.root !== target
  const carried = transcript.carryRecord
    ? await carryRecords(source.path, transcript.carryRecord, {
        accountChanged,
        ...(request.modelProvider !== undefined ? { modelProvider: request.modelProvider } : {}),
      })
    : undefined

  const inPlace = source.root === target
  if (inPlace && !carried?.altered) {
    return { ok: true, placed: 'in-place', droppedReasoning: false, path: source.path }
  }
  const destination = inPlace
    ? source.path
    : join(target.stateDir, relative(source.root.stateDir, source.path))
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  if (inPlace) {
    await copyFile(source.path, `${source.path}.before-switch-${(deps.now ?? Date.now)()}`)
  }
  const temporary = `${destination}.placing-${process.pid}`
  if (carried?.altered) await writeFile(temporary, carried.text, { mode: 0o600 })
  else await copyFile(source.path, temporary)
  await rename(temporary, destination)
  if (!inPlace) {
    for (const companion of transcript.companions?.(source.path) ?? []) {
      const exists = await stat(companion).then(
        () => true,
        () => false,
      )
      if (!exists) continue
      await cp(companion, join(target.stateDir, relative(source.root.stateDir, companion)), {
        recursive: true,
        force: true,
      })
    }
  }
  await transcript.afterPlace?.({
    stateDir: target.stateDir,
    resumeValue: request.resume.value,
    path: destination,
  })
  return {
    ok: true,
    placed: inPlace ? 'rewritten' : 'copied',
    droppedReasoning: (carried?.dropped ?? 0) > 0,
    path: destination,
  }
}

/** The file's lines through `carry`: whether any changed, and how many went. */
async function carryRecords(
  path: string,
  carry: NonNullable<HarnessHandoffTranscript['carryRecord']>,
  change: { accountChanged: boolean; modelProvider?: string },
): Promise<{ text: string; altered: boolean; dropped: number }> {
  const lines = (await readFile(path, 'utf8')).split('\n')
  const kept: string[] = []
  let altered = false
  let dropped = 0
  for (const line of lines) {
    if (!line.trim()) {
      kept.push(line)
      continue
    }
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      kept.push(line) // not a record this rule judges: it stays as written
      continue
    }
    const next = carry(record, change)
    if (next === undefined) {
      altered = true
      dropped += 1
    } else if (next === record) {
      kept.push(line)
    } else {
      altered = true
      kept.push(JSON.stringify(next))
    }
  }
  return { text: kept.join('\n'), altered, dropped }
}

export const conversationHandlers: Pick<ControlHandlers, 'conversationPrepareRequest'> = {
  conversationPrepareRequest: (ctx, msg) => {
    void (async () => {
      const reply = (result: ConversationPrepared): void => {
        ctx.send({
          type: 'conversationPrepareResult',
          requestId: msg.requestId,
          ok: result.ok,
          ...(result.ok
            ? { placed: result.placed, droppedReasoning: result.droppedReasoning }
            : { error: result.error }),
        })
      }
      try {
        const account = await resolveManagementAccount(ctx)
        if (!account) {
          reply({ ok: false, error: 'this machine has no account home' })
          return
        }
        const result = await prepareConversation(
          {
            account: { home: account.home, env: account.machineEnv },
            ...(ctx.homes ? { homes: ctx.homes } : {}),
          },
          msg,
        )
        if (result.ok && result.placed !== 'in-place') {
          log.info('placed a conversation for another credential', {
            sessionId: msg.sessionId,
            placed: result.placed,
            toHomeId: msg.toHomeId,
            droppedReasoning: result.droppedReasoning,
          })
        }
        reply(result)
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })()
  },
}
