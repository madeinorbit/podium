import type { DeterministicAgentState, GlobalAgentStateLabel } from './deterministic.js'
import { resolvedState, semanticState } from './deterministic.js'

export const CLAUDE_INTERRUPT_MARKER = '[Request interrupted by user]'

type RecordLike = Record<string, unknown>

type ClaudeToolUse = {
  id?: string
  name: string
  input?: unknown
}

type ClaudeToolResult = {
  id?: string
  content: string
  isError: boolean
}

export interface ClaudeTranscriptFeatures {
  realUserTurns: number
  lastUserMessage: string
  lastAssistantText: string
  lastAssistantStopReason: string | null
  terminalInterrupt: boolean
  terminalEvent: 'assistant_text' | 'tool_use' | 'tool_result' | 'user_text' | null
  terminalToolName: string | null
  unresolvedTools: { id?: string; name: string; summary?: unknown }[]
  currentAskUserQuestions: { id?: string; question?: string; options?: string[] }[]
  openTodoCount: number
  launchedBackgroundAgent: boolean
  launchedBackgroundShell: boolean
  foregroundShellCommands: { command?: string; runInBackground: boolean }[]
  backgroundShellCommands: { command?: string; runInBackground: boolean }[]
  agentCalls: { description?: string; runInBackground: boolean }[]
  errors: string[]
  permissionMode: unknown
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function clip(text: string, max = 240): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

function contentBlocks(record: unknown): unknown[] {
  if (!isRecord(record)) return []
  const message = isRecord(record.message) ? record.message : undefined
  const content = message?.content
  return Array.isArray(content) ? content : []
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!isRecord(block)) return ''
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function recordText(record: unknown): string {
  if (!isRecord(record)) return ''
  const message = isRecord(record.message) ? record.message : undefined
  return textFromContent(message?.content)
}

function isAssistantRecord(record: unknown): boolean {
  return isRecord(record) && record.type === 'assistant'
}

function isToolResultOnlyUser(record: unknown): boolean {
  return contentBlocks(record).some((block) => isRecord(block) && block.type === 'tool_result')
}

function isSystemInjectedUser(record: unknown): boolean {
  if (!isRecord(record)) return false
  return record.type === 'user' && record.promptSource === 'system'
}

function isRealUserRecord(record: unknown): boolean {
  if (!isRecord(record) || record.type !== 'user') return false
  if (isSystemInjectedUser(record)) return false
  if (isToolResultOnlyUser(record)) return false
  return recordText(record).length > 0
}

function toolUses(record: unknown): ClaudeToolUse[] {
  if (!isAssistantRecord(record)) return []
  const out: ClaudeToolUse[] = []
  for (const block of contentBlocks(record)) {
    if (!isRecord(block) || block.type !== 'tool_use') continue
    const name = str(block.name)
    if (!name) continue
    out.push({
      ...(str(block.id) ? { id: str(block.id) } : {}),
      name,
      ...(block.input !== undefined ? { input: block.input } : {}),
    })
  }
  return out
}

function toolResults(record: unknown): ClaudeToolResult[] {
  if (!isRecord(record) || record.type !== 'user') return []
  const out: ClaudeToolResult[] = []
  for (const block of contentBlocks(record)) {
    if (!isRecord(block) || block.type !== 'tool_result') continue
    out.push({
      ...(str(block.tool_use_id) ? { id: str(block.tool_use_id) } : {}),
      content: textFromContent(block.content),
      isError: block.is_error === true,
    })
  }
  return out
}

function commandSummary(input: unknown): { command?: string; runInBackground: boolean } {
  const i = isRecord(input) ? input : undefined
  return {
    ...(str(i?.command) ? { command: clip(str(i?.command) ?? '', 220) } : {}),
    runInBackground: i?.run_in_background === true || i?.runInBackground === true,
  }
}

function agentSummary(input: unknown): { description?: string; runInBackground: boolean } {
  const i = isRecord(input) ? input : undefined
  return {
    ...(str(i?.description) ? { description: clip(str(i?.description) ?? '', 220) } : {}),
    runInBackground: i?.run_in_background === true || i?.background === true,
  }
}

function askUserSummary(input: unknown): { question?: string; options?: string[] } {
  const i = isRecord(input) ? input : undefined
  const first = Array.isArray(i?.questions) ? i.questions.find(isRecord) : undefined
  const options = Array.isArray(first?.options)
    ? first.options
        .map((option) => {
          if (typeof option === 'string') return option
          if (isRecord(option)) return str(option.label) ?? str(option.value) ?? ''
          return ''
        })
        .filter(Boolean)
    : []
  return {
    ...(str(first?.question) ? { question: clip(str(first?.question) ?? '', 300) } : {}),
    ...(options.length > 0 ? { options: options.slice(0, 8) } : {}),
  }
}

function todoCount(input: unknown): number {
  const i = isRecord(input) ? input : undefined
  if (!Array.isArray(i?.todos)) return 0
  return i.todos.filter((todo) => isRecord(todo) && todo.status !== 'completed').length
}

function summarizeTool(tool: ClaudeToolUse): unknown {
  if (tool.name === 'Bash') return commandSummary(tool.input)
  if (tool.name === 'Agent') return agentSummary(tool.input)
  if (tool.name === 'AskUserQuestion') return askUserSummary(tool.input)
  if (tool.name === 'TodoWrite') return { openTodoCount: todoCount(tool.input) }
  return undefined
}

export function extractClaudeTranscriptFeatures(
  records: unknown[],
  permissionMode: unknown,
): ClaudeTranscriptFeatures {
  const realUsers: { index: number; text: string }[] = []
  records.forEach((record, index) => {
    if (!isRealUserRecord(record)) return
    realUsers.push({ index, text: recordText(record) })
  })

  const terminal = [...records].reverse().find((record) => {
    if (!isRecord(record)) return false
    if (record.type !== 'assistant' && record.type !== 'user') return false
    return (
      recordText(record).length > 0 || toolUses(record).length > 0 || toolResults(record).length > 0
    )
  })
  const terminalInterrupt =
    isRecord(terminal) &&
    terminal.type === 'user' &&
    recordText(terminal) === CLAUDE_INTERRUPT_MARKER

  const lastUser = realUsers.at(-1)
  const startIndex = lastUser && !terminalInterrupt ? lastUser.index + 1 : 0
  const unresolved = new Map<string, ClaudeToolUse & { index: number }>()
  const unresolvedNoId: (ClaudeToolUse & { index: number })[] = []
  const currentAskUserQuestions: { id?: string; question?: string; options?: string[] }[] = []
  const foregroundShellCommands: { command?: string; runInBackground: boolean }[] = []
  const backgroundShellCommands: { command?: string; runInBackground: boolean }[] = []
  const agentCalls: { description?: string; runInBackground: boolean }[] = []
  const errors: string[] = []

  let lastAssistantText = ''
  let lastAssistantStopReason: string | null = null
  let terminalEvent: ClaudeTranscriptFeatures['terminalEvent'] = null
  let terminalToolName: string | null = null
  let openTodoCount = 0
  let launchedBackgroundAgent = false
  let launchedBackgroundShell = false

  for (let index = startIndex; index < records.length; index += 1) {
    const record = records[index]
    if (isAssistantRecord(record)) {
      const text = recordText(record)
      if (text) {
        lastAssistantText = text
        const rawMessage = (record as RecordLike).message
        const message: RecordLike | undefined = isRecord(rawMessage) ? rawMessage : undefined
        lastAssistantStopReason = str(message?.stop_reason) ?? null
        terminalEvent = 'assistant_text'
        terminalToolName = null
      }
      for (const tool of toolUses(record)) {
        if (tool.id) unresolved.set(tool.id, { ...tool, index })
        else unresolvedNoId.push({ ...tool, index })
        terminalEvent = 'tool_use'
        terminalToolName = tool.name
        if (tool.name === 'Bash') {
          const summary = commandSummary(tool.input)
          if (summary.runInBackground) backgroundShellCommands.push(summary)
          else foregroundShellCommands.push(summary)
        }
        if (tool.name === 'Agent') {
          const summary = agentSummary(tool.input)
          agentCalls.push(summary)
          if (summary.runInBackground) launchedBackgroundAgent = true
        }
        if (tool.name === 'TodoWrite') openTodoCount = todoCount(tool.input)
      }
    }

    for (const result of toolResults(record)) {
      const pending = result.id ? unresolved.get(result.id) : undefined
      if (result.id) unresolved.delete(result.id)
      terminalEvent = 'tool_result'
      terminalToolName = pending?.name ?? null
      if (pending?.name === 'AskUserQuestion') {
        // resolved; do not carry it as current
      }
      if (result.isError) errors.push(clip(result.content, 500))
      if (/async_launched|background agent|subagent.*launched/i.test(result.content)) {
        launchedBackgroundAgent = true
      }
      if (
        pending?.name === 'Bash' &&
        /background|running asynchronously|process started/i.test(result.content)
      ) {
        launchedBackgroundShell = true
      }
    }

    if (isRealUserRecord(record)) {
      terminalEvent = 'user_text'
      terminalToolName = null
    }
  }

  const unresolvedTools: { id?: string; name: string; summary?: unknown }[] = [
    ...[...unresolved.values()].map((tool) => ({
      ...(tool.id ? { id: tool.id } : {}),
      name: tool.name,
      summary: summarizeTool(tool),
    })),
    ...unresolvedNoId.map((tool) => ({ name: tool.name, summary: summarizeTool(tool) })),
  ]

  for (const tool of unresolvedTools) {
    if (tool.name !== 'AskUserQuestion') continue
    const summary = isRecord(tool.summary) ? tool.summary : undefined
    currentAskUserQuestions.push({
      ...(tool.id ? { id: tool.id } : {}),
      ...(str(summary?.question) ? { question: str(summary?.question) } : {}),
      ...(Array.isArray(summary?.options)
        ? { options: summary.options.filter((x): x is string => typeof x === 'string') }
        : {}),
    })
  }

  return {
    realUserTurns: realUsers.length,
    lastUserMessage: lastUser?.text ?? '',
    lastAssistantText,
    lastAssistantStopReason,
    terminalInterrupt,
    terminalEvent,
    terminalToolName,
    unresolvedTools,
    currentAskUserQuestions,
    openTodoCount,
    launchedBackgroundAgent,
    launchedBackgroundShell,
    foregroundShellCommands,
    backgroundShellCommands,
    agentCalls,
    errors,
    permissionMode,
  }
}

function terminalQuestion(text: string): boolean {
  return /\?\s*(?:$|\n\s*$)/.test(text.slice(-900))
}

function completionLanguage(text: string): boolean {
  return /\b(done|fixed|implemented|complete|completed|committed|verified|merged|ready|summary|result|tests? passed|no further action|nothing else is needed|all set|shipped)\b/i.test(
    text,
  )
}

function doneLike(text: string): boolean {
  return /^(done|fixed|implemented|complete|completed|committed|all set|confirmed|verified|shipped|root cause found|cleanup complete|rebase complete)\b/i.test(
    text.trim(),
  )
}

function optionalFollowup(text: string): boolean {
  return /\b(want me to|would you like me to|shall i also|should i also|if you want|if you'd like|let me know if you want|happy to also|i can also|anything else)\b/i.test(
    text.slice(-900),
  )
}

function requiredUserAction(text: string): boolean {
  return /\b(please run|please authenticate|complete the auth flow|hard-refresh|tell me when|once (?:that|this) is done,? tell me|choose|pick one|which option|which approach|how do you want|what do you want|decision needed|i need you to|you need to|your call|approve|confirm|do you want me to|should i|shall i|want me to (?:proceed|continue|start|run|delete|commit|merge|push|open|implement|apply))\b/i.test(
    text,
  )
}

function explicitErrorStop(text: string, errors: string[]): boolean {
  const combined = [text, ...errors].join('\n')
  return /\b(rate limit|usage limit|overloaded|all providers exhausted|server error|internal server error|\b500\b|\b502\b|\b503\b|auth(?:entication)? failure|billing failure|insufficient credits|context length exceeded)\b/i.test(
    combined,
  )
}

function shellWaitingText(text: string): boolean {
  return (
    /\b(awaiting|waiting on|waiting for|still running|in flight|background)\b.{0,100}\b(shell|bash|command|process|test|tests|suite|server|dev server|build|docker|wrangler|npm|bun|cargo|pytest)\b/i.test(
      text,
    ) ||
    /\b(shell|bash|command|process|test|tests|suite|server|dev server|build|docker|wrangler|npm|bun|cargo|pytest)\b.{0,100}\b(still running|in flight|background|to finish|to complete)\b/i.test(
      text,
    )
  )
}

function subagentWaitingText(text: string): boolean {
  return (
    /\b(awaiting|waiting on|waiting for|still running|in flight|background)\b.{0,120}\b(subagent|sub-agent|agent|reviewer|review|task agent|worker)\b/i.test(
      text,
    ) ||
    /\b(subagent|sub-agent|agent|reviewer|review|task agent|worker)\b.{0,120}\b(still running|in flight|background|verdict|to finish|to complete)\b/i.test(
      text,
    )
  )
}

function genericWorkingText(text: string): boolean {
  return /\b(i(?:'|’)ll continue|i will continue|i(?:'|’)ll report back|i will report back|when it (?:finishes|lands|completes)|continue automatically|will resume|let me do|i(?:'|’)m going to run|i will run)\b/i.test(
    text,
  )
}

function lastMeaningfulLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
}

function candidateLabels(features: ClaudeTranscriptFeatures): GlobalAgentStateLabel[] {
  const text = features.lastAssistantText
  const labels = new Set<GlobalAgentStateLabel>()
  if (
    shellWaitingText(text) ||
    features.launchedBackgroundShell ||
    features.backgroundShellCommands.length
  ) {
    labels.add('working.waiting_on_shell')
  }
  if (
    subagentWaitingText(text) ||
    features.launchedBackgroundAgent ||
    features.agentCalls.some((agent) => agent.runInBackground)
  ) {
    labels.add('working.waiting_on_subagent')
  }
  if (genericWorkingText(text)) labels.add('working')
  if (terminalQuestion(text) || requiredUserAction(text))
    labels.add('idle.needs_input.text_question')
  if (features.openTodoCount > 0) labels.add('idle.needs_input.open_todo_list')
  if (explicitErrorStop(text, features.errors)) labels.add('error')
  labels.add('idle.finished')
  return [...labels]
}

export function classifyClaudeFeatures(
  features: ClaudeTranscriptFeatures,
): DeterministicAgentState {
  const text = features.lastAssistantText
  const unresolved = features.unresolvedTools
  const currentAsk = unresolved.filter((tool) => tool.name === 'AskUserQuestion')
  const pendingShell = unresolved.filter((tool) => tool.name === 'Bash')
  const pendingAgent = unresolved.filter((tool) => tool.name === 'Agent')
  const pendingOther = unresolved.filter(
    (tool) => tool.name && !['AskUserQuestion', 'Bash', 'Agent'].includes(tool.name),
  )

  if (!features.realUserTurns && !text) return resolvedState('new', 'no user or assistant records')
  if (features.terminalInterrupt) {
    return resolvedState('idle.interrupted', 'terminal user interrupt marker', {
      summary: 'request interrupted by user',
    })
  }
  if (features.permissionMode === 'plan') {
    return resolvedState('idle.needs_input.approval', 'plan mode stopped for approval', {
      summary: 'plan awaiting approval',
    })
  }
  if (currentAsk.length > 0) {
    const ask = features.currentAskUserQuestions[0]
    return resolvedState(
      'idle.needs_input.ask_user_tool',
      'current unresolved AskUserQuestion tool',
      {
        ...(ask?.question ? { summary: ask.question } : {}),
      },
    )
  }
  if (pendingAgent.length > 0) {
    return resolvedState('working.waiting_on_subagent', 'unresolved Agent tool call')
  }
  if (pendingShell.length > 0) {
    return resolvedState('working.waiting_on_shell', 'unresolved Bash tool call')
  }
  if (pendingOther.length > 0)
    return resolvedState('working', 'unresolved non-interactive tool call')
  if (features.terminalEvent === 'tool_result') {
    return resolvedState('working', 'latest current-turn event is a tool result')
  }
  if (explicitErrorStop(text, features.errors) && !completionLanguage(text)) {
    return resolvedState('error', 'explicit terminal provider/runtime error', {
      errorClass: 'unknown',
      retryable: true,
    })
  }
  if (subagentWaitingText(text)) {
    return resolvedState(
      'working.waiting_on_subagent',
      'final text explicitly waits on subagent/reviewer',
    )
  }
  if (shellWaitingText(text)) {
    return resolvedState('working.waiting_on_shell', 'final text explicitly waits on shell/process')
  }
  if (genericWorkingText(text) && !requiredUserAction(text)) {
    return semanticState(
      candidateLabels(features),
      'possible autonomous continuation needs semantic judgment',
    )
  }
  if (features.openTodoCount > 0 && !genericWorkingText(text) && !terminalQuestion(text)) {
    return resolvedState(
      'idle.needs_input.open_todo_list',
      'open todo list and no autonomous continuation signal',
    )
  }

  const readsAsComplete = doneLike(text) || completionLanguage(text)
  if (readsAsComplete && optionalFollowup(text)) {
    return resolvedState('idle.finished', 'completed work with optional follow-up only')
  }
  if (requiredUserAction(text)) {
    return resolvedState(
      'idle.needs_input.text_question',
      'final text requires user action or decision',
      {
        ...(lastMeaningfulLine(text) ? { summary: lastMeaningfulLine(text) } : {}),
      },
    )
  }
  if (terminalQuestion(text)) {
    return semanticState(
      candidateLabels(features),
      'terminal non-courtesy question needs semantic judgment',
    )
  }
  if (readsAsComplete || text) {
    return resolvedState(
      'idle.finished',
      'final assistant text has no deterministic current blocker',
    )
  }
  return semanticState(
    candidateLabels(features),
    'ambiguous terminal state after deterministic checks',
  )
}

export function classifyClaudeTranscriptDeterministically(
  records: unknown[],
  permissionMode: unknown,
): DeterministicAgentState {
  return classifyClaudeFeatures(extractClaudeTranscriptFeatures(records, permissionMode))
}
