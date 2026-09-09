// Parent fixture: stands in for a supervisor that VANISHES. It starts one child
// under the shape its arm names, waits until the child's instrument is provably
// armed, then exits without calling disconnect() and without killing anything —
// the response a handover has to survive.
//
// argv: <arm> <childBin> <heartbeatFile> <lifetimeMs>
import { spawn, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { probeJob } from "./jobprobe.ts";

const arm = process.argv[2] ?? "channelled";
const childBin = process.argv[3];
const beatFile = process.argv[4];
const lifetimeMs = process.argv[5] ?? "40000";

type Shape = { stdio: StdioOptions; detached: boolean; viaShell?: boolean };

// The arms differ ONLY in how the parent started the child. That is what makes
// them a discriminator: whichever of them survives names the cause.
const ARMS: Record<string, Shape> = {
  // The POD-3760 shape: a real IPC channel.
  channelled: { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: false },
  // Plain pipes the parent owns — the control the coordinator asked for.
  piped: { stdio: ["ignore", "pipe", "pipe"], detached: false },
  // No inherited handles at all: isolates "orphaned" from "handle closed".
  ignored: { stdio: ["ignore", "ignore", "ignore"], detached: false },
  // Detached: does the survival follow a flag that is ours to set?
  "ignored-detached": { stdio: ["ignore", "ignore", "ignore"], detached: true },
  // THE design arm: a channel AND detached. A supervisor that wants both a live
  // child after its own death and a channel while it lives has to use this
  // shape, so whether 'disconnect' still arrives here is the actual question.
  "channelled-detached": { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true },
  // Started by the SHELL, not by this runtime, and orphaned the moment the
  // shell exits. If this one lives where the direct arms die, the runtime's own
  // spawn is what kills children — a property that travels off CI. If it dies
  // too, the machine kills orphans and the question really does need a desktop.
  "shell-spawned": { stdio: ["ignore", "ignore", "ignore"], detached: false, viaShell: true },
};

const shape = ARMS[arm];
if (!shape || !childBin || !beatFile) {
  process.stdout.write(
    `EXPERIMENT_RESULT ${JSON.stringify({ arm, ok: false, error: "bad argv" })}\n`,
  );
  process.exit(0);
}

const childArgs = [arm, beatFile, lifetimeMs];
let spawnError = "";
let directPid: number | undefined;

if (shape.viaShell) {
  // The shell starts the child and exits at once, so the child is orphaned by a
  // process this runtime never spawned. `start /b ""` needs the empty title or
  // cmd reads the program path as one.
  const p =
    process.platform === "win32"
      ? spawn("cmd", ["/d", "/c", "start", "/b", "", childBin, ...childArgs], {
          stdio: ["ignore", "ignore", "ignore"],
        })
      : spawn("sh", ["-c", '"$0" "$@" &', childBin, ...childArgs], {
          stdio: ["ignore", "ignore", "ignore"],
        });
  directPid = p.pid;
  p.on("error", (e) => {
    spawnError = `${e.name}: ${e.message}`;
  });
  p.unref();
} else {
  const p = spawn(childBin, childArgs, { stdio: shape.stdio, detached: shape.detached });
  directPid = p.pid;
  // Drain rather than buffer: an unread pipe that filled would stall the child
  // and look like a death. The child writes nothing, so this should never fire.
  p.stdout?.resume();
  p.stderr?.resume();
  p.on("error", (e) => {
    spawnError = `${e.name}: ${e.message}`;
  });
  p.unref();
}

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

process.stdout.write(
  `EXPERIMENT_RESULT ${JSON.stringify({
    arm,
    ok: armed,
    armed,
    spawnError,
    // For a shell arm this is the SHELL's pid, not the child's; run.ts falls
    // back to the pid the child itself wrote into its heartbeat.
    directPid,
    childPid: shape.viaShell ? undefined : directPid,
    detached: shape.detached,
    viaShell: shape.viaShell === true,
    // The parent's OWN job, so the report can show the whole chain. Where the
    // flags CHANGE along the chain is where the job was attached.
    job: probeJob(),
    exitedAt: Date.now(),
  })}\n`,
);
// Deliberately NOT p.disconnect() and NOT p.kill(): a polite close is a
// different event from a supervisor dying, and it is the dying case that a
// handover has to survive.
process.exit(0);
