/**
 * PLACING A CONVERSATION FOR ANOTHER CREDENTIAL (credential management §9;
 * epic Task 11, acceptance 5 and 6).
 *
 * Real files in two Podium homes and the default directory: the conversation
 * lands at the same relative path in the target home, a Codex copy across
 * accounts has no reasoning items, and the original stays byte-identical.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareConversation } from './conversation'
import { HomeRegistry } from './registry'

const CRED_A = 'cred_0b6f6f5e-2d43-4f7a-9d55-6a1f7c3e0e11'
const CRED_B = 'cred_7d1c2b0a-9e8f-4a6b-8c5d-1e2f3a4b5c6d'
const THREAD = '019a7f00-0000-7000-8000-00000000c0de'
const CLAUDE_ID = '5b1c0f4e-0000-4000-8000-00000000c1a0'

let state: string
let account: { home: string; env: Record<string, string> }
let homes: HomeRegistry

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'podium-conversation-'))
  account = { home: join(state, 'user'), env: {} }
  mkdirSync(account.home, { recursive: true })
  homes = new HomeRegistry({ root: join(state, 'homes') })
})

afterEach(() => {
  rmSync(state, { recursive: true, force: true })
})

const deps = () => ({ account, homes, now: () => 1_700_000_000_000 })

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

const line = (record: unknown) => JSON.stringify(record)

/** A rollout whose turn 1 left one encrypted reasoning item. */
const ROLLOUT = [
  line({ type: 'session_meta', payload: { id: THREAD, model_provider: 'openai' } }),
  line({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: 'My code word is FIG-2.' },
  }),
  line({
    type: 'response_item',
    payload: { type: 'reasoning', encrypted_content: 'gAAAA-not-ours' },
  }),
  line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'OK' } }),
  '',
].join('\n')

const rolloutRel = join(
  'sessions',
  '2026',
  '11',
  '16',
  `rollout-2026-11-16T10-00-00-${THREAD}.jsonl`,
)

function threadsDb(codexHome: string): string {
  const path = join(codexHome, 'state_5.sqlite')
  const db = openDatabase(path)
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT)')
  db.prepare('INSERT INTO threads (id, rollout_path, model_provider) VALUES (?, ?, ?)').run(
    THREAD,
    join(codexHome, 'elsewhere.jsonl'),
    'stub',
  )
  db.close()
  return path
}

function threadRows(path: string): number {
  const db = openDatabase(path, { readOnly: true })
  try {
    return (
      db.prepare('SELECT COUNT(*) AS n FROM threads WHERE id = ?').get(THREAD) as { n: number }
    ).n
  } finally {
    db.close()
  }
}

