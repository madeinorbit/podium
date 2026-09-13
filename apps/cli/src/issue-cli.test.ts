import { ISSUE_COMMANDS, LOCK_COMMANDS, SPEC_COMMANDS } from '@podium/issue-client'
import { describe, expect, it, vi } from 'vitest'
import {
  commandHelpText,
  parseIssueArgs,
  registryFlags,
  resolveRepoArg,
  runIssueCli,
} from './issue-cli'

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

  it('parses --terminal-evidence as an acknowledgement flag', () => {
    const { args, positionals } = parseIssueArgs([
      'artifact',
      '2602',
      '--add',
      'artifacts/live.png',
      '--terminal-evidence',
    ])
    expect(positionals).toEqual(['2602'])
    expect(args.terminalEvidence).toBe(true)
  })

  it('parses ship with an optional positional id and outside-scope confirmation', () => {
    expect(parseIssueArgs(['ship'])).toMatchObject({ command: 'ship', positionals: [] })
    expect(parseIssueArgs(['ship', 'POD-830', '--outside-scope'])).toMatchObject({
      command: 'ship',
      positionals: ['POD-830'],
      args: { outsideScope: true },
    })
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
    // `claim` was the example here until A2 took its `--assignee` away — it now
    // has no required flag at all, so it can no longer demonstrate the marker.
    // `comment --body` is the replacement and is a better one: `--author` sits
    // beside it with a default, so a run that rendered EVERY flag as required
    // would pass the old assertion and fail this one.
    for (const argv of [
      ['comment', '--help'],
      ['help', 'comment'],
      ['comment', '-h'],
    ]) {
      const out = await runIssueCli(argv, client)
      expect(out).toContain('podium issue comment')
      expect(out).toContain('--body <value>')
      expect(out).toContain('(required)')
      expect(out).toContain('--author <value>')
    }
  })

  it('ship help renders the optional id and shared outside-scope convention', async () => {
    const out = await runIssueCli(['ship', '--help'], client)
    expect(out).toContain('podium issue ship [<id>]')
    expect(out).toContain('--outside-scope')
  })

  it('artifact help names the sanctioned terminal screenshot path', async () => {
    const out = await runIssueCli(['artifact', '--help'], client)
    expect(out).toContain('--terminal-evidence')
    expect(out).toContain('raster images only')
  })

  it('ship forwards no client-derived target when omitted and renders service custody', async () => {
    const ship = vi.fn(async () => ({
      created: true,
      order: {
        id: 'ship_order',
        issueId: 'iss_attached',
        destination: 'local:main',
      },
    }))
    const c = { issues: { ship: { mutate: ship } } } as any
    const out = await runIssueCli(['ship'], c)
    expect(ship).toHaveBeenCalledWith({})
    expect(out).toBe('shipping iss_attached → local:main\nPodium owns it now.')
  })

  it('ship maps an explicit positional id while outside-scope stays on the transport', async () => {
    const ship = vi.fn(async () => ({
      created: false,
      order: { id: 'ship_order', issueId: 'iss_root', destination: 'local:main' },
    }))
    const c = { issues: { ship: { mutate: ship } } } as any
    await runIssueCli(['ship', 'POD-830', '--outside-scope'], c)
    expect(ship).toHaveBeenCalledWith({ id: 'POD-830' })
  })

  it('cancel and hold commands forward only durable order identity and typed generation action', async () => {
    const cancelShip = vi.fn(async () => ({
      id: 'ship_order',
      issueId: 'iss_root',
      state: 'cancelled',
    }))
    const resolveShipHold = vi.fn(async () => ({
      order: { id: 'ship_order', state: 'queued' },
    }))
    const c = {
      issues: {
        cancelShip: { mutate: cancelShip },
        resolveShipHold: { mutate: resolveShipHold },
      },
    } as any

    await runIssueCli(['cancel-ship', 'ship_order', '--outside-scope'], c)
    expect(cancelShip).toHaveBeenCalledWith({ orderId: 'ship_order' })
    await runIssueCli(['resolve-ship-hold', 'ship_order', 'retry', '4'], c)
    expect(resolveShipHold).toHaveBeenCalledWith({
      orderId: 'ship_order',
      action: 'retry',
      expectedGeneration: 4,
    })
  })

  it('delivery-receipt exposes the full immutable proof by order identity', async () => {
    const receipt = {
      id: 'receipt_order',
      orderId: 'ship_order',
      approvedBaseSha: 'base',
      approvedHeadSha: 'head',
      resultCommitSha: 'landed',
      testedIntegrationSha: 'tested',
      landedRefSha: 'landed',
      destinationSha: 'destination',
      validationProfileId: 'lean',
      validationResult: 'passed',
      destination: 'origin/main',
      completedAt: '2026-08-13T10:00:00.000Z',
    }
    const deliveryReceipt = vi.fn(async () => receipt)
    const c = { issues: { deliveryReceipt: { query: deliveryReceipt } } } as any

    const out = await runIssueCli(['delivery-receipt', 'ship_order'], c)
    expect(deliveryReceipt).toHaveBeenCalledWith({ orderId: 'ship_order' })
    expect(out).toContain('approved: base..head')
    expect(out).toContain('tested: tested')
    expect(out).toContain('landed: landed')
    expect(out).toContain('destination: destination')
    expect(out).toContain('validation: passed (lean)')

    await expect(runIssueCli(['delivery-receipt'], c)).rejects.toThrow(/orderId/)
  })

  it('help for an unknown command throws', async () => {
    await expect(runIssueCli(['help', 'nope'], client)).rejects.toThrow(/unknown command/i)
  })

  it('unknown command throws a helpful error (non-zero exit)', async () => {
    await expect(runIssueCli(['nope'], client)).rejects.toThrow(/unknown command/i)
  })

  it('invalid args name the offending field', async () => {
    // Was `claim` missing `--assignee`; A2 removed that flag, so the omission it
    // demonstrated is `comment` missing `--body`.
    await expect(runIssueCli(['comment', '--id', '1'], client)).rejects.toThrow(/body/)
  })

  it('claim takes an id and nothing else — it cannot reassign a human', async () => {
    // THE A2 PROPERTY AT THE CLI SEAM. `claim` used to require `--assignee` and
    // the service wrote it, so the command an agent runs to pick up work moved the
    // accountable human (ADR 9 Amendment 1 D2 forbids exactly that). The durable
    // guarantee is that there is nothing to pass: a caller that still tries is
    // refused by the strict schema rather than silently ignored, which is the
    // difference between a retired flag and one that quietly does nothing.
    const claim = vi.fn(async () => ({ seq: 7 }))
    const c = { issues: { claim: { mutate: claim } } } as any
    await runIssueCli(['claim', '--id', '7'], c)
    expect(claim).toHaveBeenCalledWith({ id: '7' })
    await expect(runIssueCli(['claim', '--id', '7', '--assignee', 'someone'], c)).rejects.toThrow()
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

/**
 * POD-3836. `podium issue` already rejected an unknown flag LATE, through its
 * strict zod schemas, with `unrecognized_keys`. Two things were still wrong and
 * both are the same bug: the message named no alternative, and the parser's
 * hand-maintained boolean list could disagree with the schema — a boolean the
 * list forgot ate the next token as its value (POD-1545).
 */
describe('unknown flags on podium issue', () => {
  const client = {} as never

  it('names the nearest declared flag', async () => {
    await expect(runIssueCli(['update', '--id', '5', '--priorty', '1'], client)).rejects.toThrow(
      /unknown flag --priorty \(did you mean --priority\?\)/,
    )
  })

  it('refuses before any request is made', async () => {
    const query = vi.fn()
    await expect(
      runIssueCli(['show', '--id', '5', '--audience', 'human'], {
        issues: { get: { query } },
      } as never),
    ).rejects.toThrow(/unknown flag --audience/)
    expect(query).not.toHaveBeenCalled()
  })

  it('reports an unknown COMMAND as such, not as an unknown flag on it', async () => {
    await expect(runIssueCli(['bogus', '--id', '5'], client)).rejects.toThrow(
      /unknown command: bogus/,
    )
  })

  it('reads a boolean flag off the schema, so it never swallows the next token', () => {
    // `recursive` is z.boolean() on `children`; the token after it is a positional.
    const { args, positionals } = parseIssueArgs(['children', '--recursive', '7'])
    expect(args).toMatchObject({ recursive: true })
    expect(positionals).toEqual(['7'])
  })

  it('still accepts the dispatcher-owned globals on every command', () => {
    const { args } = parseIssueArgs(['list', '--json', '--outside-scope'])
    expect(args).toMatchObject({ json: true, outsideScope: true })
  })
})

/**
 * PDM-427: NUMERIC FLAGS IN THE SPACE-SEPARATED FORM.
 *
 * `flagsFromZodShape` called a key value-LESS iff its schema accepted `true` and
 * rejected every probe in a list that held no numeric string. `z.coerce.number()`
 * coerces `true` to 1 (so it "accepts true") and rejects `a-value`/`true`/`false`
 * — so a count, cursor or index flag was classified a boolean WHENEVER its range
 * admits 1, and `--limit 3` parsed as `limit: true` with `3` left on the floor.
 * (A schema whose bounds exclude 1 rejects `true` too, so it was never affected;
 * that is the boundary of the defect, not an untested corner.)
 *
 * Two harms, and the second is the worse one:
 *   - the value is dropped and a DEFAULT is substituted, silently;
 *   - the orphaned value becomes the next POSITIONAL, so `todo --done 2 PDM-1`
 *     addresses issue `2`. A redirected subject reads as your own.
 *
 * And `issue events` PRINTS the space form in its own "Next page:" hint, so an
 * operator following the tool's instruction pages forever over one window.
 */
describe('space-separated numeric flags (PDM-427)', () => {
  it('honours events --since and --limit in the space form', () => {
    const { command, args, positionals } = parseIssueArgs([
      'events',
      '--since',
      '240000',
      '--limit',
      '3',
    ])
    expect(command).toBe('events')
    expect(args.since).toBe('240000')
    expect(args.limit).toBe('3')
    expect(positionals).toEqual([])
  })

  it('honours tree --max-nodes in the space form', () => {
    const { args, positionals } = parseIssueArgs(['tree', 'PDM-107', '--max-nodes', '500'])
    expect(args.maxNodes).toBe('500')
    expect(positionals).toEqual(['PDM-107'])
  })

  it('does not redirect a space-form value onto the next positional', () => {
    // The id positional must stay PDM-1. Before the fix `done` was value-less,
    // so `2` fell through to the positionals and became the ISSUE REF.
    const { args, positionals } = parseIssueArgs(['todo', '--done', '2', 'PDM-1'])
    expect(args.done).toBe('2')
    expect(positionals).toEqual(['PDM-1'])
  })

  it('leaves genuine boolean flags value-less', () => {
    // The counterpart the fix must not break: a real boolean still takes no
    // value, and a tri-state flag still reads the word after it.
    const { args, positionals } = parseIssueArgs(['todo', 'PDM-1', '--clear'])
    expect(args.clear).toBe(true)
    expect(positionals).toEqual(['PDM-1'])
  })

  /**
   * The derived census. Enumerated from the registries rather than listed, so a
   * numeric flag added tomorrow is covered without anyone remembering to add it
   * — a hand-written list of "where numeric flags live" is the exact blind spot
   * this defect came from.
   */
  const REGISTRIES: [string, readonly { name: string; args: unknown }[]][] = [
    ['issue', ISSUE_COMMANDS],
    ['spec', SPEC_COMMANDS],
    ['lock', LOCK_COMMANDS],
  ]

  /**
   * Every `<tool> <command> --<flag>` in the three registries above whose schema
   * accepts the string "1".
   *
   * THE POPULATION IS EXACTLY THAT, and the assertion below must not be read
   * wider. It is NOT every numeric flag (one whose range excludes 1 is absent),
   * NOT every value-taking flag (a string flag that refuses "1" is absent), and
   * NOT a proof about schemas nobody has written yet. It IS an exhaustive walk
   * of the registries that feed `flagsFromZodShape`, over the population where
   * the demonstrated `true`-coerces-to-1 defect can occur at all — which is why
   * it covers the reported flags, pinned by name in the test above it.
   *
   * "1" and not "7": `--priority` is `min(0).max(4)`, so a 7 is refused by the
   * RANGE and the flag drops out of the population entirely — a probe sized for
   * convenience that quietly excludes the flags with the tightest bounds. Any
   * value a coercing schema accepts for `true` it also accepts for "1", because
   * `true` coerces to 1, so "1" is the widest probe this defect can have.
   */
  function flagsAcceptingOne(): { row: string; valueLess: boolean }[] {
    const out: { row: string; valueLess: boolean }[] = []
    for (const [tool, cmds] of REGISTRIES) {
      for (const cmd of cmds) {
        const shape =
          (cmd.args as { shape?: Record<string, { safeParse(v: unknown): { success: boolean } }> })
            .shape ?? {}
        const valueLessKeys = registryFlags(cmd).booleans
        for (const [key, field] of Object.entries(shape)) {
          if (!field.safeParse('1').success) continue
          out.push({ row: `${tool} ${cmd.name} --${key}`, valueLess: valueLessKeys.has(key) })
        }
      }
    }
    return out
  }

  it('examines the flags this defect was reported on', () => {
    // Verify the instrument before trusting a green from it: a census that
    // silently covered nothing would pass the assertion below for free.
    const rows = flagsAcceptingOne().map((f) => f.row)
    expect(rows).toContain('issue events --since')
    expect(rows).toContain('issue events --limit')
    expect(rows).toContain('issue tree --maxNodes')
    expect(rows).toContain('issue todo --done')
    expect(rows.length).toBeGreaterThan(20)
  })

  it('classifies no "1"-accepting flag as value-less, across the three derived registries', () => {
    expect(flagsAcceptingOne().filter((f) => f.valueLess)).toEqual([])
  })
})

/**
 * PDM-427, acceptance 3: THE PRINTED HINT MUST MATCH WHAT THE CLI HONOURS.
 *
 * `issue events` prints its own "Next page:" invocation when it truncates, in
 * the space-separated form. That is the part that made the parser defect a trap
 * rather than a quirk: an operator following the tool's instruction got the same
 * window back forever and reasonably concluded the feed had no recent rows.
 *
 * So the assertion takes the tokens OUT OF THE RENDERED TEXT and parses them,
 * rather than restating the spelling the hint is believed to use — a restated
 * literal drifts away from the printed one the first time either is edited.
 */
describe('the events paging hint round-trips (PDM-427)', () => {
  const events = ISSUE_COMMANDS.find((c) => c.name === 'events')

  /** Run `events` against a stub that always returns a FULL page, so it truncates. */
  async function renderFullPage(argv: string[]): Promise<string> {
    const { args } = parseIssueArgs(['events', ...argv])
    const parsed = (events?.args as { parse(v: unknown): Record<string, unknown> }).parse(args)
    const limit = (parsed.limit as number | undefined) ?? 200
    const since = (parsed.since as number) ?? 0
    const client = {
      issues: {
        events: {
          query: async () =>
            Array.from({ length: limit }, (_, i) => ({
              id: since + i + 1,
              ts: '2026-09-13T00:00:00.000Z',
              kind: 'issue.read',
              subject: 'iss_stub',
              payload: {},
            })),
        },
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: a stub standing in for IssueTrpc.
    const out = await events?.run(client as any, parsed)
    return out?.text ?? ''
  }

  it('prints a next-page invocation whose flags the CLI actually honours', async () => {
    const text = await renderFullPage(['--since', '240000', '--limit', '3'])
    const hint = text.split('\n').find((l) => l.includes('Next page:'))
    expect(hint).toBeDefined()

    // Take the invocation from the OUTPUT, not from a literal restated here.
    const line = hint ?? ''
    const tokens = line.slice(line.indexOf('podium issue events')).split(/\s+/).slice(3)
    expect(tokens).toContain('--since')
    expect(tokens).toContain('--limit')

    const replay = parseIssueArgs(['events', ...tokens])
    // The cursor must ADVANCE past the last row the page showed, and the page
    // size must survive. Before the fix both became `true` and the replay asked
    // for the default window again.
    expect(replay.args.since).toBe('240003')
    expect(replay.args.limit).toBe('3')
    expect(replay.positionals).toEqual([])
  })

  it('prints a tree More: invocation whose flags the CLI actually honours', async () => {
    // The SECOND printed invocation in the registry, and the same trap: both its
    // caps are space-separated numeric flags.
    const tree = ISSUE_COMMANDS.find((c) => c.name === 'tree')
    const client = {
      issues: {
        tree: {
          query: async () => ({
            root: {
              seq: 107,
              priority: 1,
              stage: 'in_progress',
              title: 'root',
              closed: false,
              blocked: false,
              ready: true,
              blocksDeps: [],
              needsHuman: false,
              children: [],
              omittedChildren: 4,
              sessions: [],
            },
            totalNodes: 100,
            omitted: 4,
            maxDepth: 3,
            maxNodes: 100,
          }),
        },
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: a stub standing in for IssueTrpc.
    const out = await tree?.run(client as any, { id: 'PDM-107' })
    const hint = (out?.text ?? '').split('\n').find((l) => l.includes('More:'))
    expect(hint).toBeDefined()

    const line = hint ?? ''
    const tokens = line.slice(line.indexOf('podium issue tree')).split(/\s+/).slice(3)
    const replay = parseIssueArgs(['tree', ...tokens])
    expect(replay.args.maxDepth).toBe('6')
    expect(replay.args.maxNodes).toBe('400')
    expect(replay.positionals).toEqual(['PDM-107'])
  })

  it('renders numeric flags in help with a value placeholder', () => {
    // The same "printed form matches honoured form" obligation, one layer up:
    // `commandHelpText` omits `<value>` for anything the classifier calls
    // value-less, so under the defect `--limit` advertised itself as a switch.
    const help = commandHelpText('issue', events as Parameters<typeof commandHelpText>[1])
    expect(help).toContain('--limit <value>')
    expect(help).toContain('--since <value>')
  })
})
