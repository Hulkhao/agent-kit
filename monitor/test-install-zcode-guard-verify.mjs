// Targeted tests for install-zcode-guard.mjs --verify (read-only contract).
// Run: node test-install-zcode-guard-verify.mjs
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { install, installConfig, verify, verifyConfig } from "./install-zcode-guard.mjs";

const realScript = join(import.meta.dirname, "../plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs");
const realStopScript = join(import.meta.dirname, "../plugins/chatgpt-dispatch-guard/hooks/stop.mjs");
const guard = (scriptPath = realScript) => ({
  hooks: [{ type: "process", command: "node", args: [scriptPath], timeoutMs: 5000 }],
});
const stopGuard = (stopScriptPath = realStopScript) => ({
  hooks: [{ type: "process", command: "node", args: [stopScriptPath], timeoutMs: 5000 }],
});
const rtk = { matcher: "Bash", hooks: [{ type: "process", command: "rtk", args: ["hook", "claude"], enabled: true, timeoutMs: 5000 }] };
const full = (scriptPath = realScript, stopScriptPath = realStopScript) => ({
  hooks: { enabled: true, events: { PreToolUse: [rtk, guard(scriptPath)], Stop: [stopGuard(stopScriptPath)] } },
});

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("verify passes on canonical install (rtk + guard + stop)", () => {
  verifyConfig(full());
});

test("verify fails when guard rule absent", () => {
  let code = "";
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk], Stop: [stopGuard()] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_NOT_INSTALLED") throw new Error(code || "no throw");
});

test("verify fails on duplicate guard rules", () => {
  let code = "";
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, guard(), guard()], Stop: [stopGuard()] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_DUPLICATE_RULES") throw new Error(code || "no throw");
});

test("verify fails on duplicate guard hooks inside one group", () => {
  let code = "";
  const duplicated = { hooks: [...guard().hooks, ...guard().hooks] };
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, duplicated], Stop: [stopGuard()] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_DUPLICATE_RULES") throw new Error(code || "no throw");
});

test("verify fails when guard group contains an unrelated hook", () => {
  let code = "";
  const mixed = { hooks: [...guard().hooks, { type: "process", command: "node", args: ["other.mjs"] }] };
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, mixed], Stop: [stopGuard()] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_RULE_SHAPE_INVALID") throw new Error(code || "no throw");
});

test("verify fails when matcher present", () => {
  let code = "";
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, { matcher: "*", ...guard() }], Stop: [stopGuard()] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_MATCHER_PRESENT") throw new Error(code || "no throw");
});

test("verify fails on wrong type/command/timeout", () => {
  for (const [mutate, expected] of [
    [(h) => { h.type = "shell"; }, "ZCODE_GUARD_TYPE_INVALID"],
    [(h) => { h.command = "node.exe"; }, "ZCODE_GUARD_COMMAND_INVALID"],
    [(h) => { h.timeoutMs = 3000; }, "ZCODE_GUARD_TIMEOUT_INVALID"],
    [(h) => { h.args = ["C:/old/plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs"]; }, "ZCODE_GUARD_SCRIPT_PATH_MISMATCH"],
  ]) {
    const g = guard();
    mutate(g.hooks[0]);
    let code = "";
    try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, g], Stop: [stopGuard()] } } }); }
    catch (e) { code = e.message; }
    if (code !== expected) throw new Error(`expected ${expected}, got ${code || "no throw"}`);
  }
});

