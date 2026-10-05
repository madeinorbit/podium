import { ESLint } from 'eslint'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lint = new ESLint({ cwd: root, overrideConfigFile: join(root, 'eslint.config.mjs') })
const rule = 'derivations/no-reaction-writes'
async function findings(code: string, file = 'header-sessions.ts') {
  const [result] = await lint.lintText(code, { filePath: join(root, 'src', file) })
  expect(result?.fatalErrorCount).toBe(0)
  return result!.messages.filter((message) => message.ruleId === rule)
}

describe('reaction observable-write fence', () => {
  it.each([
    ['header-sessions.ts', `class HeaderSessions {
      roster = observable.map()
      file(id, value) { this.roster.set(id, value) }
      start() { reaction(() => row(), value => this.file('s', value)) }
    }`],
    ['worklist/visible.ts', `const owners = observable.map()
      const fileOwner = (id, value) => owners.set(id, value)
      reaction(() => row(), value => fileOwner('i', value))`],
    ['reader-queries.ts', `const prefixes = observable.set()
      reaction(() => row(), value => prefixes.add(value))`],
    ['chat-context-source.ts', `const members = observable.set()
      reaction(() => row(), value => runInAction(() => members.delete(value)))`],
    ['command-launch-views.ts', `const version = observable.box(0)
      reaction(() => row(), () => version.set(1))`],
    ['issue-reference.ts', `const requests = observable.map()
      reaction(() => row(), value => requests.set('POD-1', value))`],
  ])('PLANTED: rejects observable filing at %s', async (file, body) => {
    expect(await findings(`import { observable, reaction, runInAction } from 'mobx'\n${body}`, file)).toHaveLength(1)
  })

  it('handles imported aliases, namespace calls, and collection aliases', async () => {
    expect(await findings(`import { observable as obs, reaction as watch } from 'mobx'
      const rows = obs.map()
      const alias = rows
      watch(() => input(), value => alias.set('id', value))`)).toHaveLength(1)
    expect(await findings(`import * as mx from 'mobx'
      const rows = mx.observable.set()
      mx.reaction(() => input(), value => rows.add(value))`)).toHaveLength(1)
  })

  it('allows read-only effects, ordinary collections, computeds, and applying actions', async () => {
    expect(await findings(`import { observable, reaction, computed, runInAction } from 'mobx'
      const rows = observable.map(), plain = new Set()
      reaction(() => input(), value => plain.add(value))
      reaction(() => input(), value => render(rows.get(value)))
      const ids = computed(() => [...rows.keys()])
      runInAction(() => rows.set('id', input()))`)).toEqual([])
  })

  it('distinguishes shadowed collections and methods belonging to separate classes', async () => {
    expect(await findings(`import { observable, reaction } from 'mobx'
      const rows = observable.map()
      function plain() { const rows = new Map(); reaction(() => input(), value => rows.set('id', value)) }
      class Reactive { rows = observable.map(); file(value) { this.rows.set('id', value) } }
      class Plain { rows = new Map(); file(value) { this.rows.set('id', value) }
        start() { reaction(() => input(), value => this.file(value)) } }
      class Watched extends Reactive { start() { reaction(() => input(), value => rows.set('id', value)) } }`)).toHaveLength(1)
  })

  it('keeps the changed production sites and the documented board exception clean', async () => {
    const results = await lint.lintFiles([
      'src/header-sessions.ts', 'src/header-views.ts', 'src/worklist/visible.ts',
      'src/worklist/sidebar-roster.ts', 'src/chat-context-source.ts',
      'src/command-launch-views.ts', 'src/issue-reference.ts', 'src/issue-board-source.ts',
    ])
    expect(results.flatMap((result) => result.messages.filter((message) => message.fatal || message.ruleId === rule))).toEqual([])
  })
})
