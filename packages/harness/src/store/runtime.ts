/** Runtime facts observed in a harness-native transcript record. Every field is
 * optional because harnesses expose different subsets. In particular, context
 * usage is emitted only when the transcript carries both used tokens and the
 * exact context-window size; Podium does not guess model capacities. */
export interface HarnessRuntimeObservation {
  model?: string
  effort?: string
  contextUsagePercent?: number
}

/** Read one harness's native record for runtime identity/context facts. One
 * implementation per harness lives in that harness's adapter transcript
 * module; WHICH one applies is the manifest's answer, not a switch here —
 * behaviour keyed on a harness belongs in that harness's declaration
 * (`HarnessTranscript.recordRuntime`), while this reader-side contract type
 * stays in the Store both sides may reach. */
export type TranscriptRuntimeReader = (record: unknown) => HarnessRuntimeObservation