describe('prepareConversation', () => {
  it('Claude: copies the file and its side files to the same path in the target home; the original stays', async () => {
    const a = (await homes.ensure(CRED_A, 'claude-code')).home
    const b = (await homes.ensure(CRED_B, 'claude-code')).home
    const original = [
      line({ type: 'user', message: { content: 'My code word is QUINCE-4.' } }),
      line({
        type: 'assistant',
        message: { content: [{ type: 'thinking', signature: 'sig-of-A' }] },
      }),
      '',
    ].join('\n')
    const source = write(join(a.dir, 'projects', '-work-repo', `${CLAUDE_ID}.jsonl`), original)
    write(join(a.dir, 'projects', '-work-repo', CLAUDE_ID, 'subagents', 'one.jsonl'), 'side\n')

    const result = await prepareConversation(deps(), {
      agentKind: 'claude-code',
      cwd: '/work/repo',
      resume: { kind: 'claude-session', value: CLAUDE_ID },
      toHomeId: b.homeId,
      account: CRED_B,
      fromAccount: CRED_A,
    })

    const target = join(b.dir, 'projects', '-work-repo', `${CLAUDE_ID}.jsonl`)
    expect(result).toEqual({ ok: true, placed: 'copied', droppedReasoning: false, path: target })
    // A thinking block of another account needs nothing: the API drops it (POD-6893 §3).
    expect(readFileSync(target, 'utf8')).toBe(original)
    expect(
      readFileSync(
        join(b.dir, 'projects', '-work-repo', CLAUDE_ID, 'subagents', 'one.jsonl'),
        'utf8',
      ),
    ).toBe('side\n')
    expect(readFileSync(source, 'utf8')).toBe(original)
  })

  it('Codex across accounts: the copy has no reasoning items, the original is byte-identical, the target forgets its row', async () => {
    const a = (await homes.ensure(CRED_A, 'codex')).home
    const b = (await homes.ensure(CRED_B, 'codex')).home
    const source = write(join(a.dir, rolloutRel), ROLLOUT)
    const sourceDb = threadsDb(a.dir)
    const targetDb = threadsDb(b.dir)

    const result = await prepareConversation(deps(), {
      agentKind: 'codex',
      cwd: '/work/repo',
      resume: { kind: 'codex-thread', value: THREAD },
      toHomeId: b.homeId,
      account: CRED_B,
      fromAccount: CRED_A,
    })

    const target = join(b.dir, rolloutRel)
    expect(result).toEqual({ ok: true, placed: 'copied', droppedReasoning: true, path: target })
    const copied = readFileSync(target, 'utf8')
    expect(copied).not.toContain('"reasoning"')
    expect(copied).not.toContain('gAAAA-not-ours')
    expect(copied).toContain('My code word is FIG-2.')
    expect(copied.split('\n').filter(Boolean)).toHaveLength(3)
    expect(readFileSync(source, 'utf8')).toBe(ROLLOUT)
    expect(threadRows(targetDb)).toBe(0)
    expect(threadRows(sourceDb)).toBe(1)
  })

  it('Codex on the same account in another home keeps its reasoning', async () => {
    const a = (await homes.ensure(CRED_A, 'codex')).home
    const b = (await homes.ensure(CRED_A.replace('0b6f', '1b6f'), 'codex')).home
    write(join(a.dir, rolloutRel), ROLLOUT)
    const result = await prepareConversation(deps(), {
      agentKind: 'codex',
      cwd: '/work/repo',
      resume: { kind: 'codex-thread', value: THREAD },
      toHomeId: b.homeId,
      account: CRED_A,
      fromAccount: CRED_A,
    })
    expect(result).toMatchObject({ ok: true, placed: 'copied', droppedReasoning: false })
    expect(readFileSync(join(b.dir, rolloutRel), 'utf8')).toBe(ROLLOUT)
  })

  it('Codex in one home when the account changes: rewritten, the original kept beside it', async () => {
    const codexHome = join(account.home, '.codex')
    const path = write(join(codexHome, rolloutRel), ROLLOUT)
    const result = await prepareConversation(deps(), {
      agentKind: 'codex',
      cwd: '/work/repo',
      resume: { kind: 'codex-thread', value: THREAD },
      toHomeId: 'default',
      account: 'none',
      fromAccount: CRED_A,
    })
    expect(result).toEqual({ ok: true, placed: 'rewritten', droppedReasoning: true, path })
    expect(readFileSync(path, 'utf8')).not.toContain('"reasoning"')
    expect(readFileSync(`${path}.before-switch-1700000000000`, 'utf8')).toBe(ROLLOUT)
  })

  it('leaves a conversation already in its home on its account alone', async () => {
    const a = (await homes.ensure(CRED_A, 'codex')).home
    const path = write(join(a.dir, rolloutRel), ROLLOUT)
    const result = await prepareConversation(deps(), {
      agentKind: 'codex',
      cwd: '/work/repo',
      resume: { kind: 'codex-thread', value: THREAD },
      toHomeId: a.homeId,
      account: CRED_A,
    })
    expect(result).toEqual({ ok: true, placed: 'in-place', droppedReasoning: false, path })
    expect(readdirSync(dirname(path))).toEqual([`rollout-2026-11-16T10-00-00-${THREAD}.jsonl`])
  })

  it('takes the newest copy: back to a home after the conversation went on elsewhere', async () => {
    const a = (await homes.ensure(CRED_A, 'codex')).home
    const b = (await homes.ensure(CRED_B, 'codex')).home
    const stale = write(join(a.dir, rolloutRel), ROLLOUT)
    utimesSync(stale, new Date('2026-11-16T10:00:00Z'), new Date('2026-11-16T10:00:00Z'))
    const later = `${ROLLOUT}${line({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'later turn' } })}\n`
    write(join(b.dir, rolloutRel), later)
    const result = await prepareConversation(deps(), {
      agentKind: 'codex',
      cwd: '/work/repo',
      resume: { kind: 'codex-thread', value: THREAD },
      toHomeId: a.homeId,
      account: CRED_A,
      fromAccount: CRED_B,
    })
    expect(result).toMatchObject({ ok: true, placed: 'copied' })
    expect(readFileSync(join(a.dir, rolloutRel), 'utf8')).toContain('later turn')
  })

  it('without the account it ran on, a copy from another Podium home counts as another account', async () => {
    const a = (await homes.ensure(CRED_A, 'codex')).home
    write(join(a.dir, rolloutRel), ROLLOUT)
    const result = await prepareConversation(deps(), {
      agentKind: 'codex',
      cwd: '/work/repo',
      resume: { kind: 'codex-thread', value: THREAD },
      toHomeId: 'default',
      account: 'none',
    })
    expect(result).toMatchObject({ ok: true, placed: 'copied', droppedReasoning: true })
    expect(existsSync(join(account.home, '.codex', rolloutRel))).toBe(true)
  })

  it('says not-found when no home holds the conversation', async () => {
    const b = (await homes.ensure(CRED_B, 'codex')).home
    expect(
      await prepareConversation(deps(), {
        agentKind: 'codex',
        cwd: '/work/repo',
        resume: { kind: 'codex-thread', value: THREAD },
        toHomeId: b.homeId,
        account: CRED_B,
      }),
    ).toEqual({ ok: false, error: 'not-found' })
  })

  it('refuses a target home that is not on this machine', async () => {
    expect(
      await prepareConversation(deps(), {
        agentKind: 'codex',
        cwd: '/work/repo',
        resume: { kind: 'codex-thread', value: THREAD },
        toHomeId: `${CRED_B}:codex`,
        account: CRED_B,
      }),
    ).toMatchObject({ ok: false })
  })
})
