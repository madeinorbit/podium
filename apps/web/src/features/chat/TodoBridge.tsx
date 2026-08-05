import type { SessionMeta } from '@podium/model'
import { ListChecks } from 'lucide-react'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { OPEN_RIGHT_PANEL_EVENT } from '@/app/shell-state'
import { useReplicaIssues } from '@/app/store'

/**
 * THE TODO BRIDGE (POD-413) — chat points at the plan; it does not keep a copy.
 *
 * Agents already publish structured todos and the issue dock already renders
 * them with a progress bar and human-checkable boxes (`IssuePanelView.tsx`).
 * The reader in chat had no idea any of that existed. So this file is a BRIDGE
 * and deliberately nothing more: a count, and a way to get to the list.
 *
 * The rule (teardown 4.3, the human's call): THE PANEL OWNS PLANS, CHAT POINTS
 * AT THEM. A second, read-only copy of the list inside the transcript would be
 * exactly the duplication the redesign is trying to remove — two places to read,
 * one of which you cannot tick.
 *
 * Two surfaces, one source:
 *
 *  - {@link TodoRailChip} — a live `4/7` in the reading rail, present only while
 *    the issue has todos, and the whole of its behaviour is "open the panel".
 *  - {@link OpenTodosNotice} — one line at the end of the transcript when the
 *    agent stopped with work still on the list.
 */

export interface TodoProgress {
  done: number
  total: number
  open: number
}

/**
 * Todo progress for the issue this session belongs to, or null when there is no
 * issue or it has published no todos.
 *
 * Read from the SAME `issue.panel.todos` the dock renders, rather than from
 * anything session-local, so the rail's `4/7` and the panel's checkboxes cannot
 * drift: tick a box in the panel and the chip moves in the same frame.
 */
export function useIssueTodos(session: SessionMeta | undefined): TodoProgress | null {
  const issues = useReplicaIssues()
  const issueId = session?.issueId
  return useMemo(() => {
    if (!issueId) return null
    const todos = issues.find((i) => i.id === issueId)?.panel?.todos ?? []
    if (todos.length === 0) return null
    const done = todos.filter((t) => t.done).length
    return { done, total: todos.length, open: todos.length - done }
  }, [issues, issueId])
}

/** Ask the shell to reveal the issue dock, where the todos are checkable. */
export function openTodoPanel(): void {
  window.dispatchEvent(new CustomEvent(OPEN_RIGHT_PANEL_EVENT, { detail: 'issue' }))
}

/**
 * Did this session stop with work still on the list?
 *
 * `open_todos` is a first-class idle verdict in the session model — but no
 * shipped reducer produces it: `claude-code.ts` maps its own
 * `idle.needs_input.open_todo_list` label to `{ kind: 'done' }`, and
 * `AgentStateEvent` says outright that the reducer never invents the kind. So
 * keying this notice on the verdict alone would render it exactly never.
 *
 * The honest signal is the one we can actually observe: the agent is IDLE and
 * the plan it published still has open items. The verdict is still honoured
 * first, so a harness that starts emitting it lights this up for free.
 */
export function stoppedWithOpenTodos(input: {
  session: SessionMeta | undefined
  todos: TodoProgress | null
  working: boolean
}): boolean {
  const { session, todos, working } = input
  if (working || !todos || todos.open === 0) return false
  const state = session?.agentState
  if (state?.idle?.kind === 'open_todos') return true
  return state?.phase === 'idle'
}

/**
 * The rail's live count. A fraction stacked rather than written `4/7`: the rail
 * is 24px wide, and a two-line fraction is both narrower and read faster than a
 * slashed one at 9px.
 */
export function TodoRailChip({ todos }: { todos: TodoProgress }): JSX.Element {
  return (
    <button
      data-pressable
      type="button"
      className="chat-rail-todo"
      data-open={todos.open > 0 ? 'true' : undefined}
      title={`${todos.done} of ${todos.total} todos done — open the plan`}
      aria-label={`${todos.done} of ${todos.total} todos done. Open the plan.`}
      onClick={openTodoPanel}
    >
      <span className="chat-rail-todo-n">{todos.done}</span>
      <span className="chat-rail-todo-rule" aria-hidden="true" />
      <span className="chat-rail-todo-n">{todos.total}</span>
    </button>
  )
}

/**
 * One line at the end of the transcript, and only when it is true. It names the
 * remainder and hands over — it does not list the items, because the panel one
 * click away lists them and can tick them.
 */
export function OpenTodosNotice({ todos }: { todos: TodoProgress }): JSX.Element {
  return (
    <button
      data-pressable
      type="button"
      className="chat-todo-notice"
      onClick={openTodoPanel}
      title="Open the issue panel, where the todos are checkable"
    >
      <ListChecks size={12} aria-hidden="true" className="flex-none" />
      <span>
        Stopped with{' '}
        <strong className="font-medium text-foreground">
          {todos.open} of {todos.total}
        </strong>{' '}
        todos still open
      </span>
      <span className="chat-todo-notice-go">Open the plan</span>
    </button>
  )
}
