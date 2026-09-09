#!/usr/bin/env bun
// POD-3760 experiment: is the runtime's built-in parent->child IPC channel usable
// between `bun --compile` binaries on linux/macOS/windows, and is it CONTAINED
// (does a grandchild — an agent session, a pty host — inherit it)?
//
// Contract with .github/workflows/platform-experiment.yml: run with `bun run.ts`,
// write result.json under EXPERIMENT_OUT, print a markdown summary, and exit 0
// whenever the experiment actually ran. A "no" is a result, not a CI failure;
// only a broken harness (fixtures will not compile) exits non-zero.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { channelEnv } from "./fixtures/probe.ts";

const here = import.meta.dir;
const outDir = process.env.EXPERIMENT_OUT ?? path.join(process.cwd(), "experiment-out");
const binDir = path.join(outDir, "bin");
fs.mkdirSync(binDir, { recursive: true });
const exe = process.platform === "win32" ? ".exe" : "";

function sh(cmd: string, args: string[], cwd = here): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, IPC_EXPERIMENT_DISCONNECT_FILE: path.join(outDir, "disconnect.json") },
    });
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
for (const name of ["parent", "child", "grandchild"]) {
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

// Calibrate the env probe before trusting anything it says. An earlier version matched
// the bare word CHANNEL and read GitHub's POWERSHELL_DISTRIBUTION_CHANNEL as a leak on
// Linux and Windows. This runs on every platform so each report carries the proof that
// its own probe both fires on a real channel variable and stays quiet on noise.
const probeCalibration = (() => {
  const cases: [string, Record<string, string>, boolean][] = [
    ["node channel var", { NODE_CHANNEL_FD: "3" }, true],
    ["bun channel var", { BUN_INTERNAL_IPC_FD: "4" }, true],
    ["unknown name, fd-shaped value", { WEIRD_IPC_HANDLE: "7" }, true],
    ["unknown name, windows pipe", { SOME_CHANNEL_FD: String.raw`\\.\pipe\podium-abc` }, true],
    ["github runner noise", { POWERSHELL_DISTRIBUTION_CHANNEL: "GitHub-Actions-Linux" }, false],
    ["unrelated CHANNEL name", { CHANNEL_NAME: "stable" }, false],
  ];
  const misclassified = cases
    .filter(([, env, want]) => Object.keys(channelEnv(env as never)).length > 0 !== want)
    .map(([name]) => name);
  return { cases: cases.length, misclassified, armed: misclassified.length === 0 };
})();

const results: Record<string, unknown> = {
  probeCalibration,
  experiment: "ipc-pipe",
  platform: process.platform,
  arch: process.arch,
  bunVersion: Bun.version,
  runner: process.env.RUNNER_NAME ?? "local",
  runnerOs: process.env.ImageOS ?? "",
  startedAt: new Date().toISOString(),
  modes: {} as Record<string, unknown>,
};

for (const mode of ["node-ipc", "node-ipc-detached", "bun-ipc"]) {
  console.log(`\n=== mode: ${mode} ===`);
  const r = await sh(bins.parent, [mode, bins.child, bins.grandchild], outDir);
  const line = r.out.split(/\r?\n/).find((l) => l.startsWith("EXPERIMENT_RESULT "));
  (results.modes as Record<string, unknown>)[mode] = line
    ? JSON.parse(line.slice("EXPERIMENT_RESULT ".length))
    : { ok: false, failedStage: "no-result-line", exitCode: r.code, tail: r.out.slice(-2000) };
  console.log(r.out);
}

// --- does the child notice its supervisor dying? --------------------------
// The property a handover turns on. Run the parent in `orphan` mode: it starts one
// child over a channel, then exits without killing it. The child writes a file from
// its 'disconnect' handler, because the channel it would otherwise report over is the
// thing that just died.
{
  const flag = path.join(outDir, "disconnect.json");
  try {
    fs.rmSync(flag, { force: true });
  } catch {}
  const r = await sh(bins.parent, ["orphan", bins.child, bins.grandchild], outDir);
  const spoke = /"childSpoke":true/.test(r.out);
  let detected: Record<string, unknown> | null = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(flag)) {
      try {
        detected = JSON.parse(fs.readFileSync(flag, "utf8"));
      } catch {}
      break;
    }
    await Bun.sleep(100);
  }
  results.supervisorDeath = { childSpoke: spoke, disconnectSeen: detected !== null, detail: detected };
  console.log(`\n=== supervisor death === ${JSON.stringify(results.supervisorDeath)}`);
}

// --- verdicts -------------------------------------------------------------
type Verdict = { works: boolean; contained: boolean | null; probeArmed: boolean | null };

function verdict(m: Record<string, unknown> | undefined): Verdict {
  if (!m || m.ok !== true) return { works: false, contained: null, probeArmed: null };
  const rt = m.roundTrip as Record<string, { count: number; inOrder: boolean; allOwnRole: boolean }>;
  const lf = m.largeFrame as { intact: boolean };
  const works =
    Object.values(rt).every((v) => v.count === 5 && v.inOrder && v.allOwnRole) && lf.intact;

  const gc = m.grandchildren as Record<
    string,
    { bunGrandchildReport: string; controlGrandchildReport: string; leakedEnvVars: string[] }
  >;
  // The containment probe only counts if it DID see the deliberately-leaked control
  // channel. An unarmed probe cannot say "not inherited" — it can only say nothing.
  const probeArmed = Object.values(gc).every((g) =>
    /"hasProcessSend":true/.test(g.controlGrandchildReport),
  );
  const leaked = (m.leakedMessagesInParentInbox as unknown[]) ?? [];
  const contained =
    leaked.length === 0 &&
    Object.values(gc).every(
      (g) => g.leakedEnvVars.length === 0 && !/"hasProcessSend":true/.test(g.bunGrandchildReport),
    );
  return { works, contained: probeArmed ? contained : null, probeArmed };
}

const verdicts: Record<string, Verdict> = Object.fromEntries(
  Object.entries(results.modes as Record<string, Record<string, unknown>>).map(([k, v]) => [
    k,
    verdict(v),
  ]),
);
results.verdicts = verdicts;
results.finishedAt = new Date().toISOString();

fs.writeFileSync(path.join(outDir, "result.json"), `${JSON.stringify(results, null, 2)}\n`);

const md = [
  `### ipc-pipe — \`${process.platform}/${process.arch}\` (bun ${Bun.version}, ${results.runner})`,
  "",
  `Env probe calibrated: **${probeCalibration.armed ? "yes" : `NO — misclassified ${probeCalibration.misclassified.join(", ")}`}**`,
  "",
  `Child sees its supervisor die: **${
    (results.supervisorDeath as { disconnectSeen: boolean }).disconnectSeen
      ? "yes, 'disconnect' fired"
      : "NO"
  }**`,
  "",
  "| mode | bidirectional JSON channel | grandchild containment | containment probe armed |",
  "| --- | --- | --- | --- |",
  ...Object.entries(verdicts).map(
    ([k, v]) =>
      `| \`${k}\` | ${v.works ? "✅ works" : "❌ no"} | ${
        v.contained === null ? "n/a" : v.contained ? "✅ not inherited" : "❌ INHERITED"
      } | ${v.probeArmed === null ? "n/a" : v.probeArmed ? "✅ saw control leak" : "❌ BLIND"} |`,
  ),
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
