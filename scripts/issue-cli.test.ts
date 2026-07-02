import { describe, expect, it, vi } from 'vitest'
import { parseIssueArgs, resolveRepoArg, runIssueCli } from './issue-cli'

describe('parseIssueArgs', () => {
  it('parses the command, positionals, --flag value, --flag=value, and --bool', () => {
    const r = parseIssueArgs(['create', '--title', 'Fix login', '--priority=0', '--json'])
    expect(r.command).toBe('create')
    expect(r.args.title).toBe('Fix login')
    expect(r.args.priority).toBe('0')
    expect(r.args.json).toBe(true)
  })

  it('parses --outside-scope', () => {
    const { args } = parseIssueArgs(['update', '--id=B', '--outside-scope'])
    expect(args.outsideScope).toBe(true)
  })
})

describe('runIssueCli', () => {
  const client = {
    issues: { ready: { query: vi.fn(async () => [{ seq: 1, title: 'A', priority: 0 }]) } },
  } as any

  it('runs a known command and returns its text', async () => {
    const out = await runIssueCli(['ready', '--repoPath', '/r'], client)
    expect(out).toContain('A')
  })

  it('issue help lists the command names', async () => {
    const out = await runIssueCli(['help'], client)
    expect(out).toContain('ready')
    expect(out).toContain('create')
  })

  it('unknown command throws a helpful error (non-zero exit)', async () => {
    await expect(runIssueCli(['nope'], client)).rejects.toThrow(/unknown command/i)
  })

  it('invalid args name the offending field', async () => {
    await expect(runIssueCli(['claim', '--id', '1'], client)).rejects.toThrow(/assignee/)
  })

  it('maps positionals onto the declared keys (show 10 ≡ show --id 10)', async () => {
    const get = vi.fn(async () => ({
      id: 'iss_a', seq: 10, title: 'T', description: 'D', stage: 'backlog',
      priority: 2, ready: true, blocked: false,
    }))
    const c = { issues: { get: { query: get } } } as any
    const out = await runIssueCli(['show', '10'], c)
    expect(get).toHaveBeenCalledWith({ id: '10' })
    expect(out).toContain('#10 T')
  })

  it('maps two positionals for dep-add (from, to)', async () => {
    const depAdd = vi.fn(async () => ({}))
    const c = { issues: { depAdd: { mutate: depAdd } } } as any
    await runIssueCli(['dep-add', '11', '10', '--type', 'discovered-from'], c)
    expect(depAdd).toHaveBeenCalledWith({ fromId: '11', toId: '10', type: 'discovered-from' })
  })

  it('--json emits a structured envelope with the data payload', async () => {
    const out = await runIssueCli(['ready', '--repoPath', '/r', '--json'], client)
    const parsed = JSON.parse(out)
    expect(parsed).toMatchObject({ command: 'ready', ok: true })
    expect(parsed.data).toEqual([{ seq: 1, title: 'A', priority: 0 }])
    expect(parsed.text).toContain('A')
  })

  it('--json never swallows a following positional (boolean flag)', () => {
    const r = parseIssueArgs(['show', '--json', '10'])
    expect(r.args.json).toBe(true)
    expect(r.positionals).toEqual(['10'])
  })

  it('defaults the comment author from opts (relay=agent, direct=operator)', async () => {
    const addComment = vi.fn(async () => ({ seq: 4 }))
    const c = { issues: { addComment: { mutate: addComment } } } as any
    await runIssueCli(['comment', '4', '--body', 'hi'], c, { defaultAuthor: 'operator' })
    expect(addComment).toHaveBeenCalledWith({ id: '4', author: 'operator', body: 'hi' })
  })
})

describe('resolveRepoArg', () => {
  it('injects the inferred repo when --repoPath is absent', async () => {
    const args = await resolveRepoArg('ready', {}, async () => '/inferred')
    expect(args.repoPath).toBe('/inferred')
  })

  it('keeps an explicit --repoPath', async () => {
    const args = await resolveRepoArg('ready', { repoPath: '/explicit' }, async () => '/inferred')
    expect(args.repoPath).toBe('/explicit')
  })

  it('leaves args untouched for a command that takes no repo', async () => {
    const args = await resolveRepoArg('show', { id: 'pod-1' }, async () => '/inferred')
    expect(args.repoPath).toBeUndefined()
    expect(args.id).toBe('pod-1')
  })

  it('does not inject when inference yields nothing', async () => {
    const args = await resolveRepoArg('ready', {}, async () => undefined)
    expect(args.repoPath).toBeUndefined()
  })
})
