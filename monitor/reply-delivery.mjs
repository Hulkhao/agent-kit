// Final reply evidence. Text stays in the per-conversation local directory.
import { createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const isUuid = (value) => typeof value === "string" && /^[\da-f-]{36}$/i.test(value);
export const visibleTextHash = (text) => sha256(String(text).replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n").trim());

function matchesPayload(text, payloadHash, displayHash) {
  return sha256(text) === payloadHash ||
    (typeof displayHash === "string" && visibleTextHash(text) === displayHash);
}

export function extractDomReply(units, payloadHash, expectedTailKey, { displayHash, baselineTailKey } = {}) {
  if (!Array.isArray(units) || !/^[\da-f]{64}$/i.test(payloadHash || "") || !isUuid(expectedTailKey)) return null;
  const anchor = units.findLastIndex((unit) => unit.role === "user" && matchesPayload(unit.text || "", payloadHash, displayHash));
  if (anchor < 0 || units.slice(anchor + 1).some((unit) => unit.role === "user")) return null;
  if (baselineTailKey) {
    const previous = units.findLastIndex((unit, index) => index < anchor &&
      unit.role === "assistant" && unit.messageKey === baselineTailKey);
    if (previous < 0 || units.slice(previous + 1, anchor).some((unit) => unit.role === "user")) return null;
  }
  const responses = units.slice(anchor + 1).filter((unit) => unit.role === "assistant" && typeof unit.text === "string" && unit.text.trim());
  if (!responses.length || responses.at(-1).messageKey !== expectedTailKey) return null;
  const text = responses.map((unit) => unit.text).join("\n\n");
  return text.trim() ? { text, source: "DOM_BOUNDARY_VISIBLE" } : null;
}

export function extractApiReply(conversation, payloadHash, { displayHash } = {}) {
  if (!conversation?.mapping || typeof conversation.current_node !== "string" ||
      !/^[\da-f]{64}$/i.test(payloadHash || "")) return null;
  const nodes = [];
  const visited = new Set();
  let cursor = conversation.current_node;
  while (cursor) {
    if (visited.has(cursor)) return null;
    visited.add(cursor);
    const item = conversation.mapping[cursor];
    if (!item) return null;
    if (item.message) nodes.push(item.message);
    cursor = item.parent;
  }
  nodes.reverse();
  const content = (node) => (node.content?.parts || []).map((part) =>
    typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n");
  const anchor = nodes.findLastIndex((node) => node.author?.role === "user" && matchesPayload(content(node), payloadHash, displayHash));
  if (anchor < 0 || nodes.slice(anchor + 1).some((node) => node.author?.role === "user")) return null;
  const after = nodes.slice(anchor + 1);
  const assistants = after.filter((node) => node.author?.role === "assistant");
  const last = assistants.at(-1);
  if (!last || last.end_turn !== true || last.status !== "finished_successfully") return null;
  const text = assistants.map(content).filter(Boolean).join("\n\n");
  return text.trim() ? { text, source: "API_FINAL_VERIFIED" } : null;
}

export function replyPath(dir, dispatchId) {
  if (!isUuid(dispatchId)) throw new Error("REPLY_DISPATCH_ID_INVALID");
  return join(dir, `reply-${dispatchId}.txt`);
}

async function archiveConsumedPreviousReply(dir, record, previous) {
  if (record?.status !== "ACCEPTED" || !isUuid(previous?.dispatchId) ||
      previous.dispatchId === record.dispatchId ||
      previous.conversationUuid !== record.conversationUuid ||
      previous.file !== `reply-${previous.dispatchId}.txt` ||
      !["DOM_BOUNDARY_VISIBLE", "API_FINAL_VERIFIED"].includes(previous.source) ||
      !isUuid(previous.tailMessageKey)) throw new Error("REPLY_RECEIPT_MISMATCH");

  const consumed = JSON.parse(await readFile(join(dir, "a-reply-consumed.json"), "utf8").catch((error) => {
    if (error.code === "ENOENT") throw new Error("REPLY_RECEIPT_MISMATCH");
    throw error;
  }));
  const contents = await readFile(replyPath(dir, previous.dispatchId), "utf8");
  if (consumed?.dispatchId !== previous.dispatchId || consumed.sha256 !== previous.sha256 ||
      !Number.isFinite(consumed.consumedAt) || !contents.trim() ||
      sha256(contents) !== previous.sha256 || Buffer.byteLength(contents, "utf8") !== previous.bytes) {
    throw new Error("REPLY_RECEIPT_MISMATCH");
  }

  const archiveDir = join(dir, ".archive");
  await mkdir(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, `reply-consumed-${previous.dispatchId}.json`);
  const archived = JSON.stringify({ receipt: previous, consumed });
  try {
    await writeFile(archivePath, archived, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST" || await readFile(archivePath, "utf8") !== archived) throw error;
  }
  // The archive and original reply text now both preserve the evidence.
  // Remove only the stale receipt so the current dispatch can publish its own.
  await unlink(join(dir, "a-reply-delivery.json"));
}

async function clearPreviousReceipt(dir, record) {
  let previous;
  try { previous = JSON.parse(await readFile(join(dir, "a-reply-delivery.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (previous.dispatchId !== record.dispatchId) await archiveConsumedPreviousReply(dir, record, previous);
}

export async function saveReply(dir, record, extracted, tailMessageKey) {
  if (!record?.dispatchId || !record.conversationUuid || !extracted?.text?.trim() ||
      !["DOM_BOUNDARY_VISIBLE", "API_FINAL_VERIFIED"].includes(extracted.source) || !isUuid(tailMessageKey)) {
    throw new Error("REPLY_EVIDENCE_INVALID");
  }
  const filename = replyPath(dir, record.dispatchId);
  const text = extracted.text;
  const receipt = {
    dispatchId: record.dispatchId,
    conversationUuid: record.conversationUuid,
    source: extracted.source,
    tailMessageKey,
    file: `reply-${record.dispatchId}.txt`,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text, "utf8"),
  };
  await clearPreviousReceipt(dir, record);
  // A crash before publishing the receipt leaves an uncommitted reply file.
  // A crash afterwards can be reconciled by checking its bytes.
  await writeFile(filename + ".tmp", text, "utf8");
  await rename(filename + ".tmp", filename);
  await writeFile(join(dir, "a-reply-delivery.json.tmp"), JSON.stringify(receipt), "utf8");
  await rename(join(dir, "a-reply-delivery.json.tmp"), join(dir, "a-reply-delivery.json"));
  return receipt;
}

export async function verifiedReply(dir, record) {
  let receipt;
  try { receipt = JSON.parse(await readFile(join(dir, "a-reply-delivery.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") throw new Error("REPLY_DELIVERY_REQUIRED"); throw error; }
  if (receipt?.dispatchId !== record?.dispatchId) {
    await archiveConsumedPreviousReply(dir, record, receipt);
    throw new Error("REPLY_DELIVERY_REQUIRED");
  }
  if (!receipt || receipt.dispatchId !== record?.dispatchId || receipt.conversationUuid !== record.conversationUuid ||
      receipt.file !== `reply-${record.dispatchId}.txt` || !["DOM_BOUNDARY_VISIBLE", "API_FINAL_VERIFIED"].includes(receipt.source) ||
      !isUuid(receipt.tailMessageKey)) throw new Error("REPLY_RECEIPT_MISMATCH");
  const contents = await readFile(replyPath(dir, record.dispatchId), "utf8");
  if (!contents.trim() || sha256(contents) !== receipt.sha256 || Buffer.byteLength(contents, "utf8") !== receipt.bytes) {
    throw new Error("REPLY_CONTENT_MISMATCH");
  }
  return receipt;
}

// Extraction is staged locally. The owner confirms the exact reply bytes
// after consuming them before a managed page can be released.
export async function acknowledgeReply(dir, record, expectedSha256) {
  const receipt = await verifiedReply(dir, record);
  if (record?.status !== "COMPLETED" || expectedSha256 !== receipt.sha256) {
    throw new Error("REPLY_CONSUMPTION_EVIDENCE_INVALID");
  }
  const consumed = { dispatchId: record.dispatchId, sha256: receipt.sha256, consumedAt: Date.now() };
  const target = join(dir, "a-reply-consumed.json");
  await writeFile(target + ".tmp", JSON.stringify(consumed), "utf8");
  await rename(target + ".tmp", target);
  return consumed;
}

export async function verifiedConsumption(dir, record) {
  const receipt = await verifiedReply(dir, record);
  let consumed;
  try { consumed = JSON.parse(await readFile(join(dir, "a-reply-consumed.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") throw new Error("REPLY_NOT_CONSUMED"); throw error; }
  if (record?.status !== "COMPLETED" || consumed?.dispatchId !== record.dispatchId ||
      consumed.sha256 !== receipt.sha256 || !Number.isFinite(consumed.consumedAt)) {
    throw new Error("REPLY_CONSUMPTION_MISMATCH");
  }
  return consumed;
}
