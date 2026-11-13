import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReplyWatcher } from "./watch-zcode-replies.mjs";

const THREAD = "11111111-1111-1111-1111-111111111111";

test("baseline, atomic DONE delivery, two-minute delay, batching, and restart deduplication", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-replies-test-"));
  const folder = join(root, "exchange");
  const stateFile = join(root, "watch-state.json");
  const replyDir = join(folder, "replies");
  const queued = [];
  const queue = async (names) => { queued.push(names); return { resumed: true }; };
  try {
    await mkdir(replyDir, { recursive: true });
    await writeFile(join(replyDir, "old.reply.md"), "already handled\nDONE\n");
    const watcher = createReplyWatcher({ folder, stateFile, thread: THREAD, delayMs: 120_000, queue });
    await watcher.init();
    assert.equal(watcher.getState().replies["old.reply.md"].status, "baseline");

    await writeFile(join(replyDir, "first.ack.md.tmp"), "accepted\nACK\n");
    await watcher.scan(500);
    assert.equal(watcher.getState().acknowledgements["first.ack.md"], undefined);
    await rename(join(replyDir, "first.ack.md.tmp"), join(replyDir, "first.ack.md"));
    await watcher.scan(600);
    assert.equal(watcher.getState().acknowledgements["first.ack.md"].receivedAt, 600);
    assert.equal(queued.length, 0);

    await writeFile(join(replyDir, "first.reply.md.tmp"), "partial\nDONE\n");
    await watcher.scan(1000);
    assert.equal(queued.length, 0);
    await rename(join(replyDir, "first.reply.md.tmp"), join(replyDir, "first.reply.md"));
    await writeFile(join(replyDir, "second.reply.md"), "partial without DONE");
    await watcher.scan(2000);
    assert.equal(watcher.getState().replies["second.reply.md"], undefined);
    await writeFile(join(replyDir, "second.reply.md"), "complete\nDONE");
    await watcher.scan(2000);
    await watcher.scan(121999);
    assert.equal(queued.length, 0);
    await watcher.scan(122000);
    assert.deepEqual(queued, [["first.reply.md", "second.reply.md"]]);

    const restarted = createReplyWatcher({ folder, stateFile, thread: THREAD, delayMs: 120_000, queue });
    await restarted.init();
    await restarted.scan(500000);
    assert.equal(queued.length, 1);
    assert.equal(restarted.getState().acknowledgements["first.ack.md"].receivedAt, 600);
    assert.equal(restarted.getState().replies["first.reply.md"].status, "delivered");
    assert.equal(restarted.getState().replies["second.reply.md"].status, "delivered");
    assert.ok((await readFile(stateFile, "utf8")).includes('"version": 1'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI failure records failed delivery and never resubmits on the next scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-replies-fail-test-"));
  const folder = join(root, "exchange");
  const stateFile = join(root, "watch-state.json");
  const calls = [];
  try {
    await mkdir(join(folder, "replies"), { recursive: true });
    const watcher = createReplyWatcher({ folder, stateFile, thread: THREAD, delayMs: 5, queue: async (names) => {
      calls.push(names);
      throw new Error("test queue error");
    } });
    await watcher.init();
    await writeFile(join(folder, "replies", "new.reply.md"), "content\nDONE\n");
    await watcher.scan(100);
    await assert.rejects(watcher.scan(105), /test queue error/);
    await watcher.scan(1000);
    assert.equal(calls.length, 1);
    assert.equal(watcher.getState().replies["new.reply.md"].status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renamed reply only queues the current filename after the delay", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-replies-rename-test-"));
  const folder = join(root, "exchange");
  const stateFile = join(root, "watch-state.json");
  const replyDir = join(folder, "replies");
  const queued = [];
  try {
    await mkdir(replyDir, { recursive: true });
    const watcher = createReplyWatcher({
      folder, stateFile, thread: THREAD, delayMs: 120_000,
      queue: async (names) => { queued.push(names); return { resumed: true }; },
    });
    await watcher.init();
    await writeFile(join(replyDir, "wrong-name.reply.md"), "one result\nDONE\n");
    await watcher.scan(1000);
    await rename(join(replyDir, "wrong-name.reply.md"), join(replyDir, "correct-name.reply.md"));
    await watcher.scan(2000);
    await watcher.scan(121000);
    await watcher.scan(122000);
    assert.deepEqual(queued, [["correct-name.reply.md"]]);
    assert.equal(watcher.getState().replies["wrong-name.reply.md"].status, "superseded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queue args append --remote only when a codex remote endpoint is configured", async () => {
  const { queueArgs } = await import("./watch-zcode-replies.mjs");
  const base = queueArgs({ thread: THREAD });
  assert.deepEqual(base, ["queue", "--thread", THREAD, "--message", "MESSAGE_PLACEHOLDER", "--resume"]);
  const remote = queueArgs({ thread: THREAD, codexRemote: "ws://127.0.0.1:31173" });
  assert.deepEqual(
    remote,
    ["queue", "--thread", THREAD, "--message", "MESSAGE_PLACEHOLDER", "--resume", "--remote", "ws://127.0.0.1:31173"],
  );
});
