// Machine-local ego profile pin helper (PO 令 2026-11-08, agent-kit issue #7 root cause).
// Root cause: taskSpace(name) resumes an EXISTING space — profileId only applies at creation,
// so a stale space keeps its original (possibly memberless) account forever. Pin + verify locally.
//
// Run via: ego-browser nodejs < ego-profile-check.mjs  (profiles()/taskSpace are runtime-injected)
// Adapter (edit before running):
const MODE = "list"; // "list" = show profiles + config status | "init" = create config template if absent | "verify" = check SPACE's current account against the pin
const SPACE = "REPLACE_WITH_SPACE_NAME_FOR_VERIFY"; // verify mode only

import { readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";

const CONFIG_PATH = homedir() + "/.agents/ego-profile.json";
const EXAMPLE = {
  defaultProfileId: "Profile 3",            // id from `profiles()` — the profile the ChatGPT Plus account is logged into
  defaultAccount: "your-plus-account@example.com", // email expected on that profile (used for verification, stays local, never enters git)
  spaceExpect: {},                          // optional per-space overrides: { "<space-name>": "other-account@example.com" }
};

if (MODE === "init") {
  try {
    await access(CONFIG_PATH);
    console.log("CONFIG_EXISTS " + CONFIG_PATH);
  } catch {
    await writeFile(CONFIG_PATH, JSON.stringify(EXAMPLE, null, 2));
    console.log("CONFIG_CREATED " + CONFIG_PATH);
  }
  process.exit(0);
}

let cfg = null;
try {
  cfg = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
} catch {
  console.log("RESULT=ACCOUNT_CONFIG_MISSING");
  console.error("Create " + CONFIG_PATH + " (template: ego-profile.example.json in the skill, or run MODE=\"init\")");
  process.exit(1);
}

if (MODE === "list") {
  console.log("profiles:", JSON.stringify(await profiles()));
  console.log("config:", JSON.stringify(cfg));
  process.exit(0);
}

// verify: resume the space, read the ChatGPT account actually logged in on it, compare with the pin.
const task = await taskSpace(SPACE);
let chatPage = null;
for (const p of (await task.pages())) {
  try { if ((await p.url()).includes("chatgpt.com")) { chatPage = p; break; } } catch {}
}
if (!chatPage) { console.log("RESULT=ACCOUNT_UNPROVEN_STOP"); process.exit(1); }
// In-page fetch (window.fetch + credentials): ego's page.fetch wrapper can return null on a freshly
// navigated page; the in-page call is the reliable evidence channel. Email only — never log tokens.
const email = await chatPage.evaluate(async () => {
  try { const r = await fetch("/api/auth/session", { credentials: "include" }); const j = await r.json(); return (j && j.user && j.user.email) || null; }
  catch { return null; }
});
const expect = (cfg.spaceExpect && cfg.spaceExpect[SPACE]) || cfg.defaultAccount;
console.log(JSON.stringify({ space: SPACE, email, expect }));
if (!email) { console.log("RESULT=ACCOUNT_UNPROVEN_STOP"); process.exit(1); }
if (!expect || !cfg.defaultProfileId) { console.log("RESULT=ACCOUNT_CONFIG_INCOMPLETE_STOP"); process.exit(1); }
if (email !== expect) { console.log("RESULT=ACCOUNT_MISMATCH_STOP"); process.exit(1); }
console.log("RESULT=ACCOUNT_OK");
