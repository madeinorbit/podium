/**
 * THE MAPPING LAYER (POD-1761 W6).
 *
 * `threadItemToItems` is the one piece of this driver with no sibling to lean
 * on: `packages/transcript`'s codex mapper parses ROLLOUT JSONL, and the
 * app-server speaks a different, higher-level vocabulary (`ThreadItem`). The
 * reasoning for writing a second mapper rather than reusing the first is in
 * ./map.ts; this is the coverage that keeps it honest, because a transcript
 * mapper that quietly drops an arm produces an empty chat rather than an error.
 */

import { describe, expect, it } from 'vitest'
import type { PendingInteraction } from '../../interactions.js'
import {
  answerAction,
  askIdOf,
  commandApprovalAsk,
  describeTurnError,
  statusToStateEvent,
  threadItemToItems,
  turnStatusToVerdict,
} from './map.js'

const AT = '2026-08-14T12:00:00.000Z'

describe('thread items → transcript items', () => {
  it('maps a user message from its content parts', () => {
    const items = threadItemToItems(
      {
        type: 'userMessage',
        id: 'u1',
        content: [{ type: 'text', text: 'do the thing', text_elements: [] }],
      },
      AT,
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'u1', role: 'user', text: 'do the thing' })
  })

  it('marks the FINAL answer, using Codex own phase rather than inferring it', () => {
    /**
     * Codex distinguishes the message that ended the turn (`final_answer`) from
     * the narration it emits between tool calls (`commentary`). That is exactly
     * what `answer` means on a TranscriptItem, and this is the rare provider
     * that marks it — so it is copied rather than guessed.
     */
    const commentary = threadItemToItems(
      { type: 'agentMessage', id: 'm1', text: 'working on it', phase: 'commentary' },
      AT,
    )
    expect(commentary[0]?.answer).toBeUndefined()
    const final = threadItemToItems(
      { type: 'agentMessage', id: 'm2', text: 'here it is', phase: 'final_answer' },
      AT,
    )
    expect(final[0]).toMatchObject({ role: 'assistant', text: 'here it is', answer: true })
  })

  it('drops an EMPTY agent message rather than emitting a blank bubble', () => {
    // `item/started` for a message carries `text: ''` — the item exists before
    // the model has said anything. An empty bubble in chat is worse than no
    // bubble, and the `item/completed` that follows carries the real text.
    expect(threadItemToItems({ type: 'agentMessage', id: 'm3', text: '' }, AT)).toHaveLength(0)
  })

  it('carries a command execution with its output as one tool item', () => {
    /**
     * ONE ITEM, NOT TWO. Codex updates a command item IN PLACE: the started form
     * has no output, the completed form has it. Emitting a separate result item
     * would pair a call with a result the transcript already contains.
     */
    const items = threadItemToItems(
      {
        type: 'commandExecution',
        id: 'exec-1',
        command: "/bin/bash -lc 'ls -la'",
        cwd: '/work',
        status: 'completed',
        aggregatedOutput: 'total 0\n',
      },
      AT,
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      role: 'tool',
      toolName: 'Bash',
      toolInput: "/bin/bash -lc 'ls -la'",
      toolUseId: 'exec-1',
      toolResult: 'total 0\n',
    })
    expect(items[0]?.toolPaths).toEqual(['/work'])
  })

  it('omits the RESULT while the command is still running', () => {
    const items = threadItemToItems(
      {
        type: 'commandExecution',
        id: 'exec-2',
        command: 'sleep 10',
        status: 'inProgress',
        aggregatedOutput: null,
      },
      AT,
    )
    expect(items[0]?.toolResult).toBeUndefined()
  })

  it('names an MCP tool by SERVER AND TOOL, because a bare name is ambiguous', () => {
    // Two servers can both expose `search`; a bare name hides which one ran.
    const items = threadItemToItems(
      {
        type: 'mcpToolCall',
        id: 'mcp-1',
        server: 'podium',
        tool: 'search',
        arguments: { q: 'x' },
        status: 'completed',
      },
      AT,
    )
    expect(items[0]?.toolName).toBe('podium/search')
  })

  it('carries a file change with the paths it touched', () => {
    const items = threadItemToItems(
      {
        type: 'fileChange',
        id: 'fc-1',
        changes: [{ path: '/work/a.ts' }, { path: '/work/b.ts' }],
        status: 'completed',
      },
      AT,
    )
    expect(items[0]?.toolPaths).toEqual(['/work/a.ts', '/work/b.ts'])
  })

  it('maps an arm it has never seen to NOTHING, rather than to a placeholder', () => {
    /**
     * An unmapped arm costs an absent item. A guessed one puts a line in the
     * user's chat that misdescribes what the agent did, and a reader cannot tell
     * the two apart afterwards. `reasoning` is skipped for the same reason the
     * rollout mapper skips it: model-internal, not chat.
     */
    expect(
      threadItemToItems({ type: 'reasoning', id: 'r1', summary: [], content: [] }, AT),
    ).toEqual([])
    expect(threadItemToItems({ type: 'somethingCodexAddedLastWeek', id: 'x1' }, AT)).toEqual([])
  })
})

