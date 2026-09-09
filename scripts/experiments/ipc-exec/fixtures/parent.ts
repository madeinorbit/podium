// Parent fixture: the supervisor upgrading itself in place.
//
// ONE compiled binary plays both generations. Generation 1 starts a child over an
// 'ipc' channel, proves the channel works, then replaces itself with the same binary.
// Generation 2 — same pid, new image — asks whether it still has the channel.
//
// argv: <mode> <child binary>
// modes:
//   bun-execve          replace via the runtime's process.execve()
//   raw-execve          replace via libc execve(), after clearing FD_CLOEXEC
//   raw-execve-cloexec  replace via libc execve(), leaving FD_CLOEXEC SET
//
// The third mode is the control that makes the second mean something: if the fd
// survives with the bit cleared AND vanishes with it set, the clearing step is what
// did the work. Without it, "the fd survived" could just be an exec that never
// closed anything.
import { spawn } from "node:child_process";
import fs from "node:fs";
import * as libc from "./libc.ts";

const mode = process.argv[2] ?? "raw-execve";
const childBin = process.argv[3] ?? "";
const generation = process.env.IPC_EXEC_GENERATION === "2" ? 2 : 1;
const stateFile = process.env.IPC_EXEC_CHILD_STATE ?? "";

function openFds(max = 64): number[] {
  const out: number[] = [];
  for (let fd = 0; fd <= max; fd++) {
    try {
      fs.fstatSync(fd);
      out.push(fd);
    } catch {}
  }
  return out;
}

type FdIdentity = { state: string; dev: string; ino: string };

// Identity, not fd NUMBER. An exec that closes fd 11 frees the number, and the new
// image promptly reuses it — so fstat() succeeding says only that SOMETHING is open
// there. dev+ino says whether it is the same open file. An earlier version of this
// probe reported the CLOEXEC control as "survived" for exactly that reason.
function fdIdentity(fd: number): FdIdentity {
  try {
    const s = fs.fstatSync(fd);
    const state = s.isSocket() ? "socket" : s.isFIFO() ? "fifo" : s.isFile() ? "file" : "other";
    return { state, dev: String(s.dev), ino: String(s.ino) };
  } catch (err) {
    return { state: `closed:${(err as NodeJS.ErrnoException).code ?? "?"}`, dev: "", ino: "" };
  }
}

function describeFd(fd: number): string {
  return fdIdentity(fd).state;
}

function sameFd(before: FdIdentity | undefined, now: FdIdentity): boolean {
  if (!before || before.ino === "" || now.ino === "") return false;
  return before.dev === now.dev && before.ino === now.ino && before.state === now.state;
}

function emit(result: Record<string, unknown>): never {
  process.stdout.write(`EXPERIMENT_RESULT ${JSON.stringify({ mode, ...result })}\n`);
  process.exit(0); // a negative finding is a result, not a broken harness
}

function readChildState(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- generation 2
if (generation === 2) {
  const gen1 = JSON.parse(process.env.IPC_EXEC_GEN1 ?? "{}");
  const channelFd = Number(process.env.IPC_EXEC_CHANNEL_FD);
  const controlFd = Number(process.env.IPC_EXEC_CONTROL_FD);

  const stateAtExec = JSON.parse(process.env.IPC_EXEC_CHILD_STATE_AT_EXEC ?? "null");
  // Let the child run a few beats so "still alive" is a measurement, not a guess.
  await Bun.sleep(1_500);
  const stateAfter = readChildState();

  const roundTrip: Record<string, unknown> = { attempted: false };
  if (typeof process.send === "function") {
    roundTrip.attempted = true;
    const nonce = `gen2-${process.pid}-${Date.now()}`;
    const reply = await new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 5_000);
      process.on("message", (m: Record<string, unknown>) => {
        // Only OUR nonce counts. Anything else could be a pre-exec reply still in
        // the socket buffer, which would prove nothing about life after the exec.
        if (m?.type === "echo" && m.nonce === nonce) {
          clearTimeout(timer);
          resolve(m);
        }
      });
      try {
        process.send?.({ kind: "echo", nonce, seq: 1 });
      } catch (err) {
        clearTimeout(timer);
        resolve({ sendThrew: (err as Error).message });
      }
    });
    roundTrip.reply = reply;
    roundTrip.ok = reply?.nonce === nonce;
    // Same child, or did we somehow reach a different process?
    roundTrip.sameChild = reply?.childPid === gen1.childPid;
  }

  emit({
    gen1,
    generation: 2,
    pid: process.pid,
    // Same pid across the exec is what makes this an IN-PLACE upgrade rather than
    // a restart; if it differs, the whole premise of the run is wrong.
    pidUnchanged: process.pid === gen1.pid,
    channelFd: {
      fd: channelFd,
      now: fdIdentity(channelFd),
      atExec: gen1.channelFdIdentity,
      survived: sameFd(gen1.channelFdIdentity, fdIdentity(channelFd)),
    },
    controlFd: {
      fd: controlFd,
      now: fdIdentity(controlFd),
      atExec: gen1.controlFdIdentity,
      survived: sameFd(gen1.controlFdIdentity, fdIdentity(controlFd)),
    },
    // process.send existing is NOT the same as the channel working. The dangerous
    // case is exactly the one where the runtime offers it and every send is lost.
    hasProcessSend: typeof process.send === "function",
    roundTrip,
    child: { atExec: stateAtExec, after: stateAfter },
  });
}