test("verify fails when hooks disabled", () => {
  let code = "";
  try { verifyConfig({ hooks: { enabled: false, events: { PreToolUse: [rtk, guard()], Stop: [stopGuard()] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_HOOKS_DISABLED") throw new Error(code || "no throw");
});

test("verify fails when rtk rule missing", () => {
  let code = "";
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [guard()], Stop: [stopGuard()] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_RTK_MISSING") throw new Error(code || "no throw");
});

test("verify fails when Stop rule absent (pre plan-A config)", () => {
  let code = "";
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, guard()] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_STOP_NOT_INSTALLED") throw new Error(code || "no throw");
});

test("verify fails when Stop events entry missing entirely", () => {
  let code = "";
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, guard()], Stop: [] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_STOP_NOT_INSTALLED") throw new Error(code || "no throw");
});

test("verify fails on duplicate Stop rules", () => {
  let code = "";
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, guard()], Stop: [stopGuard(), stopGuard()] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_DUPLICATE_RULES") throw new Error(code || "no throw");
});

test("verify fails on duplicate Stop hooks inside one group", () => {
  let code = "";
  const duplicated = { hooks: [...stopGuard().hooks, ...stopGuard().hooks] };
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, guard()], Stop: [duplicated] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_DUPLICATE_RULES") throw new Error(code || "no throw");
});

test("verify fails on wrong Stop shape/path/timeout", () => {
  for (const [mutate, expected] of [
    [(g) => { g.matcher = "*"; }, "ZCODE_GUARD_MATCHER_PRESENT"],
    [(g) => { g.hooks[0].type = "shell"; }, "ZCODE_GUARD_TYPE_INVALID"],
    [(g) => { g.hooks[0].command = "node.exe"; }, "ZCODE_GUARD_COMMAND_INVALID"],
    [(g) => { g.hooks[0].timeoutMs = 3000; }, "ZCODE_GUARD_TIMEOUT_INVALID"],
    [(g) => { g.hooks[0].args = ["D:/old/plugins/chatgpt-dispatch-guard/hooks/stop.mjs"]; }, "ZCODE_GUARD_SCRIPT_PATH_MISMATCH"],
  ]) {
    const g = stopGuard();
    mutate(g);
    let code = "";
    try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, guard()], Stop: [g] } } }); }
    catch (e) { code = e.message; }
    if (code !== expected) throw new Error(`expected ${expected}, got ${code || "no throw"}`);
  }
});

test("verify fails on missing config file", async () => {
  let code = "";
  try { await verify(join(tmpdir(), "zcode-verify-missing-" + Date.now() + ".json")); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_NOT_INSTALLED") throw new Error(code || "no throw");
});

test("verify is byte-for-byte read-only (no backup, no writes)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-verify-ro-"));
  const file = join(dir, "config.json");
  const original = JSON.stringify(full(), null, 2) + "\n";
  await writeFile(file, original, "utf8");
  await verify(file);
  const after = await readFile(file, "utf8");
  const before = Buffer.from(original, "utf8");
  const afterBuf = Buffer.from(after, "utf8");
  if (!before.equals(afterBuf)) throw new Error("config bytes changed by verify");
  const { readdir } = await import("node:fs/promises");
  const listing = await readdir(dir);
  if (listing.some((f) => f.includes(".bak") || f.endsWith(".tmp"))) throw new Error("verify created backup/temp files: " + listing.join(","));
  await rm(dir, { recursive: true, force: true });
});

test("verify passes on file produced by install() against isolated config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-verify-install-"));
  const file = join(dir, "config.json");
  const base = { hooks: { enabled: true, events: { PreToolUse: [rtk] } } };
  await writeFile(file, JSON.stringify(base, null, 2) + "\n", "utf8");
  await install(file);
  await verify(file);
  const upgraded = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(upgraded.hooks.events.Stop) || upgraded.hooks.events.Stop.length !== 1) {
    throw new Error("install() did not add exactly one Stop entry");
  }
  await rm(dir, { recursive: true, force: true });
});

