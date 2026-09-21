/** Every ignored shape has an explicit reason. Unknown keys become visible effects. */
export const EFFECT_KEYS = new Set([
  'bashEditDiff',
  'structuredPatch',
  'filePath',
  'content',
  'userModified',
  'gitOperation',
  'backgroundTaskId',
  'interrupted',
  'timedOutAfterMs',
  'returnCodeInterpretation',
])
export const IGNORED_EFFECT_KEYS: Record<string, string> = {
  stdout: 'Already carried by tool_result content',
  stderr: 'Already carried by tool_result content; corpus audit verified nonempty values',
  originalFile: 'Applied hunks carry the relevant before image without duplicating the entire file',
  type: 'Tool-specific result discriminator; create is consumed with structuredPatch',
  isImage: 'Output presentation metadata, not an effect',
  noOutputExpected: 'Output presentation metadata',
  persistedOutputPath: 'Output storage bookkeeping',
  persistedOutputSize: 'Output storage bookkeeping',
  staleReadFileStateHint: 'Read cache bookkeeping',
  backgroundCwdHint: 'Background execution context; task handle is retained',
  file: 'Read output, duplicated in content',
  matches: 'Search output, duplicated in content',
  query: 'Search request echo',
  total_deferred_tools: 'Tool discovery bookkeeping',
  taskId: 'Task tool output, duplicated in content',
  timeoutMs: 'Requested task wait budget, not observed timeout',
  persistent: 'Task configuration, not an observed effect',
  message: 'Tool output, duplicated in content',
  task_id: 'Task tool output, duplicated in content',
  task_type: 'Task tool output, duplicated in content',
  command: 'Task command echo',
  success: 'Command tool output, duplicated in content',
  commandName: 'Command tool output, duplicated in content',
  isAsync: 'Subagent scheduling metadata; agent UI owns subagents',
  status: 'Subagent status; agent UI owns subagents',
  agentId: 'Subagent identity; agent UI owns subagents',
  description: 'Subagent request echo',
  resolvedModel: 'Subagent model metadata; agent UI owns subagents',
  prompt: 'Subagent request echo; do not duplicate full prompts',
  outputFile: 'Subagent output storage bookkeeping',
  canReadOutputFile: 'Subagent output storage bookkeeping',
  retrieval_status: 'Task retrieval output, duplicated in content',
  task: 'Task retrieval output, duplicated in content',
  results: 'Search output, duplicated in content',
  durationSeconds: 'Search timing metadata',
  searchCount: 'Search accounting metadata',
  bytes: 'Fetch output accounting',
  code: 'Fetch status, duplicated in content',
  codeText: 'Fetch status, duplicated in content',
  result: 'Fetch output, duplicated in content',
  durationMs: 'Fetch timing metadata',
  url: 'Fetch request echo',
  memdirStamped: 'Memory-file metadata bookkeeping',
}
export const RECORD_TYPES: Record<string, string> = {
  user: 'Mapped conversation and tool results',
  assistant: 'Mapped conversation and tool calls',
  system: 'Mapped system events',
  attachment: 'Classified separately',
  'last-prompt': 'Resume metadata duplicates the user prompt',
  mode: 'Harness mode bookkeeping',
  'permission-mode': 'Harness permission bookkeeping',
  'atis-latch': 'Harness scheduler bookkeeping',
  'bridge-session': 'Harness bridge bookkeeping',
  'file-history-snapshot': 'Rewind metadata, not an additional edit',
  'file-history-delta': 'Rewind metadata, not an additional edit',
  'ai-title': 'Session title metadata',
  'queue-operation': 'Queue bookkeeping; queued_command owns delivery',
  'cost-state': 'Billing bookkeeping',
  'frame-link': 'Transcript frame bookkeeping',
  'artifact-comment-monitor': 'Artifact watcher bookkeeping',
  'artifact-autoreact-ledger': 'Artifact watcher bookkeeping',
  'agent-color': 'Read separately by claudeRecordColor',
  summary: 'Compaction bookkeeping',
  progress: 'Transient harness progress',
  'custom-title': 'Session title metadata',
}
export const ATTACHMENT_TYPES: Record<string, string> = {
  file: 'Mapped user attachment',
  queued_command: 'Mapped queued user prompt',
  edited_text_file: 'Mapped file-change notice; snippet is not a diff',
  hook_success: 'Successful hook machinery',
  hook_additional_context: 'Injected hook context',
  hook_blocking_error: 'Injected hook feedback for the agent',
  hook_non_blocking_error: 'Injected hook feedback for the agent',
  hook_cancelled: 'Hook lifecycle bookkeeping',
  environment: 'Injected environment',
  model: 'Injected model context',
  deferred_tools_delta: 'Tool availability bookkeeping',
  deferred_tools_record: 'Tool availability bookkeeping',
  agent_listing_delta: 'Agent availability bookkeeping',
  mcp_instructions_delta: 'Injected MCP instructions',
  skill_listing: 'Injected skill catalog',
  auto_mode: 'Injected permission context',
  total_tokens_reminder: 'Injected token-budget reminder',
  instructions: 'Injected instructions',
  session_context: 'Injected session context',
  date: 'Injected clock context',
  date_change: 'Injected clock context',
  remote_session_change: 'Injected remote context',
  prompt_snapshot: 'Prompt bookkeeping',
  nested_memory: 'Injected memory context',
  batching_reminder_sent: 'Injected batching reminder',
  bash_output_audience_note: 'Injected output-routing reminder',
  silent_turn_reminder: 'Injected turn reminder',
  command_permissions: 'Injected command permissions',
  compact_file_reference: 'Compaction reference, not a new attachment',
  thinking_stripped: 'Reasoning bookkeeping',
  invoked_skills: 'Injected skill context',
}
export const SYSTEM_TYPES: Record<string, string> = {
  stop_hook_summary: 'Mapped hook completion notice',
  turn_duration: 'Mapped duration',
  local_command: 'Mapped local command output',
  away_summary: 'Mapped recap',
  compact_boundary: 'Mapped compaction boundary',
  scheduled_task_fire: 'Mapped scheduled task notice',
}

type Shape = { count: number; record: Record<string, unknown> }
/** Absolute frequency threshold: rare new shapes remain visible as unknown effects;
 * repeated unreviewed shapes fail admission. Callers may feed full real records too. */
export function uncoveredClaudeShapes(shapes: readonly Shape[], threshold = 3): string[] {
  const counts = new Map<string, number>()
  const add = (key: string, count: number) => counts.set(key, (counts.get(key) ?? 0) + count)
  for (const { record, count } of shapes) {
    const type = String(record.type)
    if (!Object.hasOwn(RECORD_TYPES, type)) add(`record:${type}`, count)
    if (type === 'attachment') {
      const attachment = record.attachment as Record<string, unknown> | undefined
      const subtype = String(attachment?.type)
      if (!Object.hasOwn(ATTACHMENT_TYPES, subtype)) add(`attachment:${subtype}`, count)
    }
    if (
      type === 'system' &&
      record.subtype !== undefined &&
      !Object.hasOwn(SYSTEM_TYPES, String(record.subtype))
    )
      add(`system:${String(record.subtype)}`, count)
    const effects = record.toolUseResult
    if (effects && typeof effects === 'object' && !Array.isArray(effects)) {
      for (const key of Object.keys(effects))
        if (!EFFECT_KEYS.has(key) && !Object.hasOwn(IGNORED_EFFECT_KEYS, key))
          add(`effect:${key}`, count)
    }
  }
  return [...counts]
    .filter(([, count]) => count >= threshold)
    .map(([key, count]) => `${key}: ${count}`)
    .sort()
}
