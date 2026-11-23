/** Claude 2.1.319/330 captured reports (POD-6572). Native validation and math
 * stay here; neither cumulative modelUsage nor output measures occupancy. */
import {
  CONTEXT_MAX_ROWS,
  ContextComposition,
  type ContextCompositionRow,
  type ContextLastRequest,
  type ContextQuantity,
  type ContextSampleIdentity,
  type ContextSummary,
} from '@podium/model'

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
export function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 256 ? value : undefined
}
const quantity = (
  value: number,
  source: string,
  accuracy: ContextQuantity['accuracy'] = 'estimated',
): ContextQuantity => ({ value, source, accuracy })

/** Measured minimum, followed by structural admission on each report. No SDK
 * package version or advertised initialize capability proves these fields. */
export function claudeContextVersion(version: unknown): boolean {
  if (typeof version !== 'string') return false
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version)
  return !!match && Number(match[1]) === 2 && Number(match[2]) === 1 && Number(match[3]) >= 319
}

/** Adapter-owned local transport operation, never a native CLI request. The
 * stream client returns its already-received initialize response unchanged. */
export const CLAUDE_INITIALIZATION_READ = { podium: 'claude-initialization-snapshot' } as const
export function isClaudeInitializationRead(operation: unknown): boolean {
  return object(operation)?.podium === CLAUDE_INITIALIZATION_READ.podium
}

export function claudeRequestAccounting(raw: unknown): ContextLastRequest | undefined {
  const usage = object(raw)
  if (!usage) return undefined
  // Nonempty iteration ledgers need native main/compactor/advisor selection;
  // captured Store evidence verifies the simple request, not that aggregate.
  if (Array.isArray(usage.iterations) && usage.iterations.length) return undefined
  const input = count(usage.input_tokens)
  const read = count(usage.cache_read_input_tokens)
  const write = count(usage.cache_creation_input_tokens)
  const output = count(usage.output_tokens)
  const inclusive =
    input !== undefined && read !== undefined && write !== undefined
      ? input + read + write
      : undefined
  const result: ContextLastRequest = {
    ...(inclusive !== undefined && Number.isFinite(inclusive)
      ? { input: quantity(inclusive, 'claude current request inclusive input', 'reported') }
      : {}),
    ...(read !== undefined
      ? { cacheRead: quantity(read, 'claude current request cache read', 'reported') }
      : {}),
    ...(write !== undefined
      ? { cacheWrite: quantity(write, 'claude current request cache write', 'reported') }
      : {}),
    ...(output !== undefined
      ? { output: quantity(output, 'claude current request output', 'reported') }
      : {}),
  }
  return Object.keys(result).length ? result : undefined
}

type Available = Extract<ContextSummary, { status: 'available' }>
export interface ClaudeContextReport {
  summary: Available
  lastRequest?: ContextLastRequest
  composition?: ContextComposition
}

/** maxTokens/rawMaxTokens are resolved policy windows, never proof of the
 * provider's hard maximum. Model capacity must come from matching metadata. */
export function normalizeClaudeControl(
  raw: unknown,
  sample: ContextSampleIdentity,
): ClaudeContextReport | undefined {
  const report = object(raw)
  if (!report) return undefined
  const used = count(report.totalTokens)
  if (used === undefined) return undefined
  const capacity = count(report.maxTokens)
  const percent = count(report.percentage)
  const threshold = count(report.autoCompactThreshold)
  const model = text(report.model)
  const policySource = text(report.autocompactSource)
  const reserve = Array.isArray(report.categories)
    ? report.categories
        .map(object)
        .find((row) => row?.id === 'autocompact_buffer' && row.kind === 'buffer')?.tokens
    : undefined
  const summary: Available = {
    version: 1,
    status: 'available',
    sample,
    ...(model ? { model: { modelId: model } } : {}),
    occupancy: {
      basis: 'native-estimate',
      usedTokens: quantity(used, 'claude context local estimate'),
      ...(percent !== undefined
        ? { percent: quantity(percent, 'claude context rounded percentage') }
        : {}),
      ...(capacity !== undefined && capacity > 0
        ? {
            remainingTokens: quantity(
              Math.max(0, capacity - used),
              'claude context policy window minus estimate',
            ),
          }
        : {}),
    },
    ...(capacity !== undefined && capacity > 0
      ? {
          effectiveCapacity: {
            ...quantity(capacity, 'claude resolved compaction window', 'reported'),
            basis: policySource === 'settings' || policySource === 'env' ? 'configured' : 'native',
          },
        }
      : {}),
    ...(policySource || typeof report.isAutoCompactEnabled === 'boolean' || threshold !== undefined
      ? {
          compaction: {
            source: policySource ?? 'claude context report',
            ...(typeof report.isAutoCompactEnabled === 'boolean'
              ? { enabled: report.isAutoCompactEnabled }
              : {}),
            ...(threshold !== undefined
              ? { thresholdTokens: quantity(threshold, 'claude compaction threshold', 'reported') }
              : {}),
            ...(count(reserve) !== undefined
              ? {
                  reserveTokens: quantity(
                    reserve as number,
                    'claude compaction buffer',
                    'reported',
                  ),
                }
              : {}),
          },
        }
      : {}),
  }
  return {
    summary,
    lastRequest: claudeRequestAccounting(report.apiUsage),
    composition: claudeComposition(report, used),
  }
}

