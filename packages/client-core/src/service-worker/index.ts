/**
 * The service-worker pieces both web builds share (POD-7179): the container
 * read that never throws, and the reload handshake that swaps a waiting
 * workbox worker in before the page reloads. The desktop shell and the phone
 * website register their own workers; the update mechanism is this one.
 */
export {
  type ServiceWorkerAvailability,
  serviceWorkerAvailability,
  serviceWorkerContainer,
} from './container'
export {
  notReloadedStatus,
  RELOAD_HANDSHAKE_BUDGET_MS,
  type ReloadHandshakeDeps,
  type ReloadHandshakeOutcome,
  type ReloadHandshakePhase,
  type ReloadHandshakeResult,
  type ReloadHandshakeStatus,
  type ReloadPath,
  type ReloadTrigger,
  type ServiceWorkerSnapshot,
  startReloadHandshake,
} from './reload-handshake'
