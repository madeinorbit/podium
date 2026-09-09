// Child fixture: stands in for podium-server / podium-daemon, held by the supervisor
// over a node:child_process 'ipc' channel while the supervisor execs its own new
// binary underneath it.
//
// It answers two things the parent cannot answer about itself:
//   1. did it see 'disconnect' — i.e. did the supervisor's exec look like a crash?
//   2. is it still ALIVE afterwards — without which "the channel is dead" is
//      unattributable, because a dead child has a dead channel for a boring reason.
import { writeFileSync } from "node:fs";

const stateFile = process.env.IPC_EXEC_CHILD_STATE ?? "";
const started = Date.now();
let disconnectedAfterMs: number | null = null;
let beats = 0;
let echoes = 0;

function writeState() {
  if (!stateFile) return;
  try {
    writeFileSync(
      stateFile,
      JSON.stringify({
        pid: process.pid,
        beats,
        echoes,
        disconnectedAfterMs,
        hasProcessSend: typeof process.send === "function",
        at: Date.now(),
      }),
    );
  } catch {}
}

function send(msg: unknown): boolean {
  if (typeof process.send !== "function") return false;
  try {
    process.send(msg);
    return true;
  } catch {
    return false;
  }
}

// The first beat is synchronous, so a live child ALWAYS has at least one on disk.
// Without it a child killed instantly and a state file that never worked both read
// as zero, and telling those apart is the whole job of this file.
writeState();

process.on("disconnect", () => {
  disconnectedAfterMs = Date.now() - started;
  writeState();
  // Deliberately does NOT exit. A supervisor exec'ing itself is exactly the case
  // where the child must outlive the event; exiting here would destroy the evidence
  // that the channel could have been re-adopted.
});

process.on("message", (msg: Record<string, unknown>) => {
  if (msg?.kind === "echo") {
    echoes += 1;
    // Echo the caller's own nonce back. A generation-2 parent that sees its OWN
    // nonce cannot be reading a reply that was already in flight before the exec.
    send({ type: "echo", nonce: msg.nonce, seq: msg.seq, childPid: process.pid });
    writeState();
  } else if (msg?.kind === "bye") {
    send({ type: "bye" });
    setTimeout(() => process.exit(0), 50);
  }
});

send({ type: "hello", pid: process.pid });

const beat = setInterval(() => {
  beats += 1;
  writeState();
  if (beats >= 120) {
    clearInterval(beat);
    process.exit(0);
  }
}, 250);

// Never outlive the harness.
setTimeout(() => process.exit(7), 90_000);
