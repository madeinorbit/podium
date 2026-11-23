import { type HarnessUsage, supported, unsupported } from '../../manifest.js'
import { scanJsonlTranscripts, type UsageRecord } from '../../usage-records.js'
import { isRecord } from '../shared/json-util.js'
import { listAntigravityTranscripts } from './discovery.js'

export function antigravityUsageFromLine(line: string): UsageRecord | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (
    !isRecord(raw) ||
    raw.type !== 'PLANNER_RESPONSE' ||
    raw.status !== 'DONE' ||
    typeof raw.model !== 'string'
  )
    return null
  const tsMs = typeof raw.created_at === 'string' ? Date.parse(raw.created_at) : NaN
  if (
    !Number.isFinite(tsMs) ||
    typeof raw.input_tokens !== 'number' ||
    typeof raw.output_tokens !== 'number'
  )
    return null
  const valid = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  return {
    tsMs,
    model: raw.model,
    inputTokens: valid(raw.input_tokens),
    outputTokens: valid(raw.output_tokens),
    cacheReadTokens: valid(raw.cache_read_tokens),
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
  }
}

export const antigravityUsage: HarnessUsage = {
  quota: unsupported(
    'A programmatic Google quota-window contract has not been verified; the native /usage and /credits commands remain available in the terminal',
  ),
  history: unsupported(
    'Antigravity does not persist quota-window samples in its conversation logs',
  ),
  transcripts: supported({
    async scan(opts) {
      const listing = await listAntigravityTranscripts(opts.account.roots.state)
      return scanJsonlTranscripts(
        listing.files.map((file) => file.path),
        'antigravity',
        opts,
        { usageFromLine: antigravityUsageFromLine },
      )
    },
  }),
}
