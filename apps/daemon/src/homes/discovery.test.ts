// DISCOVERY OVER EVERY HOME (credential management §10; epic plan Task 8,
// acceptance 4). One scan finds the conversations in the harness's own
// directory and in each Podium home, each under the native id its session
// resumes by, which is how a conversation is attributed to its session.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openIndexCache, runIndexRefreshJob } from '../discovery-jobs.js'
import { HomeRegistry, homeDiscoveryRoots } from './registry'

const CRED_A = 'cred_aaaaaaaa-0000-4000-8000-00000000000a'
const CRED_B = 'cred_bbbbbbbb-0000-4000-8000-00000000000b'

let root: string
let person: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-home-discovery-'))
  person = join(root, 'person')
  mkdirSync(person)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function claudeConversation(stateDir: string, id: string): void {
  const file = join(stateDir, 'projects', '-repo-project', `${id}.jsonl`)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'summary', customTitle: id, sessionId: id }),
      JSON.stringify({
        type: 'user',
        uuid: `${id}-u`,
        timestamp: '2026-11-16T11:00:00.000Z',
        cwd: '/repo/project',
        sessionId: id,
        message: { role: 'user', content: 'hello' },
      }),
    ].join('\n'),
  )
}

function codexConversation(stateDir: string, id: string): void {
  const file = join(stateDir, 'sessions', '2026', '11', '16', `rollout-${id}.jsonl`)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: '2026-11-16T10:00:00.000Z',
        type: 'session_meta',
        payload: { id, timestamp: '2026-11-16T10:00:00.000Z', cwd: '/repo/project' },
      }),
      JSON.stringify({
        timestamp: '2026-11-16T10:01:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      }),
    ].join('\n'),
  )
}

describe('discovery over every home', () => {
  it('finds a conversation in each home and in the default directory, each under its own id (acceptance 4)', async () => {
    const homes = new HomeRegistry({ root: join(root, 'homes') })
    const claudeA = (await homes.ensure(CRED_A, 'claude-code')).home
    const claudeB = (await homes.ensure(CRED_B, 'claude-code')).home
    const codexA = (await homes.ensure(CRED_A, 'codex')).home
    const codexB = (await homes.ensure(CRED_B, 'codex')).home
    claudeConversation(join(person, '.claude'), 'claude-default')
    claudeConversation(claudeA.dir, 'claude-in-a')
    claudeConversation(claudeB.dir, 'claude-in-b')
    codexConversation(codexA.dir, '019a0000-0000-7000-8000-00000000000a')
    codexConversation(codexB.dir, '019a0000-0000-7000-8000-00000000000b')

    const input = {
      homeDir: person,
      cachePath: join(root, 'discovery.db'),
      extraRoots: homeDiscoveryRoots(homes.list()),
      full: true,
    }
    const cache = openIndexCache(input)
    try {
      const result = await runIndexRefreshJob(input, cache)
      for (const [id, dir] of [
        ['claude-default', join(person, '.claude')],
        ['claude-in-a', claudeA.dir],
        ['claude-in-b', claudeB.dir],
        ['019a0000-0000-7000-8000-00000000000a', codexA.dir],
        ['019a0000-0000-7000-8000-00000000000b', codexB.dir],
      ] as const) {
        const summary = result.changed.find((candidate) => JSON.stringify(candidate).includes(id))
        expect(summary, id).toBeDefined()
        expect(summary?.path, id).toContain(dir)
      }
    } finally {
      cache.close?.()
    }
  })

  it('names each home directory as its harness’s root', async () => {
    const homes = new HomeRegistry({ root: join(root, 'homes') })
    const a = (await homes.ensure(CRED_A, 'codex')).home
    const b = (await homes.ensure(CRED_B, 'claude-code')).home
    expect(homeDiscoveryRoots(homes.list())).toEqual({ codex: [a.dir], 'claude-code': [b.dir] })
  })
})
