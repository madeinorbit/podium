import type { SessionId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ASK_USER_GATE_DEADLINE_MS,
  type AskUserGate,
  askUserHookResponse,
  askUserRefusal,
  isAskUserTool,
} from './ask-user-gate.js'

const S = 'sess-below' as SessionId
const REFUSAL = 'Asking the user is not available: ask POD-7'
const refuse: AskUserGate = async () => REFUSAL

// The payload shapes the real CLIs POSTed to the hook (RUN 2026-10-14):
// Claude 2.1.299 sends snake_case only; Grok 1.0.52 sends both spellings.
const claudePre = (tool: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_input: {},
  session_id: 'native',
})
const grokPre = (tool: string) => ({
  hook_event_name: 'PreToolUse',
  hookEventName: 'pre_tool_use',
  tool_name: tool,
  toolName: tool,
})

describe('the ask-the-user gate (POD-6108)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('names the tools that wait on a person, and nothing else', () => {
    for (const tool of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'ask_user_question', 'exit_plan_mode', 'request_user_input']) {
      expect(isAskUserTool(tool), tool).toBe(true)
    }
    for (const tool of ['Bash', 'Read', 'question', 'mcp__podium__ask', undefined]) {
      expect(isAskUserTool(tool), String(tool)).toBe(false)
    }
  })

  it('denies a Claude PreToolUse with the hookSpecificOutput shape', async () => {
    const body = await askUserHookResponse(refuse, S, claudePre('AskUserQuestion'))
    expect(JSON.parse(body ?? 'null')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: REFUSAL,
      },
    })
  })

  it('denies a Grok PreToolUse with its decision/reason shape', async () => {
    const body = await askUserHookResponse(refuse, S, grokPre('exit_plan_mode'))
    expect(JSON.parse(body ?? 'null')).toEqual({ decision: 'deny', reason: REFUSAL })
  })

  it('leaves every other hook alone without asking the gate', async () => {
    const gate = vi.fn(refuse)
    expect(await askUserHookResponse(gate, S, claudePre('Bash'))).toBeNull()
    expect(await askUserHookResponse(gate, S, { hook_event_name: 'Stop' })).toBeNull()
    expect(await askUserHookResponse(undefined, S, claudePre('AskUserQuestion'))).toBeNull()
    expect(gate).not.toHaveBeenCalled()
  })

  it('lets the ask through when the session may talk to the user', async () => {
    expect(await askUserHookResponse(async () => null, S, claudePre('AskUserQuestion'))).toBeNull()
  })

  it('fails open when the gate throws or cannot answer in time', async () => {
    expect(await askUserRefusal(async () => { throw new Error('relay down') }, S)).toBeNull()
    vi.useFakeTimers()
    const hung = askUserRefusal(() => new Promise<string>(() => {}), S)
    await vi.advanceTimersByTimeAsync(ASK_USER_GATE_DEADLINE_MS)
    await expect(hung).resolves.toBeNull()
  })
})
