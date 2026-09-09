// Child fixture: stands in for a podium-server the supervisor started and would
// hand to a successor. It is deliberately SILENT on stdout and stderr after the
// first line — every arm differs only in which handles the parent held, so a
// write that could fail with EPIPE once the parent is gone would confound the
// `piped` arm with a death that has nothing to do with orphaning.
//
// argv: <arm> <heartbeatFile> <lifetimeMs>
import { writeFileSync } from "node:fs";
import { probeJob } from "./jobprobe.ts";

const arm = process.argv[2] ?? "unknown";
const beatFile = process.argv[3] ?? "";
const lifetimeMs = Number(process.argv[4] ?? 30_000);
const BEAT_MS = 250;

const startedAt = Date.now();
let n = 0;
let disconnectAt: number | null = null;

// The job-object reading is corroboration, so it is captured once, at startup,
// and carried in every beat rather than written through a second instrument
// that could fail independently.
const job = probeJob();

function writeBeat(): void {
  n += 1;
  try {
    writeFileSync(
      beatFile,
      JSON.stringify({
        arm,
        pid: process.pid,
        n,
        at: Date.now(),
        sinceStartMs: Date.now() - startedAt,
        hasProcessSend: typeof process.send === "function",
        disconnectAtMs: disconnectAt === null ? null : disconnectAt - startedAt,
        job,
      }),
    );
  } catch {}
}

// Synchronous first beat: a live child ALWAYS has at least one. Without it, a
// child killed instantly and a heartbeat that never worked both read as zero,
// and telling those two apart is the entire point of the instrument.
writeBeat();

// Only the channelled arm has a channel at all. Record that the runtime told us
// and KEEP BEATING — POD-3760 exited here, which fused "was told" and "died"
// into one observation. They are different facts and a handover needs both.
process.on("disconnect", () => {
  disconnectAt = Date.now();
  writeBeat();
});

const beat = setInterval(() => {
  writeBeat();
  if (Date.now() - startedAt >= lifetimeMs) {
    clearInterval(beat);
    // A clean self-exit, flagged, so a child that ran out its own clock is not
    // mistaken for one the platform killed.
    try {
      writeFileSync(
        `${beatFile}.exit`,
        JSON.stringify({ arm, pid: process.pid, reason: "lifetime", n, at: Date.now() }),
      );
    } catch {}
    process.exit(0);
  }
}, BEAT_MS);

// Never outlive the harness even if the interval is somehow lost.
setTimeout(() => process.exit(7), lifetimeMs + 30_000);