// ---------------------------------------------------------------- generation 1
if (!libc.available && mode !== "bun-execve") {
  emit({ generation: 1, skipped: `libc unavailable: ${libc.loadError}` });
}

const fdsBefore = new Set(openFds());
const child = spawn(childBin, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });

const hello = await new Promise<Record<string, unknown> | null>((resolve) => {
  const timer = setTimeout(() => resolve(null), 15_000);
  child.on("message", (m: Record<string, unknown>) => {
    if (m?.type === "hello") {
      clearTimeout(timer);
      resolve(m);
    }
  });
  child.on("error", () => {
    clearTimeout(timer);
    resolve(null);
  });
});
if (!hello) emit({ generation: 1, failedStage: "child never said hello" });

// ARMING: the channel must demonstrably work BEFORE the exec. Without this, a dead
// channel in generation 2 could mean the exec killed it or that it never lived.
const preNonce = `gen1-${process.pid}`;
const preExecRoundTrip = await new Promise<boolean>((resolve) => {
  const timer = setTimeout(() => resolve(false), 10_000);
  child.on("message", (m: Record<string, unknown>) => {
    if (m?.type === "echo" && m.nonce === preNonce) {
      clearTimeout(timer);
      resolve(true);
    }
  });
  child.send({ kind: "echo", nonce: preNonce, seq: 0 });
});
if (!preExecRoundTrip) {
  child.kill();
  emit({ generation: 1, failedStage: "channel did not work before the exec" });
}

// The runtime does not expose the parent end's descriptor, so find it by diffing the
// fd table across the spawn. Every added fd is reported, so a reader can see the
// choice was unambiguous rather than trusting the pick.
const added = openFds().filter((fd) => !fdsBefore.has(fd));
const channelFd = added.find((fd) => describeFd(fd) === "socket");
if (channelFd === undefined) {
  child.kill();
  emit({ generation: 1, failedStage: "could not locate the parent end of the channel", added });
}

// A control descriptor the runtime has no stake in. If BOTH it and the channel die,
// the exec path drops everything; if only the channel dies, the runtime tore it down.
const controlFd = fs.openSync(childBin, "r");

const channelFlags = libc.clearCloexec_or_read(channelFd, mode !== "raw-execve-cloexec");
const controlFlags = libc.clearCloexec_or_read(controlFd, mode !== "raw-execve-cloexec");

const gen1 = {
  pid: process.pid,
  childPid: child.pid,
  hello,
  preExecRoundTrip,
  addedFds: added,
  channelFd,
  controlFd,
  channelFdFlags: channelFlags,
  controlFdFlags: controlFlags,
  channelFdIdentity: fdIdentity(channelFd),
  controlFdIdentity: fdIdentity(controlFd),
  libcAvailable: libc.available,
};

// Let the child go on living independently of this process object.
child.unref();

const env: Record<string, string | undefined> = {
  ...process.env,
  IPC_EXEC_GENERATION: "2",
  IPC_EXEC_GEN1: JSON.stringify(gen1),
  IPC_EXEC_CHANNEL_FD: String(channelFd),
  IPC_EXEC_CONTROL_FD: String(controlFd),
  IPC_EXEC_CHILD_STATE_AT_EXEC: JSON.stringify(readChildState()),
  // Offering the surviving descriptor to the new image the only way a runtime
  // accepts one. Generation 2 checks whether that offer is honoured or hollow.
  NODE_CHANNEL_FD: String(channelFd),
};

const argv = [process.execPath, mode, childBin];
if (mode === "bun-execve") {
  process.execve(process.execPath, argv, env as NodeJS.ProcessEnv);
} else {
  libc.rawExecve(process.execPath, argv, env);
}

// Reached only if the exec FAILED — exec does not return on success.
emit({ generation: 1, failedStage: "exec returned instead of replacing the process", gen1 });
