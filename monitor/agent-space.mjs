// Machine-wide ownership ledger. An Agent has one stable TaskSpace; its conversations use pages.
// The registry is shared across independent ego-browser processes on the same machine.
import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const SCHEMA = "ego-agent-spaces/v1";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (code) => Object.assign(new Error(code), { code });

function validateIdentity({ agentId, spaceName, conversationUuid }) {
  if (typeof agentId !== "string" || !/^[a-z0-9][a-z0-9_.-]{1,63}$/i.test(agentId)) throw fail("AGENT_ID_REQUIRED");
  if (typeof spaceName !== "string" || !spaceName.trim() || spaceName.length > 120) throw fail("SPACE_NAME_REQUIRED");
  if (conversationUuid !== undefined && (typeof conversationUuid !== "string" || !/^[a-z0-9-]{20,}$/i.test(conversationUuid))) {
    throw fail("CONVERSATION_UUID_REQUIRED");
  }
}

export async function withAgentRegistry(action, directory = join(homedir(), ".agents")) {
  await mkdir(directory, { recursive: true });
  const filename = join(directory, "ego-taskspaces.json");
  const lockPath = filename + ".lock";
  const owner = randomUUID();
  let handle;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(owner);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt === 19) throw fail("AGENT_SPACE_REGISTRY_BUSY");
      await pause(100);
    }
  }
  try {
    let registry = { schema: SCHEMA, agents: {} };
    try { registry = JSON.parse(await readFile(filename, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw fail("AGENT_SPACE_REGISTRY_INVALID"); }
    if (registry?.schema !== SCHEMA || !registry.agents || typeof registry.agents !== "object" || Array.isArray(registry.agents)) {
      throw fail("AGENT_SPACE_REGISTRY_INVALID");
    }
    const result = await action(registry);
    if (result?.changed) {
      const temp = filename + "." + owner + ".tmp";
      try {
        await writeFile(temp, JSON.stringify(registry, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
        await rename(temp, filename);
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }
    }
    return result?.value;
  } finally {
    await handle?.close();
    if ((await readFile(lockPath, "utf8").catch(() => null)) === owner) {
      await unlink(lockPath).catch(() => {});
    }
  }
}

export async function claimAgentSpace({ agentId, spaceName, conversationUuid, directory } = {}) {
  validateIdentity({ agentId, spaceName, conversationUuid });
  return withAgentRegistry((registry) => {
    const current = registry.agents[agentId];
    if (current && current.spaceName !== spaceName) throw fail("AGENT_ALREADY_HAS_SPACE");
    if (Object.entries(registry.agents).some(([id, entry]) => id !== agentId && entry.spaceName === spaceName)) {
      throw fail("SPACE_OWNED_BY_ANOTHER_AGENT");
    }
    const entry = current || { spaceName, active: [], known: [] };
    if (!Array.isArray(entry.active) || !Array.isArray(entry.known)) throw fail("AGENT_SPACE_REGISTRY_INVALID");
    if (entry.releasePending) throw fail("AGENT_SPACE_RELEASE_PENDING");
    let changed = !current;
    if (conversationUuid && !entry.active.includes(conversationUuid)) { entry.active.push(conversationUuid); changed = true; }
    if (conversationUuid && !entry.known.includes(conversationUuid)) { entry.known.push(conversationUuid); changed = true; }
    registry.agents[agentId] = entry;
    return { changed, value: structuredClone(entry) };
  }, directory);
}

// Reserve an explicitly requested new conversation before creating its Page.
// A lost newPage() result must not trigger an unbounded second allocation.
export async function reserveAgentPage({ agentId, spaceName, conversationUuid, directory } = {}) {
  validateIdentity({ agentId, spaceName, conversationUuid });
  if (!conversationUuid) throw fail("CONVERSATION_UUID_REQUIRED");
  return withAgentRegistry((registry) => {
    const entry = registry.agents[agentId];
    if (!entry || entry.spaceName !== spaceName) throw fail("AGENT_SPACE_NOT_REGISTERED");
    if (entry.releasePending) throw fail("AGENT_SPACE_RELEASE_PENDING");
    if (entry.known.includes(conversationUuid)) throw fail("CONVERSATION_PAGE_RECOVERY_REQUIRED");
    entry.known.push(conversationUuid);
    entry.active.push(conversationUuid);
    return { changed: true, value: structuredClone(entry) };
  }, directory);
}

// Persist an intent before touching the browser. A retry can inspect a pending
// release and reconcile a close/finish that succeeded before registry commit.
export async function releaseAgentConversation({ agentId, spaceName, conversationUuid, directory, finishSpace, closePage, alreadyReleased } = {}) {
  validateIdentity({ agentId, spaceName, conversationUuid });
  if (typeof finishSpace !== "function" || typeof closePage !== "function") throw fail("SPACE_RELEASE_CALLBACK_REQUIRED");
  const pending = await withAgentRegistry((registry) => {
    const entry = registry.agents[agentId];
    if (!entry || entry.spaceName !== spaceName || !entry.known?.includes(conversationUuid)) throw fail("CONVERSATION_NOT_REGISTERED");
    if (!entry.active.includes(conversationUuid) && !entry.releasePending) {
      return { changed: false, value: { done: true, finished: entry.active.length === 0, active: [...entry.active] } };
    }
    if (entry.releasePending && entry.releasePending.conversationUuid !== conversationUuid) throw fail("AGENT_SPACE_RELEASE_PENDING");
    const remaining = entry.active.filter((id) => id !== conversationUuid);
    const changed = !entry.releasePending;
    const release = entry.releasePending || { conversationUuid, finished: remaining.length === 0 };
    entry.releasePending = release;
    return { changed, value: { release, entry: structuredClone(entry) } };
  }, directory);
  if (pending.done) return { finished: pending.finished, active: pending.active };
  // On recovery, the caller must prove the target page or space is absent.
  // Never infer browser success from a previous exception alone.
  if (!(typeof alreadyReleased === "function" && await alreadyReleased(pending.entry))) {
    if (pending.release.finished) await finishSpace(pending.entry);
    else await closePage(pending.entry);
  }
  return withAgentRegistry((registry) => {
    const entry = registry.agents[agentId];
    if (entry?.spaceName !== spaceName || entry.releasePending?.conversationUuid !== conversationUuid) throw fail("AGENT_SPACE_RELEASE_CONFLICT");
    const remaining = entry.active.filter((id) => id !== conversationUuid);
    entry.active = remaining;
    delete entry.releasePending;
    return { changed: true, value: { finished: remaining.length === 0, active: remaining } };
  }, directory);
}
