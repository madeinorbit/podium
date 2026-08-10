# Live development update proof

Date: 2026-08-10

Topology:

- Coordinator and web UI: Ludovico, source checkout at `d235f6c791`
- Managed installed daemon: Flatblock, connected to Ludovico over the public HTTPS/WSS endpoint

Observed flow:

1. Ludovico published target `dev+d235f6c` with a signed `linux-x86_64` bundle on its public HTTPS update route.
2. Flatblock downloaded the exact advertised artifact (179,016,025 bytes; SHA-256 `59ed11252ce415640f95decf4780af317df088687ddfbf7b18a93979cf39ccd4`).
3. The real Ludovico UI showed an enabled **Update Podium** action. The browser clicked it; the panel changed to **Podium dev+d235f6c is being applied** and **0 of 2 places are ready**.
4. Flatblock's installed daemon stopped and systemd restarted it. The PID changed from `1328978` to `1982419`.
5. The installed CLI and `VERSION` file changed from `0.1.2-edge.1` to `dev+d235f6c`.
6. The restarted daemon reconnected to `wss://ludovico.shetland-banjo.ts.net:55555`, reported exact version `dev+d235f6c`, and had no remaining `pending-update.json`.

The fleet-wide panel then showed one remaining machine: `Michaels-MacBook-Pro.local`, a separate source daemon still reporting generic `dev`. This proves the Flatblock delivery path while also demonstrating why channel selection and authorization must be machine-scoped before the release-channel cycle.

Temporary live prerequisites used for this proof:

- Ludovico's systemd user manager received `PODIUM_DEV_ARTIFACT_BASE_URL=https://ludovico.shetland-banjo.ts.net:55555`.
- A two-hour local operator session allowed the password-protected source server's legacy CLI-based build lock. POD-1842 and POD-1870 own durable replacements for these temporary prerequisites.

Tests were deliberately not run per coordinator instruction. This document records runtime observation, not automated validation.
