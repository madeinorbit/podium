# @podium/live-grants

Short-lived signed grants for the live channel (POD-6954 design 4.5). Core signs a
grant; the room and the daemon verify it with Core's public key and ask nobody.

## Kinds

- **Client grant** (five minutes, refresh at half time): the workspace (the audience),
  the member and role, the sessions and machines the member may `view`, `use` or
  `manage`, the roots a direct ask may touch per machine, and the machines whose
  provider logins' quota the member may see. The server issues it from
  `POST /live/grant` for the ids a screen shows (`apps/server/src/modules/live-grants`).
- **Daemon grant** (one hour, refresh at half time): the workspace and the machine.

Both may carry a connection key (the thumbprint of a key the connection proves it
holds) and a routing epoch. This package carries them; the room binds them.

## Token

`plg1.<key id>.<payload>.<signature>`: the payload is base64url of the raw DEFLATE of
the claims' JSON, the signature is Ed25519 over `plg1.<key id>.<payload>`. The
verifier checks the signature before it inflates anything.

Sizes (random UUID session ids, plus 20 machines with three roots each): about 6.9 KB
for 200 sessions and 29 KB for 1,000 (`src/size.test.ts` prints them), against a
64 KiB budget that ids, roots and logins all count toward. The signer refuses a
grant past it, or with more than 1,024 roots on a machine or a root over 4,096
characters, as `LiveGrantTooLarge`; the route answers 413. Plain base64 JSON would
be 19 KB and 76 KB.

## Keys

A key ring in one JSON shape for both sides:

```json
{ "keys": [ { "kid": "2026-11", "privateKey": "<PKCS#8 DER, base64>" },
            { "kid": "2026-10", "publicKey": "<SPKI DER, base64>" } ] }
```

The first key with a private half signs; every key verifies. To rotate: give the
verifiers the new public key, then put the new key first on Core and keep the old
one after it. Remove it about an hour (the longest grant, a daemon's) plus two
minutes after the new ring is in place on EVERY Core process: a process can sign
with the old key for up to 5 s after its file changes (60 s for the self-hosted
database ring), and verifier clocks lag.
`LiveGrantKeyFile` (`./key-file`) re-reads a ring when its file changes, so a
rotation needs no restart.

The server reads its ring from the file `PODIUM_LIVE_GRANT_KEYS_FILE` names. Hosted
requires it. A self-hosted install without it mints a ring into the install's
`server_secrets` and reads it again every minute.
