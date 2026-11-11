#!/usr/bin/env node
// Idempotently install the official PreToolUse policy into the USER ZCode hooks.
// Back up the original config before the first write, preserve all other hooks.
import { readFile, writeFile, rename, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs");
export const marker = "chatgpt-dispatch-guard/hooks/pre-tool-use.mjs";

export function installConfig(existing, scriptPath = script) {
  const config = structuredClone(existing);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("ZCODE_CONFIG_INVALID");
  const hooks = config.hooks ||= {};
  if (typeof hooks !== "object" || Array.isArray(hooks)) throw new Error("ZCODE_HOOKS_INVALID");
  const events = hooks.events ||= {};
  const pre = events.PreToolUse ||= [];
  if (!Array.isArray(pre)) throw new Error("ZCODE_HOOKS_INVALID");
  let changed = hooks.enabled !== true;
  hooks.enabled = true;
  const own = pre.filter((group) => group.hooks?.some((h) => h.args?.some((a) => String(a).replace(/\\/g, "/").includes(marker))));
  if (own.length > 1) throw new Error("ZCODE_GUARD_DUPLICATE_RULES");
  const canonical = { hooks: [{ type: "process", command: "node", args: [scriptPath], timeoutMs: 5000 }] };
  if (!own.length) { pre.push(canonical); changed = true; }
  else if (JSON.stringify(own[0]) !== JSON.stringify(canonical)) {
    // An older installation used matcher="*", which is an invalid regular expression.
    Object.keys(own[0]).forEach((key) => delete own[0][key]);
    Object.assign(own[0], canonical);
    changed = true;
  }
  return { config, changed };
}

export async function install(file = join(homedir(), ".zcode/cli/config.json")) {
  let original;
  try { original = await readFile(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; original = null; }
  const { config, changed } = installConfig(original === null ? {} : JSON.parse(original));
  if (!changed) return false;
  await mkdir(dirname(file), { recursive: true });
  if (original !== null) await copyFile(file, file + ".pre-chatgpt-guard.bak");
  const temporary = file + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", "utf8");
  await rename(temporary, file);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log("ZCODE_GUARD_" + (await install(process.argv[2] || undefined) ? "INSTALLED" : "ALREADY_INSTALLED")); }
  catch (error) { console.error("ZCODE_GUARD_INSTALL_FAILED=" + error.message); process.exitCode = 2; }
}
