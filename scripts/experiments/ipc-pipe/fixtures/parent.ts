// Parent fixture: stands in for the supervisor. Compiled with `bun build --compile`,
// and it starts TWO compiled children at once (server + daemon), because the real
// question is whether two independent channels coexist, not whether one works.
//
// argv: <mode: node-ipc|node-ipc-detached|bun-ipc> <child binary> <grandchild binary>
import { spawn } from "node:child_process";

const mode = process.argv[2] ?? "node-ipc";
const childBin = process.argv[3];
const grandchildBin = process.argv[4];
const ROLES = ["server", "daemon"] as const;
type Role = (typeof ROLES)[number];

const inbox: Record<Role, Record<string, unknown>[]> = { server: [], daemon: [] };
const result: Record<string, unknown> = { mode, platform: process.platform, arch: process.arch };

const BIG = "x".repeat(256 * 1024); // 256 KiB — well past any single pipe write.

type Handle = { send: (m: unknown) => void; kill: () => void; exited: Promise<number | null> };

function startNodeIpc(role: Role, detached: boolean): Handle {
  const p = spawn(childBin, [role, grandchildBin], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached,
  });
  p.on("message", (m) => inbox[role].push(m as Record<string, unknown>));
  p.stderr?.on("data", (d) => process.stderr.write(`[${role}] ${d}`));
  return {
    send: (m) => p.send(m as never),
    kill: () => p.kill(),
    exited: new Promise((r) => p.on("exit", (c) => r(c))),
  };
}

function startBunIpc(role: Role): Handle {
  const p = Bun.spawn([childBin, role, grandchildBin], {
    stdio: ["ignore", "inherit", "inherit"],
    serialization: "json",
    ipc(message: unknown) {
      inbox[role].push(message as Record<string, unknown>);
    },
  });
  return { send: (m) => p.send(m as never), kill: () => p.kill(), exited: p.exited };
}

function fail(stage: string, err: unknown): never {
  result.ok = false;
  result.failedStage = stage;
  result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stdout.write(`EXPERIMENT_RESULT ${JSON.stringify(result)}\n`);
  process.exit(0); // A negative finding is a successful experiment, not a broken harness.
}

async function waitFor(role: Role, type: string, ms: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = inbox[role].find((m) => m.type === type);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timeout waiting for '${type}' from ${role}`);
    await Bun.sleep(25);
  }
}

// The orphan mode is a separate, tiny experiment: start ONE child, wait until it is
// talking, then exit without killing it. Whether the child notices is read from the
// file it writes, not from this channel.
if (mode === "orphan") {
  const p = spawn(childBin, ["server", grandchildBin], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const seen = await new Promise<boolean>((r) => {
    const t = setTimeout(() => r(false), 15_000);
    p.on("message", () => {
      clearTimeout(t);
      r(true);
    });
  });
  p.unref();
  // Deliberately NOT p.disconnect(): a polite close is a different event from a
  // supervisor dying, and it is the dying case a handover has to survive. Exiting
  // here drops the parent's end the way a crash would.
  process.stdout.write(
    `EXPERIMENT_RESULT ${JSON.stringify({ mode, childSpoke: seen, childPid: p.pid })}\n`,
  );
  process.exit(0);
}

const kids: Record<string, Handle> = {};
try {
  const start: (r: Role) => Handle =
    mode === "bun-ipc"
      ? startBunIpc
      : // The daemon may well be started detached so it can outlive a supervisor
        // restart. Detaching puts it in its own process group; this mode asks
        // whether the channel still works when it is.
        (r) => startNodeIpc(r, mode === "node-ipc-detached");
  for (const role of ROLES) kids[role] = start(role);

  // 1. Child -> parent, unprompted, at startup.
  const hellos: Record<string, unknown> = {};
  for (const role of ROLES) hellos[role] = await waitFor(role, "hello", 15_000);
  result.hello = hellos;

  // 2. Parent -> child -> parent, interleaved across both channels, to catch crossed wires.
  for (let seq = 0; seq < 5; seq++) {
    for (const role of ROLES) kids[role].send({ kind: "echo", seq, payload: `${role}-${seq}` });
  }
  const echoes: Record<string, unknown> = {};
  for (const role of ROLES) {
    await waitFor(role, "echo", 15_000);
    await Bun.sleep(300);
    const got = inbox[role].filter((m) => m.type === "echo");
    echoes[role] = {
      count: got.length,
      inOrder: got.every((m, i) => m.seq === i),
      // A payload tagged with the OTHER role would mean the channels are crossed.
      allOwnRole: got.every((m) => String(m.payload).startsWith(role)),
    };
  }
  result.roundTrip = echoes;

  // 3. A 256 KiB frame: does the channel reassemble a message larger than a pipe buffer?
  kids.server.send({ kind: "size", seq: 99, payload: BIG });
  const big = await waitFor("server", "size", 20_000);
  result.largeFrame = { sent: BIG.length, echoedLen: big.len, intact: big.len === BIG.length };

  // 4. THE containment question: does a grandchild inherit the channel?
  const gc: Record<string, unknown> = {};
  for (const role of ROLES) kids[role].send({ kind: "spawn-grandchildren" });
  for (const role of ROLES) {
    const m = await waitFor(role, "grandchildren", 40_000);
    const shell = String(m.shell ?? "");
    gc[role] = {
      bunGrandchildReport: String(m.bun ?? ""),
      controlGrandchildReport: String(m.control ?? ""),
      // Same rule as channelEnv(), applied to the shell's raw KEY=VALUE dump.
      leakedEnvVars: shell
        .split(/\r?\n/)
        .filter((l) => /^(NODE_CHANNEL_FD|BUN_INTERNAL_IPC_FD|ELECTRON_INTERNAL_CHANNEL_FD)=/.test(l))
        .concat(
          shell
            .split(/\r?\n/)
            .filter((l) => /^\w*(CHANNEL|IPC|_FD)\w*=(\d{1,4}|\\\\[.?]\\pipe\\\S+)$/i.test(l)),
        ),
      // /dev/fd listing, posix only; windows has no equivalent and reports "".
      fdListing: shell.includes("---FDS---") ? (shell.split("---FDS---")[1] ?? "").trim() : "",
    };
  }
  result.grandchildren = gc;

  // 5. Anything a grandchild managed to push into the supervisor's inbox is a leak.
  result.leakedMessagesInParentInbox = ROLES.flatMap((r) =>
    inbox[r].filter((m) => m.from === "grandchild"),
  );

  for (const role of ROLES) kids[role].send({ kind: "bye" });
  result.exitCodes = Object.fromEntries(
    await Promise.all(ROLES.map(async (r) => [r, await kids[r].exited])),
  );
  result.ok = true;
} catch (err) {
  for (const h of Object.values(kids)) {
    try {
      h.kill();
    } catch {}
  }
  fail("run", err);
}

process.stdout.write(`EXPERIMENT_RESULT ${JSON.stringify(result)}\n`);
process.exit(0);
