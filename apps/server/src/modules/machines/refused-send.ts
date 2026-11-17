/**
 * `MachinesService.toMachine` refused a frame that must never wait in the
 * offline queue: one holding a secret (an access with an `env` delivery, or the
 * vault's data key; credential management §7, §8), or a server-transfer promote,
 * which must not commit after its caller gave up. No live daemon link, or no
 * safe one, was there at the send. Nothing was sent and nothing was queued, so
 * the target never saw the frame: a caller may treat the request as not begun.
 * Its own module so a caller can test for it without loading the machines service.
 */
export class RefusedSendError extends Error {
  override readonly name = 'RefusedSendError'
}

export const isRefusedSend = (error: unknown): error is RefusedSendError =>
  error instanceof RefusedSendError
