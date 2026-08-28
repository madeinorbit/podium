# HISTORICAL — do not read these as current

Readings and pins taken at epic tip `593e40ef55a2e0c68f68f7f9028def95dc18d507`,
2026-08-28 16:27–16:48 CEST. **Superseded** by the readings one directory up,
pinned to `90ebca7d94d0e68f4744c6a8425eed30cf5b0b10`.

Re-driven because **POD-3059 landed** (`1b5ebc9c1`, `ccdea1f93`) and changed the
headless spawn seam — `durable-headless.ts` and `headless-drivers.ts` — which is
the mechanism A8's verdict rests on. Every verdict came back the same.

The re-drive earned its keep anyway: it is what established that POD-3059 does
**not** reach the claude-sdk path. See the report's "What POD-3059 did and did
not fix".
