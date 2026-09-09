// Child fixture: stands in for podium-server / podium-daemon started by the supervisor.
// Compiled with `bun build --compile`, so it is a standalone binary with no bun on PATH
// and no interpreter argv able to carry a channel flag.
import { spawn } from "node:child_process";
import { probeFds, channelEnv } from "./probe.ts";

const role = process.argv[2] ?? "child";
const grandchildBin = process.argv[3] ?? "";

function send(msg: unknown): boolean {
  if (typeof process.send !== "function") return false;
  try {
    process.send(msg);
    return true;
  } catch {
    return false;
  }
}

send({
  type: "hello",
  role,
  pid: process.pid,
  hasProcessSend: typeof process.send === "function",
  hasProcessChannel: (process as { channel?: unknown }).channel != null,
  channelEnv: channelEnv(process.env),
  fds: probeFds(),
});

// withIpc=false is how the daemon starts a pty host / agent session today. withIpc=true
// is the POSITIVE CONTROL: a channel deliberately handed down, so we can prove the
// containment probe is able to SEE one. A containment pass from a probe that cannot
// detect a real leak would mean nothing.
function run(
  cmd: string,
  args: string[],
  withIpc = false,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const stdio = withIpc
      ? ["ignore", "pipe", "pipe", "ipc"]
      : ["ignore", "pipe", "pipe"];
    const p = spawn(cmd, args, { stdio: stdio as never });
    let out = "";
    p.stdout?.on("data", (d) => (out += d));
    p.stderr?.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill(), 15_000);
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: null, out: `spawn error: ${e.message}` });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

process.on("message", async (msg: Record<string, unknown>) => {
  const kind = msg?.kind;
  if (kind === "echo") {
    send({ type: "echo", role, seq: msg.seq, payload: msg.payload });
  } else if (kind === "size") {
    // Echo back only the length: proves a large frame survived without doubling it.
    send({ type: "size", role, seq: msg.seq, len: String(msg.payload ?? "").length });
  } else if (kind === "spawn-grandchildren") {
    // 1. A compiled Bun grandchild, spawned the ordinary way — the containment case.
    const bun = grandchildBin ? await run(grandchildBin, []) : { code: null, out: "no binary" };
    // 2. A plain shell dumps the TRUE inherited environment and open fds. A Bun
    //    grandchild cannot do this: if Bun consumes and deletes its own channel
    //    variable, process.env would hide the very leak we are looking for.
    const shell =
      process.platform === "win32"
        ? await run("cmd", ["/d", "/c", "set"])
        : await run("sh", ["-c", "env; echo ---FDS---; ls -l /dev/fd/ 2>/dev/null || true"]);
    // 3. The positive control.
    const control = grandchildBin
      ? await run(grandchildBin, [], true)
      : { code: null, out: "no binary" };
    send({
      type: "grandchildren",
      role,
      bun: bun.out.trim(),
      shell: shell.out,
      control: control.out.trim(),
    });
  } else if (kind === "bye") {
    send({ type: "bye", role });
    setTimeout(() => process.exit(0), 100);
  }
});

// Never outlive the harness, even if no message ever arrives.
setTimeout(() => process.exit(7), 90_000);
