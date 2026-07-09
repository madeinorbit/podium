# Multiple Sessions — Phase 2: agentLaunchCommand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Map an agent kind + optional resume ref into a concrete spawn command, so the daemon can launch fresh or resumed claude/codex sessions from one helper.

**Architecture:** A pure function `agentLaunchCommand(kind, { cwd, resume? }) → { cmd, args, cwd }` in `@podium/agent-bridge` (agent knowledge lives there per ARCHITECTURE). The daemon (Phase 4) will call it and pass the result straight into `spawnAgent`.

**Tech Stack:** TypeScript (ESM, strict), Vitest. Package: `packages/agent-bridge`. Depends on `@podium/protocol` types (`AgentKind`, `ResumeRef`).

**Spec:** `docs/superpowers/specs/2026-06-03-multiple-sessions-design.md` §7.

---

## Sequencing note

Package-scoped gate only: `bun run --filter @podium/agent-bridge test|typecheck|build` + `bun run lint`.
`@podium/agent-bridge` imports types from `@podium/protocol`; protocol's `dist` is already built
(Phase 1). If a type import fails to resolve, run `bun run --filter @podium/protocol build` first.
Do NOT run workspace-wide typecheck (consumers still break by design).

---

## File structure

- `packages/agent-bridge/src/launch.ts` — the launcher (create).
- `packages/agent-bridge/src/launch.test.ts` — unit tests (create).
- `packages/agent-bridge/src/index.ts` — add the re-export (match existing style).

---

### Task 1: `agentLaunchCommand`

**Files:**
- Create: `packages/agent-bridge/src/launch.ts`
- Test: `packages/agent-bridge/src/launch.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/agent-bridge/src/launch.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { agentLaunchCommand } from './launch'

describe('agentLaunchCommand', () => {
  it('spawns claude fresh', () => {
    expect(agentLaunchCommand('claude-code', { cwd: '/proj' })).toEqual({
      cmd: 'claude',
      args: [],
      cwd: '/proj',
    })
  })

  it('resumes claude by session id', () => {
    expect(
      agentLaunchCommand('claude-code', { cwd: '/proj', resume: { kind: 'claude-session', value: 'abc' } }),
    ).toEqual({ cmd: 'claude', args: ['--resume', 'abc'], cwd: '/proj' })
  })

  it('spawns codex fresh', () => {
    expect(agentLaunchCommand('codex', { cwd: '/w' })).toEqual({
      cmd: 'codex',
      args: [],
      cwd: '/w',
    })
  })

  it('resumes codex by thread id', () => {
    expect(
      agentLaunchCommand('codex', { cwd: '/w', resume: { kind: 'codex-thread', value: 't9' } }),
    ).toEqual({ cmd: 'codex', args: ['resume', 't9'], cwd: '/w' })
  })

  it('threads cwd through unchanged', () => {
    expect(agentLaunchCommand('claude-code', { cwd: '/a/b/c' }).cwd).toBe('/a/b/c')
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `bun run --filter @podium/agent-bridge test`
Expected: FAIL — `agentLaunchCommand` not found.

- [ ] **Step 3: Implement the launcher**

`packages/agent-bridge/src/launch.ts`:

```ts
import type { AgentKind, ResumeRef } from '@podium/protocol'

export interface LaunchOptions {
  /** Working directory the agent runs in (a project or worktree path). */
  cwd: string
  /** Present to resume an existing on-disk conversation; absent to start fresh. */
  resume?: ResumeRef
}

export interface LaunchSpec {
  cmd: string
  args: string[]
  cwd: string
}

/**
 * Build the spawn command for an agent kind. Fresh vs resume is the only
 * difference; this is the single place that knows each CLI's resume flag, so the
 * daemon stays agent-agnostic. The result feeds straight into `spawnAgent`.
 */
export function agentLaunchCommand(kind: AgentKind, opts: LaunchOptions): LaunchSpec {
  const { cwd, resume } = opts
  switch (kind) {
    case 'claude-code':
      return { cmd: 'claude', args: resume ? ['--resume', resume.value] : [], cwd }
    case 'codex':
      return { cmd: 'codex', args: resume ? ['resume', resume.value] : [], cwd }
    default: {
      const exhaustive: never = kind
      throw new Error(`Unknown agent kind: ${String(exhaustive)}`)
    }
  }
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `bun run --filter @podium/agent-bridge test`
Expected: PASS (5 new tests; existing agent-bridge tests still green).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/launch.ts packages/agent-bridge/src/launch.test.ts
git commit -m "feat(agent-bridge): agentLaunchCommand (fresh + resume for claude/codex)"
```

---

### Task 2: Export + package gate

**Files:**
- Modify: `packages/agent-bridge/src/index.ts`

- [ ] **Step 1: Re-export the launcher**

Read `packages/agent-bridge/src/index.ts` and add the launcher to the export surface, matching
the existing style (e.g. `export * from './launch.js'`, or explicit
`export { agentLaunchCommand, type LaunchOptions, type LaunchSpec } from './launch.js'`).

- [ ] **Step 2: Run the package gate**

Run: `bun run --filter @podium/agent-bridge test` → all pass.
Run: `bun run --filter @podium/agent-bridge typecheck` → exit 0.
Run: `bun run --filter @podium/agent-bridge build` → exit 0 (tsup ESM + DTS).
Run: `bun run lint` → clean for the new files (run `bun run format` first if Biome would reformat).

- [ ] **Step 3: Commit**

```bash
git add packages/agent-bridge/src/index.ts
git commit -m "feat(agent-bridge): export agentLaunchCommand"
```

---

## Self-review checklist

- **Spec coverage (§7):** claude fresh=`claude`, resume=`claude --resume <id>`; codex fresh=`codex`,
  resume=`codex resume <id>`; cwd threaded into the returned spec. ✔
- **Type consistency:** `kind: AgentKind` and `resume?: ResumeRef` imported (type-only) from
  `@podium/protocol`; `LaunchSpec.args` is `string[]`.
- **Exhaustiveness:** the `default` `never` guard catches a future `AgentKind` member at compile time.
- **No placeholders.** Resume-flag accuracy for the real CLIs is validated in Phase 7 (this is the
  single swap point).
