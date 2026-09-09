#!/usr/bin/env bun
// POD-3774 (epic POD-3758): when a supervisor vanishes, does its child die, and is
// it told?
//
// POD-3760 measured a windows-latest child that got no 'disconnect' AND stopped
// beating. Two readings survived and a single arm cannot separate them:
//   (a) Windows/bun tears an IPC-channel child down with its parent, silently;
//   (b) the Actions runner's job object kills the orphan whatever the stdio.
// They differ sharply on a CONTROL: under (a) only the channelled child dies,
// under (b) every orphan does. So this runs four arms that differ ONLY in what
// the parent held open, and reports a survival WINDOW rather than a boolean so
// "died at once" and "died later" are distinguishable.
//
// Contract with .github/workflows/platform-experiment.yml: run with `bun run.ts`,
// write result.json under EXPERIMENT_OUT, print a markdown summary, and exit 0
// whenever the experiment actually ran. A "no" is a result, not a CI failure.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dir;
const outDir = process.env.EXPERIMENT_OUT ?? path.join(process.cwd(), "experiment-out");
const binDir = path.join(outDir, "bin");
fs.mkdirSync(binDir, { recursive: true });
const exe = process.platform === "win32" ? ".exe" : "";

const ARMS = ["channelled", "piped", "ignored", "ignored-detached"] as const;
type Arm = (typeof ARMS)[number];
const OBSERVE_MS = 12_000; // the window POD-3760 used, so the numbers compare
const CHILD_LIFETIME_MS = 40_000; // comfortably past the window: no self-exit inside it

function sh(cmd: string, args: string[], cwd = here): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill(), 180_000);
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

const bins: Record<string, string> = {};
for (const name of ["parent", "child"]) {
  const outfile = path.join(binDir, name + exe);
  const r = await sh(process.execPath, [
    "build",
    "--compile",
    path.join(here, "fixtures", `${name}.ts`),
    "--outfile",
    outfile,
  ]);
  if (r.code !== 0 || !fs.existsSync(outfile)) {
    console.error(`FATAL: could not compile ${name}\n${r.out}`);
    process.exit(1); // harness broken — this one IS a CI failure
  }
  bins[name] = outfile;
  console.log(`compiled ${name} -> ${outfile}`);
}

type Beat = {
  n: number;
  at: number;
  pid: number;
  hasProcessSend: boolean;
  disconnectAtMs: number | null;
  job?: Record<string, unknown>;
};

/** Reads may tear against the child's write; the caller keeps the last good one. */
function readBeat(f: string): Beat | null {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as Beat;
  } catch {
    return null;
  }
}

/** Second, independent instrument: does the OS still know the pid? Guards against
 *  "the heartbeat file stopped" being a broken writer rather than a dead process. */
function liveness(pid: number | undefined): "alive" | "gone" | "unknown" {
  if (!pid) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    // EPERM means it exists but is not ours to signal — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM" ? "alive" : "gone";
  }
}

const armResults: Record<string, unknown> = {};

