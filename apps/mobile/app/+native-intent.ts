/**
 * Rewrites every OS-delivered link before expo-router resolves it (native
 * only). Pairing and sign-in links never reach a route: the profile gate owns
 * them through `Linking` (POD-2364, POD-6913). Mission links open the existing
 * chat/deck routes; profile handoffs go to the authenticated host. See
 * ../src/client/app-link-intent.
 */
export { redirectSystemPath } from '../src/client/app-link-intent'
