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
