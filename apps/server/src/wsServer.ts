/**
 * COMPATIBILITY RE-EXPORT. The WS transport moved into the gateway (POD-389) so
 * that the gateway is the ONE module importing `ws` types and the sessions
 * service owns no socket. This file forwards the existing import surface — it
 * imports no `ws` type of its own, which is what makes that claim literally true
 * (`gateway/ws-boundary.test.ts` pins it).
 *
 *  - transport + upgrade gate → `gateway/ws-server.ts`
 *  - the `/daemon` socket      → `gateway/daemon-socket.ts`
 *  - routing to feature ports  → `gateway/daemon-mux.ts`
 *  - heartbeat / reaping       → `gateway/plane-liveness.ts`
 *  - outbound backpressure     → `gateway/ws-send.ts`
 */

export { wireDaemonSocket } from './gateway/daemon-socket'
export {
  type HeartbeatSocket,
  sweepPlaneLiveness,
  /** @deprecated Name kept for existing callers; it sweeps either peer plane. */
  sweepPlaneLiveness as sweepClientLiveness,
} from './gateway/plane-liveness'
export { safeSend, safeSendEncoded, type SendSocket } from './gateway/ws-send'
export {
  attachWebSockets,
  isAllowedWsOrigin,
  type WsAuthOptions,
  type WsHandle,
} from './gateway/ws-server'
