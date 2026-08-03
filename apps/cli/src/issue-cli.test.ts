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

  it('--help / -h render help without running anything', async () => {
    for (const argv of [['--help'], ['-h']]) {
      const out = await runIssueCli(argv, client)
      expect(out).toContain('podium issue <command>')
    }
  })

  it('per-command help: <cmd> --help and help <cmd> show flags with required markers', async () => {
    for (const argv of [
      ['claim', '--help'],
      ['help', 'claim'],
      ['claim', '-h'],
    ]) {
      const out = await runIssueCli(argv, client)
      expect(out).toContain('podium issue claim')
      expect(out).toContain('--assignee <value>')
      expect(out).toContain('(required)')
    }
  })

  it('help for an unknown command throws', async () => {
    await expect(runIssueCli(['help', 'nope'], client)).rejects.toThrow(/unknown command/i)
  })

  it('unknown command throws a helpful error (non-zero exit)', async () => {
    await expect(runIssueCli(['nope'], client)).rejects.toThrow(/unknown command/i)
  })

  it('invalid args name the offending field', async () => {
    await expect(runIssueCli(['claim', '--id', '1'], client)).rejects.toThrow(/assignee/)
  })

  it('forwards --confirm-rehome on attach as a boolean', async () => {
    const attachSession = vi.fn(async () => ({ seq: 2, title: 'Side quest' }))
    const c = { issues: { attachSession: { mutate: attachSession } } } as any
    const out = await runIssueCli(['attach', '--subissue', 'Side quest', '--confirm-rehome'], c)
    expect(attachSession).toHaveBeenCalledWith({
      newSubissue: { title: 'Side quest' },
      confirmRehome: true,
    })
    expect(out).toContain('attached to #2 Side quest')
  })

  /** POD-1545: the whole point is the single command, so these drive the real argv path
   *  (parse → camelFlag → per-command zod) rather than the command's run() body. That
   *  path is where `--model`/`--effort` were rejected outright — and where
   *  `--force-unknown-model` was too, its schema key having been spelled kebab while
   *  the parser hands every flag over camelCased. A run()-level test cannot see either. */
  it('start accepts --model/--effort/--force-unknown-model in one command (POD-1545)', async () => {
    const start = vi.fn(async () => ({ seq: 3, branch: 'issue/3-x', worktreePath: '/w' }))
    const c = { issues: { start: { mutate: start } } } as any
    await runIssueCli(['start', '--id', '3', '--model', 'claude-opus-5', '--effort', 'high'], c)
    expect(start).toHaveBeenCalledWith({
      id: '3',
      defaultModel: 'claude-opus-5',
      defaultEffort: 'high',
    })
    await runIssueCli(['start', '3', '--model', 'unlisted', '--force-unknown-model'], c)
    expect(start).toHaveBeenLastCalledWith({
      id: '3',
      defaultModel: 'unlisted',
      forceUnknownModel: true,
    })
  })

  it('add-session accepts --force-unknown-model (POD-1545)', async () => {
    const addSession = vi.fn(async () => ({ seq: 3 }))
    const c = { issues: { addSession: { mutate: addSession } } } as any
    await runIssueCli(['add-session', '3', '--force-unknown-model'], c)
    expect(addSession).toHaveBeenCalledWith({ id: '3', forceUnknownModel: true })
  })

  it('unknown flags are rejected, never silently dropped (#345)', async () => {
    await expect(runIssueCli(['update', '1', '--totally-bogus', 'x'], client)).rejects.toThrow(
      /unknown flag --totally-bogus/,
    )
    // read path too — this used to execute the full list
    await expect(runIssueCli(['list', '--repoPath', '/r', '--stage', 'x'], client)).rejects.toThrow(
      /unknown flag --stage/,
    )
  })

  it('global flags (--json) do not trip the strict schemas', async () => {
    const out = await runIssueCli(['ready', '--repoPath', '/r', '--json'], client)
    expect(JSON.parse(out).ok).toBe(true)
  })

  it('update with no field flags errors instead of reporting success (#345)', async () => {
    const update = vi.fn(async () => ({ seq: 1 }))
    const c = { issues: { update: { mutate: update } } } as any
    await expect(runIssueCli(['update', '1'], c)).rejects.toThrow(/no fields given/)
    expect(update).not.toHaveBeenCalled()
  })

  it('maps positionals onto the declared keys (show 10 ≡ show --id 10)', async () => {
    const get = vi.fn(async () => ({
      id: 'iss_a',
      seq: 10,
      title: 'T',
      description: 'D',
      stage: 'backlog',
      priority: 2,
      ready: true,
      blocked: false,
    }))
    const c = { issues: { get: { query: get } } } as any
    const out = await runIssueCli(['show', '10'], c)
    expect(get).toHaveBeenCalledWith({ id: '10' })
    expect(out).toContain('#10 T')
  })

  it('joins extra positionals into the restKey (show 1 2 3 ≡ show 1 --ids 2,3) [#82]', async () => {
    const seen: string[] = []
    const get = vi.fn(async (i: { id: string }) => {
      seen.push(i.id)
      return {
        id: `iss_${i.id}`,
        seq: Number(i.id),
        title: `T${i.id}`,
        description: 'D',
        stage: 'backlog',
        priority: 2,
        ready: true,
        blocked: false,
      }
    })
    const c = { issues: { get: { query: get } } } as any
    const out = await runIssueCli(['show', '1', '2', '3'], c)
    expect(seen.sort()).toEqual(['1', '2', '3'])
    expect(out).toContain('#1 T1')
    expect(out).toContain('#3 T3')
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