test("--verify CLI prints OK on valid config and an error code on invalid config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-verify-cli-"));
  const file = join(dir, "config.json");
  const cli = fileURLToPath(new URL("./install-zcode-guard.mjs", import.meta.url));
  const valid = JSON.stringify(full());
  await writeFile(file, valid, "utf8");

  const success = spawnSync(process.execPath, [cli, "--verify", file], { encoding: "utf8" });
  if (success.status !== 0 || !success.stdout.includes("ZCODE_GUARD_VERIFY_OK")) {
    throw new Error(`unexpected CLI success result: ${success.status} ${success.stdout} ${success.stderr}`);
  }
  if ((await readFile(file, "utf8")) !== valid) throw new Error("CLI changed config bytes");

  const invalid = JSON.stringify({ hooks: { enabled: true, events: { PreToolUse: [rtk] } } });
  await writeFile(file, invalid, "utf8");
  const failure = spawnSync(process.execPath, [cli, "--verify", file], { encoding: "utf8" });
  if (failure.status === 0 || !failure.stderr.includes("ZCODE_GUARD_NOT_INSTALLED")) {
    throw new Error(`unexpected CLI failure result: ${failure.status} ${failure.stdout} ${failure.stderr}`);
  }
  if ((await readFile(file, "utf8")) !== invalid) throw new Error("failed CLI changed config bytes");
  await rm(dir, { recursive: true, force: true });
});

test("installConfig upgrades an old PreToolUse-only config by adding exactly one Stop entry", () => {
  const old = { hooks: { enabled: true, events: { PreToolUse: [rtk, guard()] } } };
  const { config, changed } = installConfig(old);
  if (!changed) throw new Error("expected changed=true when adding Stop entry");
  if (config.hooks.events.Stop.length !== 1) throw new Error("expected exactly one Stop entry");
  if (JSON.stringify(config.hooks.events.Stop[0]) !== JSON.stringify(stopGuard())) {
    throw new Error("Stop entry shape mismatch: " + JSON.stringify(config.hooks.events.Stop[0]));
  }
  verifyConfig(config);
});

test("installConfig is idempotent across repeated installs", () => {
  const first = installConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk] } } });
  const second = installConfig(first.config);
  const third = installConfig(second.config);
  if (second.changed || third.changed) throw new Error("repeated install reported changed=true");
  if (JSON.stringify(second.config) !== JSON.stringify(third.config)) throw new Error("configs diverged");
  verifyConfig(third.config);
});

test("installConfig fails loudly on duplicate AgentKit Stop entries (no silent repair)", () => {
  let code = "";
  try {
    installConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, guard()], Stop: [stopGuard(), stopGuard()] } } });
  } catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_DUPLICATE_RULES") throw new Error(code || "no throw");
});

test("installConfig fails on duplicate AgentKit hooks inside one group (matches VERIFY)", () => {
  let code = "";
  const duplicated = { hooks: [...guard().hooks, ...guard().hooks] };
  try {
    installConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, duplicated], Stop: [stopGuard()] } } });
  } catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_DUPLICATE_RULES") throw new Error(code || "no throw");
  let stopCode = "";
  const duplicatedStop = { hooks: [...stopGuard().hooks, ...stopGuard().hooks] };
  try {
    installConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, guard()], Stop: [duplicatedStop] } } });
  } catch (e) { stopCode = e.message; }
  if (stopCode !== "ZCODE_GUARD_DUPLICATE_RULES") throw new Error(stopCode || "no throw");
});

test("install() backs up before first write and keeps the backup on later installs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-stop-install-"));
  const file = join(dir, "config.json");
  const initial = { hooks: { enabled: true, events: { PreToolUse: [rtk] } }, plugins: { other: true } };
  await writeFile(file, JSON.stringify(initial));
  await install(file);
  await install(file); // idempotent, no second backup write
  const backup = JSON.parse(await readFile(file + ".pre-chatgpt-guard.bak", "utf8"));
  if (JSON.stringify(backup) !== JSON.stringify(initial)) throw new Error("backup diverged from original");
  const { readdir } = await import("node:fs/promises");
  const listing = await readdir(dir);
  if (listing.filter((f) => f.includes(".bak")).length !== 1) throw new Error("unexpected backups: " + listing.join(","));
  await rm(dir, { recursive: true, force: true });
});

let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log("PASS " + name); }
  catch (e) { failed++; console.error("FAIL " + name + " :: " + (e.message ?? e)); }
}
console.log(failed === 0 ? "ALL PASS (" + cases.length + ")" : failed + " FAILED");
process.exitCode = failed === 0 ? 0 : 1;
