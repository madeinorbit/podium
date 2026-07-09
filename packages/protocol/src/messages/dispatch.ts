/**
 * Total, type-exhaustive message dispatch [spec:SP-3fe2] — the shared
 * replacement for hand-written if-ladders (terminal-client connection.ts)
 * and switches (SessionsService), generalizing the handler-registry pattern
 * of apps/daemon/src/control/registry.ts: the mapped type over `M['type']`
 * makes a union member without a handler a COMPILE error, so adding a new
 * message type forces every dispatcher over that union to handle it.
 */

/** One handler per union member, each receiving the narrowed message. */
export type DispatchHandlers<M extends { type: string }, Ctx = void> = {
  [K in M['type']]: (msg: Extract<M, { type: K }>, ctx: Ctx) => void | Promise<void>
}

/**
 * Build a dispatcher over a discriminated union. Runtime is a direct table
 * lookup — no fallback arm is needed because upstream zod parsing guarantees
 * membership; a descriptive throw guards the type-system escape hatches
 * (casts, unparsed input) anyway.
 */
export function createDispatcher<M extends { type: string }, Ctx = void>(
  // `string extends M['type']` means the discriminant was widened (e.g. a bare
  // `{ type: string }`): the mapped type would collapse to an index signature
  // and exhaustiveness would silently vanish — reject it at the call site.
  handlers: string extends M['type']
    ? [
        'createDispatcher requires a finite discriminated union — the discriminant was widened to string',
      ]
    : DispatchHandlers<M, Ctx>,
): (msg: M, ctx: Ctx) => void | Promise<void> {
  return (msg, ctx) => {
    const handler = (
      handlers as unknown as Record<
        string,
        ((msg: M, ctx: Ctx) => void | Promise<void>) | undefined
      >
    )[msg.type]
    if (!handler) {
      throw new Error(`createDispatcher: no handler for message type '${msg.type}'`)
    }
    return handler(msg, ctx)
  }
}
