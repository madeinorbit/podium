// Parent fixture: stands in for a supervisor that VANISHES. It starts one child
// under the stdio shape its arm names, waits until the child's instrument is
// provably armed, then exits without calling disconnect() and without killing
// anything — the response a handover has to survive.
//
// argv: <arm> <childBin> <heartbeatFile> <lifetimeMs>
import { spawn, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { probeJob } from "./jobprobe.ts";

const arm = process.argv[2] ?? "channelled";
const childBin = process.argv[3];
const beatFile = process.argv[4];
const lifetimeMs = process.argv[5] ?? "30000";

// The four arms differ ONLY in what the parent held open and whether the child
// was detached. That is what makes them a discriminator: if every arm dies, the
// channel is not what killed it.
const ARMS: Record<string, { stdio: StdioOptions; detached: boolean }> = {
  // The POD-3760 shape: a real IPC channel.
  channelled: { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: false },
  // Plain pipes the parent owns — the control the coordinator asked for.
  piped: { stdio: ["ignore", "pipe", "pipe"], detached: false },
  // No inherited handles at all: isolates "orphaned" from "handle closed".
  ignored: { stdio: ["ignore", "ignore", "ignore"], detached: false },
  // Same, but detached. If orphans die and this one lives, the fix is a spawn flag.
  "ignored-detached": { stdio: ["ignore", "ignore", "ignore"], detached: true },
};

const shape = ARMS[arm];
if (!shape || !childBin || !beatFile) {
  process.stdout.write(
    `EXPERIMENT_RESULT ${JSON.stringify({ arm, ok: false, error: "bad argv" })}\n`,
  );
  process.exit(0);
}

const p = spawn(childBin, [arm, beatFile, lifetimeMs], {
  stdio: shape.stdio,
  detached: shape.detached,
});
// Drain rather than buffer: an unread pipe that fills would stall the child and
// look like a death. The child writes nothing, so this should never fire.
p.stdout?.resume();
p.stderr?.resume();

let spawnError = "";
p.on("error", (e) => {
  spawnError = `${e.name}: ${e.message}`;
});

// Wait for the child's synchronous first beat. Exiting before the instrument is
// armed would make every downstream number unattributable.
const deadline = Date.now() + 15_000;
let armed = false;
while (Date.now() < deadline) {
  if (spawnError) break;
  if (existsSync(beatFile)) {
    armed = true;
    break;
  }
  await Bun.sleep(50);
}

p.unref();
process.stdout.write(
  `EXPERIMENT_RESULT ${JSON.stringify({
    arm,
    ok: armed,
    armed,
    spawnError,
    childPid: p.pid,
    // The parent's OWN job, so the report can show the whole chain. If this
    // differs from the child's, the job was attached by the spawn itself.
    job: probeJob(),
    detached: shape.detached,
    exitedAt: Date.now(),
  })}\n`,
);
// Deliberately NOT p.disconnect() and NOT p.kill(): a polite close is a
// different event from a supervisor dying, and it is the dying case that a
// handover has to survive.
process.exit(0);