const categoryNames: Record<string, string> = {
  system_prompt: 'system',
  system_tools: 'tools',
  mcp_tools: 'tools',
  mcp_tools_deferred: 'tools',
  mcp_instructions: 'instructions',
  memory_files: 'memory',
  custom_agents: 'agents',
  skills: 'skills',
  messages: 'messages',
  autocompact_buffer: 'compaction',
  free_space: 'free',
}

/** A child is attribution, not another summand. Unknown kinds are omitted,
 * forcing partial coverage. Older reports without kind/ID cannot be inferred
 * from translated display names or terminal colors. */
export function claudeComposition(
  report: Record<string, unknown>,
  used: number,
  maxRows = CONTEXT_MAX_ROWS,
): ContextComposition | undefined {
  if (!Array.isArray(report.categories)) return undefined
  const rows: ContextCompositionRow[] = []
  let partial = false
  for (const raw of report.categories) {
    const cat = object(raw)
    const id = text(cat?.id)
    const tokens = count(cat?.tokens)
    const kind =
      cat?.kind === 'buffer' ? 'reserve' : cat?.kind === 'deferred' ? 'excluded' : cat?.kind
    if (
      !cat ||
      !id ||
      tokens === undefined ||
      !['used', 'reserve', 'free', 'excluded'].includes(kind as string) ||
      rows.some((row) => row.id === id)
    ) {
      partial = true
      continue
    }
    rows.push({
      id,
      label: text(cat.name) ?? id,
      category: categoryNames[id] ?? 'other',
      kind: kind as ContextCompositionRow['kind'],
      attribution: 'category',
      tokens: quantity(tokens, 'claude context category estimate'),
    })
  }
  if (!rows.length) return undefined
  if (
    rows
      .filter((row) => row.kind === 'used')
      .reduce((sum, row) => sum + (row.tokens?.value ?? 0), 0) > used
  )
    return undefined
  const addChildren = (
    parentId: string,
    items: unknown,
    label: (item: Record<string, unknown>) => string | undefined,
  ): void => {
    const parent = rows.find((row) => row.id === parentId)
    if (!parent || !Array.isArray(items) || !items.length) return
    const children: ContextCompositionRow[] = []
    let incomplete = false
    for (const [index, raw] of items.entries()) {
      const item = object(raw)
      const name = item && label(item)
      const tokens = count(item?.tokens)
      if (!name || tokens === undefined) {
        incomplete = true
        continue
      }
      children.push({
        id: `${parentId}:${index}`,
        parentId,
        label: name.slice(0, 256),
        category: parent.category,
        kind: parent.kind,
        attribution: 'item',
        tokens: quantity(tokens, 'claude context item estimate'),
      })
    }
    const sum = children.reduce((total, row) => total + (row.tokens?.value ?? 0), 0)
    if (sum > (parent.tokens?.value ?? 0)) {
      parent.childrenCoverage = 'unknown'
      return
    }
    parent.childrenCoverage = !incomplete && sum === parent.tokens?.value ? 'complete' : 'partial'
    rows.push(...children)
  }
  const by = (field: string) => (item: Record<string, unknown>) => text(item[field])
  addChildren('memory_files', report.memoryFiles, by('path'))
  addChildren('mcp_instructions', report.mcpInstructions, by('serverName'))
  addChildren('custom_agents', report.agents, by('agentType'))
  addChildren('skills', object(report.skills)?.skillFrontmatter, by('name'))
  if (Array.isArray(report.mcpTools)) {
    addChildren(
      'mcp_tools',
      report.mcpTools.filter((item) => object(item)?.isLoaded === true),
      by('name'),
    )
    addChildren(
      'mcp_tools_deferred',
      report.mcpTools.filter((item) => object(item)?.isLoaded === false),
      by('name'),
    )
  }
  const messages = object(report.messageBreakdown)
  if (messages) {
    const fields: [string, string][] = [
      ['toolCallTokens', 'Tool calls'],
      ['toolResultTokens', 'Tool results'],
      ['attachmentTokens', 'Attachments'],
      ['assistantMessageTokens', 'Assistant messages'],
      ['userMessageTokens', 'User messages'],
      ['redirectedContextTokens', 'Redirected context'],
      ['unattributedTokens', 'Unattributed messages'],
    ]
    addChildren(
      'messages',
      fields.map(([key, name]) => ({ name, tokens: messages[key] })),
      by('name'),
    )
    const unattributed = rows.find(
      (row) => row.parentId === 'messages' && row.label === 'Unattributed messages',
    )
    if (unattributed && (unattributed.tokens?.value ?? 0) > 0) {
      unattributed.attribution = 'unattributed'
      const parent = rows.find((row) => row.id === 'messages')
      if (parent) parent.childrenCoverage = 'partial'
    }
    const calls = rows.find((row) => row.parentId === 'messages' && row.label === 'Tool calls')
    const attachments = rows.find(
      (row) => row.parentId === 'messages' && row.label === 'Attachments',
    )
    if (calls) addChildren(calls.id, messages.toolCallsByType, by('name'))
    if (attachments) addChildren(attachments.id, messages.attachmentsByType, by('name'))
  }
  const total = rows
    .filter((row) => row.kind === 'used' && !row.parentId)
    .reduce((sum, row) => sum + (row.tokens?.value ?? 0), 0)
  const truncated = rows.length > maxRows
  const limited = rows.slice(0, maxRows)
  if (truncated)
    for (const row of limited) if (row.childrenCoverage) row.childrenCoverage = 'partial'
  const complete =
    !partial &&
    !truncated &&
    total === used &&
    rows.every(
      (row) =>
        row.kind !== 'used' ||
        (row.attribution !== 'unattributed' &&
          (!row.childrenCoverage || row.childrenCoverage === 'complete')),
    )
  const parsed = ContextComposition.safeParse({
    coverage: complete ? 'complete' : 'partial',
    usedTokens: quantity(used, 'claude context estimate'),
    rows: limited,
    truncated,
  })
  return parsed.success ? parsed.data : undefined
}

