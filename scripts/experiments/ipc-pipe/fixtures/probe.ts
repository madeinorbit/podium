// Shared probes. Kept dependency-free so every fixture compiles standalone.
import fs from "node:fs";

export function probeFds(max = 6): Record<string, string> {
  const out: Record<string, string> = {};
  for (let fd = 0; fd <= max; fd++) {
    try {
      const s = fs.fstatSync(fd);
      out[String(fd)] = s.isSocket()
        ? "socket"
        : s.isFIFO()
          ? "fifo"
          : s.isCharacterDevice()
            ? "chardev"
            : s.isFile()
              ? "file"
              : "other";
    } catch {
      out[String(fd)] = "closed";
    }
  }
  return out;
}

// Any env var a runtime could use to hand a channel down. NODE_CHANNEL_FD is node's;
// BUN_INTERNAL_IPC_FD is Bun's. The wildcard catches anything we did not predict.
export function channelEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const hits: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (/CHANNEL|_IPC_|^IPC_|IPC_FD/i.test(k)) hits[k] = String(v);
  }
  return hits;
}
