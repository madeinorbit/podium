# Current-tip web build baseline

Measured 2026-08-12 from the parent worktree at `311130a1b`, after installing worktree-local dependency links.

Command:

```sh
/usr/bin/time -v bun run --cwd apps/web build
```

Result: success.

| Measure | Current-tip baseline |
|---|---:|
| transformed modules | 4,292 |
| eager main JavaScript | 2,897,116 B |
| precompressed gzip | 835,720 B |
| Brotli | 663,877 B |
| eager main CSS | 290.67 kB (Vite) |
| service-worker precache | 52 entries / 5,817.30 KiB raw |
| all precompressed assets | 5.37 MB raw → 1.22 MB Brotli / 1.50 MB gzip |
| Vite build phase | 33.32 s |
| full build wall time | 1:42.25 |
| build-process peak RSS | 1,538,332 KiB |

The process RSS is a build-tooling measurement, not browser heap evidence. Browser/runtime acceptance is owned by the relevant child issues.

The first attempt correctly failed the POD-746 build-stamp guard because the new worktree had no local `node_modules` links and would have fingerprinted workspace packages through the shared checkout. `bun install` established local links; the successful rerun resolved `@podium/model` within this worktree and stamped wire schema `3ca64e6f388dbcf5`.