/** Terminal percentage excludes output and is clamped by Claude. Preserve its
 * reported rounding; never invert it or substitute lifetime total counters. */
export function normalizeClaudeStatus(
  raw: unknown,
  sample: ContextSampleIdentity,
): ClaudeContextReport | undefined {
  const report = object(raw)
  if (!report || !claudeContextVersion(report.version)) return undefined
  const window = object(report.context_window)
  const accounting = claudeRequestAccounting(window?.current_usage)
  const used = accounting?.input?.value
  if (!accounting || used === undefined) return undefined
  const size = count(window?.context_window_size)
  const percent = count(window?.used_percentage)
  const model = text(object(report.model)?.id)
  return {
    summary: {
      version: 1,
      status: 'available',
      sample,
      ...(model ? { model: { modelId: model } } : {}),
      occupancy: {
        basis: 'last-request',
        usedTokens: accounting.input,
        ...(percent !== undefined
          ? {
              percent: quantity(percent, 'claude status input-only rounded percentage', 'reported'),
            }
          : {}),
        ...(size !== undefined && size > 0
          ? {
              remainingTokens: quantity(
                Math.max(0, size - used),
                'claude status window minus inclusive input',
                'reported',
              ),
            }
          : {}),
      },
      ...(size !== undefined && size > 0
        ? {
            effectiveCapacity: {
              ...quantity(size, 'claude status context window', 'reported'),
              basis: 'native',
            },
          }
        : {}),
    },
    // model.id is current selection, and prompt_id spans multiple requests.
    // Neither proves an identity for the current_usage accounting snapshot.
    lastRequest: accounting,
  }
}
