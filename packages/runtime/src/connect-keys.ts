/**
 * THE CLOUD PROBE KEYS A SELF-HOSTED SERVER TRUSTS BY DEFAULT.
 *
 * connect.podium.do signs every reachability probe with its Ed25519 key;
 * `/.well-known/podium` answers a probe only when the signature verifies under
 * one of these (or one the operator added via PODIUM_CONNECT_PROBE_KEYS). With
 * nothing here, the route answers nobody — which is safe, and useless.
 *
 * ROTATION IS ADDITIVE: append the new key, ship, switch the cloud secret, and
 * remove the old key a release later. The current keys are also served on
 * https://connect.podium.do/.well-known/podium-connect.
 */
export const PODIUM_CONNECT_PROBE_KEYS: readonly string[] = [
  // The key in CONNECT_PROBE_PRIVATE_KEY. Connect signs probes with this.
  'ed25519:lJN7LYabibbr5g5wDPNIexSQN2S9KTCg6hXJ-gSnwOY',
]
