import { describe, expect, it, vi } from 'vitest'
import { runSpecCli } from './spec-cli'

const META = [
  { id: 'SP-root', title: 'demo', parent: '', order: 0, status: 'active', updatedAt: 1 },
  {
    id: 'SP-aa11',
    title: 'Automations',
    parent: 'SP-root',
    order: 1,
    status: 'active',
    updatedAt: 1,
  },
  {
    id: 'SP-bb22',
    title: 'Retry behavior',
    parent: 'SP-aa11',
    order: 1,
    status: 'draft',
    updatedAt: 1,
  },
]

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    specs: {
      list: { query: vi.fn(async () => META) },
      get: {
        query: vi.fn(async ({ id }: { id: string }) => ({
          ...META.find((m) => m.id === id)!,
          body: '<p>retry at most twice</p>',
        })),
      },
      search: {
        query: vi.fn(async () => [{ id: 'SP-bb22', title: 'Retry behavior', snippet: 'twice' }]),
      },
      create: {
        mutate: vi.fn(async (i: { parent: string; title: string }) => ({
          id: 'SP-cc33',
          title: i.title,
          parent: i.parent,
          order: 2,
          status: 'draft',
          updatedAt: 1,
        })),
      },
      save: { mutate: vi.fn(async (i: { id: string }) => ({ ...META[1]!, ...i })) },
      remove: { mutate: vi.fn(async () => ({ ok: true })) },
      ...(overrides as object),
    },
  } as never
}

describe('runSpecCli', () => {
  it('tree renders the nested hierarchy with ids and status tags', async () => {
    const out = await runSpecCli(['tree', '--repoPath', '/r'], fakeClient())
    expect(out).toContain('SP-root  demo')
    expect(out).toContain('  SP-aa11  Automations')
    expect(out).toContain('    SP-bb22  Retry behavior [draft]')
  })

  it('prime emits the agent guide plus the tree', async () => {
    const out = await runSpecCli(['prime', '--repoPath', '/r'], fakeClient())
    expect(out).toContain('Only explicit human decisions')
    expect(out).toContain('CURRENT SPEC TREE')
    expect(out).toContain('SP-aa11')
  })

  it('show renders breadcrumb, children, code ref, and body', async () => {
    const out = await runSpecCli(['show', 'SP-bb22', '--repoPath', '/r'], fakeClient())
    expect(out).toContain('under: demo > Automations')
    expect(out).toContain('code ref: [spec:SP-bb22]')
    expect(out).toContain('retry at most twice')
  })

  it('search joins variadic positionals with spaces', async () => {
    const c = fakeClient()
    await runSpecCli(['search', 'retry', 'at', 'most', '--repoPath', '/r'], c)
    expect((c as any).specs.search.query).toHaveBeenCalledWith({
      repoPath: '/r',
      query: 'retry at most',
    })
  })

  it('create maps positionals and reports the new id + code ref', async () => {
    const out = await runSpecCli(['create', 'SP-aa11', 'Backoff', '--repoPath', '/r'], fakeClient())
    expect(out).toContain('created SP-cc33 "Backoff" under SP-aa11')
    expect(out).toContain('[spec:SP-cc33]')
  })

  it('update forwards only the provided fields', async () => {
    const c = fakeClient()
    await runSpecCli(['update', 'SP-aa11', '--status', 'superseded', '--repoPath', '/r'], c)
    expect((c as any).specs.save.mutate).toHaveBeenCalledWith({
      repoPath: '/r',
      id: 'SP-aa11',
      status: 'superseded',
    })
  })

  it('unknown command throws with help; help lists commands', async () => {
    await expect(runSpecCli(['nope'], fakeClient())).rejects.toThrow(/unknown command/i)
    const help = await runSpecCli(['help'], fakeClient())
    for (const name of ['prime', 'tree', 'show', 'search', 'create', 'update', 'remove']) {
      expect(help).toContain(name)
    }
  })

  it('missing repoPath (no inference possible) names the field', async () => {
    await expect(runSpecCli(['tree'], fakeClient())).rejects.toThrow(/repoPath/)
  })

  it('--json wraps the result', async () => {
    const out = await runSpecCli(['tree', '--repoPath', '/r', '--json'], fakeClient())
    const parsed = JSON.parse(out)
    expect(parsed.ok).toBe(true)
    expect(parsed.command).toBe('tree')
    expect(parsed.data).toHaveLength(3)
  })
})
