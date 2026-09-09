// Grandchild fixture: a compiled Bun binary spawned by the CHILD, standing in for an
// agent session / pty host that the daemon starts. It must NOT be able to reach the
// supervisor's channel. It reports everything it can see and exits.
import { probeFds, channelEnv } from "./probe.ts";

const report = {
  role: "grandchild",
  pid: process.pid,
  hasProcessSend: typeof process.send === "function",
  hasProcessChannel: (process as { channel?: unknown }).channel != null,
  channelEnv: channelEnv(process.env),
  fds: probeFds(),
  sendAttempt: "not-attempted" as string,
};

// If the channel really did leak, this write would land in the supervisor's inbox.
if (typeof process.send === "function") {
  try {
    process.send({ from: "grandchild", leaked: true, pid: process.pid });
    report.sendAttempt = "accepted";
  } catch (err) {
    report.sendAttempt = `threw: ${(err as Error).message}`;
  }
}

process.stdout.write(`GRANDCHILD_REPORT ${JSON.stringify(report)}\n`);
process.exit(0);
