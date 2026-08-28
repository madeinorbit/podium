POD-3069 — three-agent A1c confirmation
========================================

Date: 2026-08-28 (Europe/Berlin)

The three requested A1c cells were driven at the current runtime tip with
CONTRACT=1 and STREAMING=1. Each used an isolated instance, the POD-3044
alive-send control, exact `PODIUM_INSTANCE_UUID` + `PODIUM_SESSION_ID`
attribution, SIGKILL, and a dead-session send. Since every dead send was refused
before acceptance, the 120-second delayed window was not applicable.

| driver | runtime tip | live control | exact kill | dead send | A1c |
|---|---|---:|---:|---|---:|
| claude-pty | `ad02520` | PASS | PASS | `dead-lettered: delivery-failed` | PASS |
| grok-acp | `af49f9c` | PASS | PASS | `dead-lettered: delivery-failed` | PASS |
| opencode-server | `b314090` | PASS | PASS | `dead-lettered: delivery-failed` | PASS |

Evidence details:

- [claude-pty-a1c.txt](claude-pty-a1c.txt)
- [grok-acp-a1c.txt](grok-acp-a1c.txt)
- [opencode-server-a1c.txt](opencode-server-a1c.txt)
- [a1c-stamped-child.ts](a1c-stamped-child.ts) — the issue-local adapter used
  because Claude PTY exposes an abduco master, Claude leaf, and attach client;
  it selects the unique stamped `abduco -n` durable session owner.

Claude required one explicit attribution correction. Killing only the Claude
leaf left the durable master alive and reproduced accepted-then-lost after the
full 120-second window; that diagnostic was not scored. Killing the exact
stamped durable master produced the valid PASS. This is consistent with the
known claude-pty-on-main failure being an improvement target, not a repaired
main regression. No Grok-on-main or OpenCode-on-main baseline was measured, so
those results are not described as regression repairs.

No results TSV was edited.
