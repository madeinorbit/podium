import { CLIENT_REFUSAL, type RefusalCode } from './client-refusal'

/** Configuration/authentication failure surfaced by every LLM provider adapter. */
export class LlmConfigError extends Error {
  get [CLIENT_REFUSAL](): RefusalCode {
    return 'PRECONDITION_FAILED'
  }
}
