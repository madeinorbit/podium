/** Transport failures stay distinguishable so callers never retry auth via another transport. */
export class SyncStreamFailed extends Error {
  constructor(readonly reason: string, options?: ErrorOptions) {
    super(reason, options)
    this.name = new.target.name
  }
}
export class SyncFormatError extends SyncStreamFailed {}
export class SyncAuthExpiredError extends SyncStreamFailed {}
export class SyncNetworkError extends SyncStreamFailed { readonly retryable = true }
export class SyncCorruptContentError extends SyncStreamFailed {}
export class SyncCancelledError extends SyncStreamFailed {
  constructor() { super('cancelled') }
}
export class SyncLineTooLargeError extends SyncCorruptContentError {
  constructor() { super('line-too-large') }
}
