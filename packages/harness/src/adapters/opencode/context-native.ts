/** Measured on OpenCode 1.18.35 and beta-18866 (POD-6573).
 * These are native normalized counters, NOT raw provider billing counters.
 */
import type { ContextCapacity, ContextLastRequest, ContextModelIdentity } from '@podium/model'
import { z } from 'zod'

const text = z.string().min(1).max(256)
const count = z.number().finite().nonnegative()
const time = z.number().finite().positive().max(8.64e15)

export const nativeTokens = z.object({
  input: count,
  output: count,
  reasoning: count,
  cache: z.object({ read: count, write: count }),
})
export const nativeSelection = z.object({
  id: text,
  providerID: text,
  variant: text.optional(),
})
export type NativeSelection = z.infer<typeof nativeSelection>
export type NativeScope = { directory: string; workspace?: string }
export type NativeGeneration = 'stable' | 'preview' | 'store'

export function record(raw: unknown): Record<string, unknown> | undefined {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined
}

export function jsonRecord(raw: unknown): Record<string, unknown> | undefined {
  try {
    return record(typeof raw === 'string' ? JSON.parse(raw) : raw)
  } catch {
    return undefined
  }
}

export function modelIdentity(model: NativeSelection): ContextModelIdentity {
  return { providerId: model.providerID, modelId: model.id }
}

export function selectionKey(model: NativeSelection): string {
  return JSON.stringify([model.providerID, model.id, model.variant ?? ''])
}

export function sameModel(a: NativeSelection, b: NativeSelection): boolean {
  return a.id === b.id && a.providerID === b.providerID
}

export function milliseconds(raw: unknown): number | undefined {
  const value = time.safeParse(raw)
  return value.success ? value.data : undefined
}

export function nativeScope(raw: unknown, preview: boolean): NativeScope | undefined {
  const value = record(raw)
  const directory = value?.directory
  if (typeof directory !== 'string' || directory.length === 0) return undefined
  const workspace = preview ? value?.workspaceID : value?.workspace
  if (workspace !== undefined && (typeof workspace !== 'string' || workspace.length === 0))
    return undefined
  return { directory, ...(typeof workspace === 'string' ? { workspace } : {}) }
}

export function scopedPath(path: string, scope: NativeScope, preview: boolean): string {
  const query = new URLSearchParams()
  query.set(preview ? 'location[directory]' : 'directory', scope.directory)
  if (scope.workspace) query.set(preview ? 'location[workspace]' : 'workspace', scope.workspace)
  return `${path}?${query}`
}

/** All five native components are disjoint. Shared detail uses INCLUSIVE
 * parents: cache subsets and reasoning must not be added to those again.
 * Native total is optional and deliberately cannot fill missing components.
 */
export function requestUsage(raw: unknown, id: string, model: NativeSelection) {
  const result = nativeTokens.safeParse(raw)
  if (!result.success) return undefined
  const t = result.data
  const input = t.input + t.cache.read + t.cache.write
  const output = t.output + t.reasoning
  const used = input + output
  if (![input, output, used].every(Number.isFinite)) return undefined
  const source = 'OpenCode native request tokens'
  const quantity = (value: number) => ({ value, accuracy: 'reported' as const, source })
  const lastRequest: ContextLastRequest = {
    requestId: id,
    model: modelIdentity(model),
    input: quantity(input),
    output: quantity(output),
    cacheRead: quantity(t.cache.read),
    cacheWrite: quantity(t.cache.write),
    reasoning: quantity(t.reasoning),
  }
  return { used, lastRequest }
}

/** Do not validate unrelated providers/models, retain their metadata, use a
 * default row, or substitute preview's underlying request modelID for id.
 */
export function effectiveCapacity(
  raw: unknown,
  model: NativeSelection,
  preview: boolean,
  scope: NativeScope,
  configuration?: unknown,
): ContextCapacity | undefined {
  const root = record(raw)
  let selected: Record<string, unknown> | undefined
  if (preview) {
    const location = record(root?.location)
    if (location?.directory !== scope.directory || location.workspaceID !== scope.workspace)
      return undefined
    const models = root?.data
    if (!Array.isArray(models)) return undefined
    const matches = models.filter((v) => {
      const row = record(v)
      return row?.id === model.id && row.providerID === model.providerID
    })
    if (matches.length !== 1) return undefined
    selected = record(matches[0])
  } else {
    const providers = root?.providers
    if (!Array.isArray(providers)) return undefined
    const matches = providers.filter((v) => record(v)?.id === model.providerID)
    if (matches.length !== 1) return undefined
    selected = record(record(record(matches[0])?.models)?.[model.id])
    if (selected?.id !== model.id || selected.providerID !== model.providerID) return undefined
  }
  const limit = record(selected?.limit)
  const context = count.safeParse(limit?.context)
  if (!context.success || context.data <= 0) return undefined
  // beta-18866 constructs 200k/32k limits for unconfigured models. The model
  // snapshot does not expose provenance. Only use a configured denominator
  // when the scoped documents corroborate the resolved value; otherwise the
  // honest fallback is request counts alone, even if a catalog row exists.
  if (preview && configuredContext(configuration, model) !== context.data) return undefined
  return {
    value: context.data,
    accuracy: 'reported',
    basis: preview ? 'configured' : 'native',
    source: preview
      ? 'OpenCode effective configured model limit'
      : 'OpenCode effective model limit',
  }
}

function configuredContext(raw: unknown, model: NativeSelection): number | undefined {
  if (!Array.isArray(raw)) return undefined
  let context: number | undefined
  for (const entry of raw) {
    const doc = record(entry)
    if (doc?.type !== 'document') continue
    const provider = record(record(record(doc.info)?.providers)?.[model.providerID])
    const configuredModel = record(record(provider?.models)?.[model.id])
    const value = record(configuredModel?.limit)?.context
    if (value !== undefined) {
      const parsed = count.safeParse(value)
      if (!parsed.success) return undefined
      context = parsed.data
    }
  }
  return context
}
