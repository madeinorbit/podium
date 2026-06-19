/**
 * Golden test: real Codex rollout fixture captured from
 * ~/.codex/sessions/2026/06/17/rollout-2026-06-17T18-33-57-019ed66e-ac3c-71b3-985f-7c34c52b26fc.jsonl
 * (lines 0-32 + lines 235, 237 + one synthetic empty-output case).
 *
 * Expected shape derived by manual inspection of the fixture records:
 *  - session_meta / turn_context / event_msg(task_started|token_count|agent_message) → skip
 *  - response_item role=developer → skip (always permissions preamble)
 *  - response_item role=user lines 3+5 → skip:
 *      line 3 = <environment_context> preamble; line 5 = duplicate of event_msg at line 6
 *  - event_msg user_message (line 6) → user
 *  - response_item reasoning (lines 7,11,15,18,22) → skip
 *  - response_item function_call (lines 8,12,19,25-28) → tool call
 *  - response_item function_call_output (lines 9,13,20,29-32,33) → tool result
 *      line 33 (synthetic) has empty output — must still emit, not vanish
 *  - response_item message role=assistant (lines 17,24) → assistant
 *  - response_item custom_tool_call (line 34) → tool call (apply_patch)
 *  - response_item custom_tool_call_output (line 35) → tool result
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codexRecordToItems } from './codex.js'

const lines = readFileSync(
  new URL('./__fixtures__/codex-rollout.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean)

describe('codexRecordToItems golden fixture', () => {
  it('classifies the captured rollout without dropping messages', () => {
    const items = lines.flatMap((l) => codexRecordToItems(JSON.parse(l)))
    const shape = items.map((i) => ({ role: i.role, tool: i.toolName }))

    expect(shape).toEqual([
      // line 6: event_msg user_message
      { role: 'user', tool: undefined },
      // line 8: function_call exec_command
      { role: 'tool', tool: 'exec_command' },
      // line 9: function_call_output
      { role: 'tool', tool: undefined },
      // line 12: function_call exec_command
      { role: 'tool', tool: 'exec_command' },
      // line 13: function_call_output
      { role: 'tool', tool: undefined },
      // line 17: response_item message role=assistant
      { role: 'assistant', tool: undefined },
      // line 19: function_call update_plan
      { role: 'tool', tool: 'update_plan' },
      // line 20: function_call_output "Plan updated"
      { role: 'tool', tool: undefined },
      // line 24: response_item message role=assistant
      { role: 'assistant', tool: undefined },
      // lines 25-28: parallel function_calls exec_command
      { role: 'tool', tool: 'exec_command' },
      { role: 'tool', tool: 'exec_command' },
      { role: 'tool', tool: 'exec_command' },
      { role: 'tool', tool: 'exec_command' },
      // lines 29-32: parallel function_call_outputs
      { role: 'tool', tool: undefined },
      { role: 'tool', tool: undefined },
      { role: 'tool', tool: undefined },
      { role: 'tool', tool: undefined },
      // line 33: function_call_output with EMPTY output — must still emit (not drop)
      { role: 'tool', tool: undefined },
      // line 34: custom_tool_call apply_patch
      { role: 'tool', tool: 'apply_patch' },
      // line 35: custom_tool_call_output
      { role: 'tool', tool: undefined },
    ])
  })

  it('emits no user items from response_item/message role=user (covered by event_msg)', () => {
    const items = lines.flatMap((l) => codexRecordToItems(JSON.parse(l)))
    const userItems = items.filter((i) => i.role === 'user')
    // Only one user item total — from event_msg, not from the duplicate response_item
    expect(userItems).toHaveLength(1)
  })

  it('does not drop the empty-output function_call_output (orphan result)', () => {
    // The fixture includes one function_call_output with output='' at line 33.
    // It should emit a tool item rather than vanish.
    const emptyOutputLine = lines.find((l) => {
      const r = JSON.parse(l)
      return (
        r?.payload?.type === 'function_call_output' &&
        r?.payload?.call_id === 'call_orphan_empty'
      )
    })
    expect(emptyOutputLine).toBeTruthy()
    const items = codexRecordToItems(JSON.parse(emptyOutputLine!))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ role: 'tool', toolUseId: 'call_orphan_empty' })
  })
})
