// Targeted tests for install-zcode-guard.mjs --verify (read-only contract).
// Run: node test-install-zcode-guard-verify.mjs
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { install, verify, verifyConfig } from "./install-zcode-guard.mjs";

const realScript = join(import.meta.dirname, "../plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs");
const guard = (scriptPath = realScript) => ({
  hooks: [{ type: "process", command: "node", args: [scriptPath], timeoutMs: 5000 }],
});
const rtk = { matcher: "Bash", hooks: [{ type: "process", command: "rtk", args: ["hook", "claude"], enabled: true, timeoutMs: 5000 }] };

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("verify passes on canonical install (rtk + guard)", () => {
  verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, guard()] } } });
});

test("verify fails when guard rule absent", () => {
  let code = "";
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_NOT_INSTALLED") throw new Error(code || "no throw");
});

test("verify fails on duplicate guard rules", () => {
  let code = "";
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, guard(), guard()] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_DUPLICATE_RULES") throw new Error(code || "no throw");
});

test("verify fails on duplicate guard hooks inside one group", () => {
  let code = "";
  const duplicated = { hooks: [...guard().hooks, ...guard().hooks] };
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, duplicated] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_DUPLICATE_RULES") throw new Error(code || "no throw");
});

test("verify fails when guard group contains an unrelated hook", () => {
  let code = "";
  const mixed = { hooks: [...guard().hooks, { type: "process", command: "node", args: ["other.mjs"] }] };
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, mixed] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_RULE_SHAPE_INVALID") throw new Error(code || "no throw");
});

test("verify fails when matcher present", () => {
  let code = "";
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, { matcher: "*", ...guard() }] } } }); }
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
    try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [rtk, g] } } }); }
    catch (e) { code = e.message; }
    if (code !== expected) throw new Error(`expected ${expected}, got ${code || "no throw"}`);
  }
});

test("verify fails when hooks disabled", () => {
  let code = "";
  try { verifyConfig({ hooks: { enabled: false, events: { PreToolUse: [rtk, guard()] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_HOOKS_DISABLED") throw new Error(code || "no throw");
});

test("verify fails when rtk rule missing", () => {
  let code = "";
  try { verifyConfig({ hooks: { enabled: true, events: { PreToolUse: [guard()] } } }); }
  catch (e) { code = e.message; }
  if (code !== "ZCODE_GUARD_RTK_MISSING") throw new Error(code || "no throw");
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
  const original = JSON.stringify({ hooks: { enabled: true, events: { PreToolUse: [rtk, guard()] } } }, null, 2) + "\n";
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
  await rm(dir, { recursive: true, force: true });
});

test("--verify CLI prints OK on valid config and an error code on invalid config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-verify-cli-"));
  const file = join(dir, "config.json");
  const cli = fileURLToPath(new URL("./install-zcode-guard.mjs", import.meta.url));
  const valid = JSON.stringify({ hooks: { enabled: true, events: { PreToolUse: [rtk, guard()] } } });
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

let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log("PASS " + name); }
  catch (e) { failed++; console.error("FAIL " + name + " :: " + (e.message ?? e)); }
}
console.log(failed === 0 ? "ALL PASS (" + cases.length + ")" : failed + " FAILED");
process.exitCode = failed === 0 ? 0 : 1;
