/**
 * A definitive issue precondition refusal, shared by tRPC, relay and MCP.
 * The service keeps transport vocabulary out of its errors; routerFromCommands
 * maps this type to CONFLICT/409 so the outbox never retries it as a fault.
 * Keep the message verbatim for the relay and CLI's existing output.
 */
export class IssueRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IssueRefusal'
  }
}

/** Match across duplicated workspace module copies, like IssueNotFound. */
export const isIssueRefusal = (error: unknown): error is IssueRefusal =>
  error instanceof Error && error.name === 'IssueRefusal'

/**
 * The caller may not do this to this record, whatever its state (POD-6289:
 * someone else's comment). routerFromCommands maps it to FORBIDDEN/403, which
 * the outbox classifies as definitive.
 */
export class IssueForbidden extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IssueForbidden'
  }
}

export const isIssueForbidden = (error: unknown): error is IssueForbidden =>
  error instanceof Error && error.name === 'IssueForbidden'