for (const arm of ARMS) {
  console.log(`\n=== arm: ${arm} ===`);
  const beatFile = path.join(outDir, `${arm}.heartbeat.json`);
  for (const f of [beatFile, `${beatFile}.exit`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {}
  }

  const r = await sh(bins.parent, [arm, bins.child, beatFile, String(CHILD_LIFETIME_MS)], outDir);
  const parentExitedAt = Date.now();
  const line = r.out.split(/\r?\n/).find((l) => l.startsWith("EXPERIMENT_RESULT "));
  const parentSays = line
    ? (JSON.parse(line.slice("EXPERIMENT_RESULT ".length)) as Record<string, unknown>)
    : { ok: false, error: "no-result-line", tail: r.out.slice(-1000) };

  const beatAtParentExit = readBeat(beatFile);
  const childPid = (parentSays.childPid as number | undefined) ?? beatAtParentExit?.pid;

  // Sample the whole window rather than only its end: the SHAPE of the trace is
  // what separates "died with the parent" from "died some seconds later".
  const samples: { t: number; n: number; alive: string }[] = [];
  let lastGood = beatAtParentExit;
  const deadline = parentExitedAt + OBSERVE_MS;
  while (Date.now() < deadline) {
    const b = readBeat(beatFile);
    if (b) lastGood = b;
    samples.push({
      t: Date.now() - parentExitedAt,
      n: lastGood?.n ?? 0,
      alive: liveness(childPid),
    });
    await Bun.sleep(250);
  }

  const startBeats = beatAtParentExit?.n ?? 0;
  const finalBeats = lastGood?.n ?? 0;
  const beatsAfterParentExit = finalBeats - startBeats;
  // The survival WINDOW, not a boolean: how long after the supervisor vanished
  // did the child keep proving it was alive?
  const lastBeatAt = lastGood?.at ?? 0;
  const survivalMs = lastBeatAt > 0 ? Math.max(0, lastBeatAt - parentExitedAt) : 0;
  const selfExit = readBeat(`${beatFile}.exit`) as unknown as { reason?: string } | null;
  const finalLiveness = liveness(childPid);

  armResults[arm] = {
    parentSays,
    childPid,
    // Zero here means the child never wrote its synchronous first beat: the
    // instrument, not the platform, is what failed, and the arm says nothing.
    instrumentArmed: startBeats >= 1,
    hadChannel: beatAtParentExit?.hasProcessSend ?? null,
    disconnectSeen: (lastGood?.disconnectAtMs ?? null) !== null,
    disconnectAtMs: lastGood?.disconnectAtMs ?? null,
    beatsAtParentExit: startBeats,
    beatsFinal: finalBeats,
    beatsAfterParentExit,
    outlivedParent: beatsAfterParentExit > 0,
    survivalMs,
    survivedWholeWindow: survivalMs >= OBSERVE_MS - 1500,
    livenessAtEnd: finalLiveness,
    selfExited: selfExit?.reason ?? null,
    job: beatAtParentExit?.job ?? null,
    samples,
  };
  const a = armResults[arm] as Record<string, unknown>;
  console.log(
    `armed=${a.instrumentArmed} channel=${a.hadChannel} disconnect=${a.disconnectSeen} ` +
      `beatsAfter=${a.beatsAfterParentExit} survivalMs=${a.survivalMs} pid=${a.livenessAtEnd}`,
  );
}

// --- discrimination -------------------------------------------------------
type ArmView = { instrumentArmed: boolean; outlivedParent: boolean; disconnectSeen: boolean };
const view = (a: Arm) => armResults[a] as unknown as ArmView;

function discriminate(): { code: string; reading: string } {
  const unarmed = ARMS.filter((a) => !view(a).instrumentArmed);
  if (unarmed.length > 0) {
    return {
      code: "inconclusive-unarmed",
      reading: `arms ${unarmed.join(", ")} never wrote a first heartbeat — the instrument failed, so this run says nothing about them`,
    };
  }
  const ch = view("channelled");
  const plain = (["piped", "ignored", "ignored-detached"] as const).map(view);
  const allPlainLived = plain.every((p) => p.outlivedParent);
  const allPlainDied = plain.every((p) => !p.outlivedParent);

  if (!ch.outlivedParent && allPlainDied) {
    return {
      code: "environment-kills-orphans",
      reading:
        "reading (b): EVERY orphan died, channel or not. The environment kills orphans; the IPC channel is not implicated.",
    };
  }
  if (!ch.outlivedParent && allPlainLived) {
    return {
      code: "channel-kills-child",
      reading:
        "reading (a): only the CHANNELLED child died while every plain orphan lived. The channel itself tears the child down, so a supervisor cannot hand live children to a successor over it.",
    };
  }
  if (ch.outlivedParent && ch.disconnectSeen) {
    return {
      code: "orphans-survive-told",
      reading:
        "the child outlived its supervisor AND was told: 'disconnect' is a complete death signal here.",
    };
  }
  if (ch.outlivedParent && !ch.disconnectSeen) {
    return {
      code: "orphans-survive-untold",
      reading:
        "the child outlived its supervisor and was NEVER told. Silence is not a death signal: this leg needs a positive parent-liveness check.",
    };
  }
  return { code: "mixed", reading: "arms disagree in a way neither reading predicts — read the table." };
}

const results = {
  experiment: "orphan-survival",
  platform: process.platform,
  arch: process.arch,
  bunVersion: Bun.version,
  runner: process.env.RUNNER_NAME ?? "local",
  runnerOs: process.env.ImageOS ?? "",
  observeMs: OBSERVE_MS,
  childLifetimeMs: CHILD_LIFETIME_MS,
  arms: armResults,
  discrimination: discriminate(),
  finishedAt: new Date().toISOString(),
};

fs.writeFileSync(path.join(outDir, "result.json"), `${JSON.stringify(results, null, 2)}\n`);

const jobLine = (() => {
  const j = (armResults.channelled as { job?: Record<string, unknown> | null })?.job;
  if (!j || j.available !== true) return `Job object: n/a (${j?.error ?? "not probed"})`;
  if (j.inJob !== true) return "Job object: process is **not in a job**";
  return `Job object: **in a job**, KILL_ON_JOB_CLOSE=${j.killOnJobClose ?? "unreadable"}, BREAKAWAY_OK=${j.breakawayOk ?? "?"}, SILENT_BREAKAWAY_OK=${j.silentBreakawayOk ?? "?"}${j.queryError ? ` (query error ${j.queryError})` : ""}`;
})();

const md = [
  `### orphan-survival — \`${process.platform}/${process.arch}\` (bun ${Bun.version}, ${results.runner})`,
  "",
  `**${results.discrimination.reading}**`,
  "",
  jobLine,
  "",
  "| arm | instrument armed | had channel | 'disconnect' | beats after parent exit | survived for | pid at end |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...ARMS.map((a) => {
    const r = armResults[a] as Record<string, unknown>;
    const surv = r.survivedWholeWindow
      ? `✅ whole ${OBSERVE_MS / 1000}s window`
      : r.outlivedParent
        ? `⚠️ ${r.survivalMs}ms then stopped`
        : "❌ died with the parent";
    return `| \`${a}\` | ${r.instrumentArmed ? "✅" : "❌ NOT ARMED"} | ${r.hadChannel ? "yes" : "no"} | ${r.disconnectSeen ? `✅ +${r.disconnectAtMs}ms` : "—"} | ${r.beatsAfterParentExit} | ${surv} | ${r.livenessAtEnd} |`;
  }),
  "",
  "<details><summary>raw result.json</summary>",
  "",
  "```json",
  JSON.stringify(results, null, 2),
  "```",
  "",
  "</details>",
].join("\n");

console.log(`\n${md}`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
