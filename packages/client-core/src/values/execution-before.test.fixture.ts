import type { TranscriptItem } from '@podium/model'

/** Previous command disclosure's decode, kept only as a migration oracle. */
export function beforeExecutionInputs(item: TranscriptItem): string[] {
  try {
    const payload = JSON.parse(item.toolInputJson ?? '{}')
    if (payload.kind === 'shell-command' && typeof payload.command === 'string')
      return [payload.command]
    if (payload.kind === 'script-calls' && Array.isArray(payload.calls))
      return payload.calls.map((call: { input: string }) => call.input)
  } catch {
    /* The old view fell back to its preview. */
  }
  return item.toolInput === undefined ? [] : [item.toolInput]
}
