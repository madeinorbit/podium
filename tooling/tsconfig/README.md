# @podium/tsconfig

Shared TypeScript base configurations for the monorepo.

- `base.json` — strict, ESM, bundler resolution; environment-agnostic.
- `node.json` — `base` + Node types. For `apps/server`, `apps/daemon`, `@podium/agent-bridge`.
- `dom.json` — `base` + DOM libs. For `@podium/terminal-client`.
- `react.json` — `dom` + `react-jsx`. For `apps/web`.

Packages extend these by relative path, e.g. `"extends": "../../tooling/tsconfig/node.json"`.
