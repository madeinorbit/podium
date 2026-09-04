/**
 * THE CLOUD PROBE KEYS A SELF-HOSTED SERVER TRUSTS BY DEFAULT.
 *
 * connect.meetpodium.com signs every reachability probe with its Ed25519 key;
 * `/.well-known/podium` answers a probe only when the signature verifies under
 * one of these (or one the operator added via PODIUM_CONNECT_PROBE_KEYS). With
 * nothing here, the route answers nobody — which is safe, and useless.
 *
 * ROTATION IS ADDITIVE: append the new key, ship, switch the cloud secret, and
 * remove the old key a release later. The current keys are also served on
 * https://connect.meetpodium.com/.well-known/podium-connect.
 */
export const PODIUM_CONNECT_PROBE_KEYS: readonly string[] = [
  // Pinned when the first cloud key is minted (podium-cloud PDM-51, Task 12).
]