describe('thread status → the shared state vocabulary', () => {
  it('reports `waitingOnApproval` as NEEDS-USER, not as activity', () => {
    /**
     * THE FLAG THAT CHANGES THE MEANING OF `active`. A thread parked on an
     * approval is not computing — the user is what it is waiting for — and a
     * badge reading "working" tells them to wait for an agent that is waiting for
     * them.
     */
    expect(
      statusToStateEvent({ type: 'active', activeFlags: ['waitingOnApproval'] }, AT),
    ).toMatchObject({ kind: 'needs_user', need: 'permission' })
  })

  it('reports a plain `active` as activity', () => {
    expect(statusToStateEvent({ type: 'active', activeFlags: [] }, AT)).toMatchObject({
      kind: 'activity',
    })
  })

  it('maps `idle` to NOTHING, so a turn is fenced only by turn/completed', () => {
    /**
     * Codex signals end-of-turn twice and only the second carries the verdict.
     * Folding the first into a turn completion would close an epoch before its
     * verdict was known — and fences are absorbing, so it would never reopen.
     */
    expect(statusToStateEvent({ type: 'idle' }, AT)).toBeNull()
  })
})

describe('turn verdicts', () => {
  it('takes `interrupted` from the PROVIDER rather than inferring it', () => {
    // Unlike the opencode driver, this one never has to guess whether an
    // interrupt took effect: Codex says so.
    expect(turnStatusToVerdict('interrupted', false)).toBe('interrupted')
  })

  it('calls a turn that ended with an open ask an APPROVAL, not a completion', () => {
    expect(turnStatusToVerdict('completed', true)).toBe('approval')
    expect(turnStatusToVerdict('completed', false)).toBe('done')
  })
})

describe('turn errors → the failure vocabulary', () => {
  it('classifies what it can recognize', () => {
    expect(describeTurnError({ message: 'rate limit exceeded' })).toMatchObject({
      reason: 'rate-limit',
      disposition: 'retryable',
    })
    expect(describeTurnError({ message: 'unauthorized' })).toMatchObject({
      reason: 'auth-expired',
      // ROUTED TO A HUMAN, which is what materializes it as a `login`
      // interaction rather than leaving the session silently stopped.
      disposition: 'needs-human',
    })
  })

  it('treats an unrecognizable failure as RETRYABLE, never as fatal', () => {
    // A failure we cannot classify is still a failure; guessing `fatal` would
    // end a session a retry might have saved.
    expect(describeTurnError({ message: 'the vibes were off' })).toMatchObject({
      reason: 'provider-error',
      disposition: 'retryable',
    })
    expect(describeTurnError(undefined)).toMatchObject({ disposition: 'retryable' })
  })
})

