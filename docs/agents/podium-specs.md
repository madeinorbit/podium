# Working with the project spec (for agents)

This project keeps a **living spec** in `<repo>/pspec/`: one HTML file per spec component,
forming a tree rooted at the project itself (`SP-root`). It codifies the decisions humans
have explicitly made, so you can measure new input and your own actions against them.
Use the `podium spec` CLI. Run `podium spec prime` anytime for these rules plus the current tree.

## The format, in one breath
Every component has a stable id (`SP-xxxx`) that never changes when it moves. Code references
the component it implements with a `[spec:SP-xxxx]` comment; components interlink with
`<a href="#spec:SP-xxxx">`. Bodies are self-contained HTML — inline SVG/diagrams welcome.

## Read before you build
- `podium spec tree` / `podium spec search <text>` before non-trivial work; comply with
  decisions touching your task.
- A `[spec:SP-xxxx]` comment in code you are changing means: `podium spec show SP-xxxx` first.

## Write what humans decide — and nothing else
- When the human states a decision or gives project context in conversation, record it:
  rewrite it **as concisely as possible** (keep meaning, drop filler) and put it in the right
  component — or create a narrowly-scoped sub-component:
  `podium spec create <parent-id> "<title>" --body "<html>"`.
- **Only explicit human decisions and human-provided context belong in the spec.** Never record
  the obvious or common industry practice (assume it silently) — *except* when the human's input
  contradicts best practice: confirm they mean it, then record the deviation with its why.
- Measure new input against the existing spec first. On contradiction, do not silently
  overwrite: flag it to the human; once resolved, mark the losing decision
  `podium spec update <id> --status superseded` rather than deleting it.
- Ask a clarifying question when input is ambiguous or leaves a gap that matters now.
  Otherwise don't pester the human.
- When you implement a component, put `[spec:SP-xxxx]` in a code comment at the implementing
  site, and keep interlinks current.

## Command reference
- `podium spec prime` — rules of engagement + current tree
- `podium spec tree` — component tree (ids, titles, status)
- `podium spec show <id>` — breadcrumb, children, body HTML
- `podium spec search <text…>` — find components by title/body
- `podium spec create <parent-id> "<title>" [--body <html>]`
- `podium spec update <id> [--title …] [--status active|draft|superseded] [--parent <id>] [--body <html> | --body-file <path>]`
- `podium spec remove <id>` — leaf components only
- `--repoPath` is inferred from your cwd when omitted; `--json` for programmatic parsing.