describe('answers', () => {
  const OFFERS_ACCEPT_CANCEL = ['accept', 'cancel'] as const
  const OFFERS_FULL = ['accept', 'acceptForSession', 'decline', 'cancel'] as const

  const ask = (offers: readonly unknown[]): PendingInteraction =>
    commandApprovalAsk({
      requestId: 0,
      sessionId: 'sess',
      params: {
        threadId: 't',
        turnId: 'tu',
        itemId: 'i',
        command: 'ls',
        availableDecisions: [...offers],
      },
      askedAt: AT,
    })

  it('uses the JSON-RPC request id as the ask id, stringified', () => {
    // Zero is a real id, and `String(0)` is `'0'` — the driver's namespace IS the
    // connection's request-id space, because replying means answering that id.
    expect(askIdOf(0)).toBe('0')
    expect(ask(OFFERS_ACCEPT_CANCEL).id).toBe('0')
  })

  it('sends `accept` for an allow, when accept is on offer', () => {
    expect(
      answerAction(
        ask(OFFERS_ACCEPT_CANCEL),
        { kind: 'permission', decision: 'allow-once' },
        OFFERS_ACCEPT_CANCEL,
      ),
    ).toEqual({ call: 'respond', result: { decision: 'accept' } })
  })

  it('sends `decline` for a deny when the ask offers one', () => {
    expect(
      answerAction(ask(OFFERS_FULL), { kind: 'permission', decision: 'deny' }, OFFERS_FULL),
    ).toEqual({ call: 'respond', result: { decision: 'decline' } })
  })

  it('FALLS BACK TO `cancel` for a deny the ask did not offer `decline` for', () => {
    /**
     * THE RECORDED LIVE ASK OFFERED `['accept', {execpolicy amendment}, 'cancel']`
     * — no `decline`. This arm used to send `decline` anyway while the
     * always-allow arm right beside it refused precisely because the field said
     * the option was not on offer; only one of those can be right.
     *
     * It matters more than the always-allow case because of the DIRECTION of the
     * message: our answer is a JSON-RPC response to a request the server is
     * blocked on, so the server has no channel to reject it. A decision it does
     * not accept is not an error anyone sees — it is a turn that quietly does the
     * wrong thing while Podium reports the deny delivered.
     *
     * `cancel` is the honest substitute rather than a convenient one: it is also
     * a refusal to run the command, and it IS on offer.
     */
    expect(
      answerAction(
        ask(OFFERS_ACCEPT_CANCEL),
        { kind: 'permission', decision: 'deny' },
        OFFERS_ACCEPT_CANCEL,
      ),
    ).toEqual({ call: 'respond', result: { decision: 'cancel' } })
  })

  it('REFUSES a deny when the ask offered neither refusal, leaving it open', () => {
    // Nothing to say that the server agreed to hear. Refusing leaves the ask
    // open and the session visibly blocked, which beats sending a decision the
    // server never offered and reporting it as delivered.
    const action = answerAction(ask(['accept']), { kind: 'permission', decision: 'deny' }, [
      'accept',
    ])
    expect(action.call).toBe('refuse')
    if (action.call === 'refuse') expect(action.refusal.reason).toBe('unsupported')
  })

  it('REFUSES an always-allow the ask did not offer', () => {
    const action = answerAction(
      ask(OFFERS_ACCEPT_CANCEL),
      { kind: 'permission', decision: 'allow-always' },
      OFFERS_ACCEPT_CANCEL,
    )
    expect(action.call).toBe('refuse')
    // Sending `accept` instead would report a persistent grant that was never
    // made — the protocol's own PermissionAnswer note names this case.
    if (action.call === 'refuse') expect(action.refusal.reason).toBe('unsupported')
  })

  it('sends `acceptForSession` when it WAS offered', () => {
    const offered = ask(OFFERS_FULL)
    // The offer is READ OFF `availableDecisions`, not assumed — see ./map.ts.
    expect(offered.kind).toBe('permission')
    if (offered.kind !== 'permission') return
    expect(offered.payload.canAlwaysAllow).toBe(true)
    expect(
      answerAction(offered, { kind: 'permission', decision: 'allow-always' }, OFFERS_FULL),
    ).toEqual({ call: 'respond', result: { decision: 'acceptForSession' } })
  })

  it('answers a permission-profile approval with the requested grant at turn scope', () => {
    const request = {
      requested: {
        network: { enabled: true },
        fileSystem: { read: ['/repo'], write: ['/repo/tmp'] },
      },
    }
    expect(
      answerAction(
        ask(OFFERS_FULL),
        { kind: 'permission', decision: 'allow-once' },
        undefined,
        request,
      ),
    ).toEqual({
      call: 'respond',
      result: { permissions: request.requested, scope: 'turn' },
    })
  })

  it('denies a permission-profile approval by granting no additional permissions', () => {
    expect(
      answerAction(ask(OFFERS_FULL), { kind: 'permission', decision: 'deny' }, undefined, {
        requested: { network: { enabled: true } },
      }),
    ).toEqual({
      call: 'respond',
      result: { permissions: {}, scope: 'turn' },
    })
  })
  it('REFUSES an answer whose kind does not match the ask', () => {
    // The discriminants exist so a mismatch is caught before it reaches a
    // provider, not after.
    const action = answerAction(
      ask(OFFERS_FULL),
      { kind: 'recovery', choice: 'full-resume' },
      OFFERS_FULL,
    )
    expect(action.call).toBe('refuse')
  })
})
