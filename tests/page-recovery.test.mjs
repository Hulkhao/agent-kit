import test from "node:test";
import assert from "node:assert/strict";
import { recoverConversationPage, assertManagedReleasePages } from "../monitor/page-recovery.mjs";

const target = "12345678-1234-1234-1234-123456789abc";
const other = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const conversation = (uuid) => `https://chatgpt.com/c/${uuid}`;
const managed = (label, url, targetId = label) => ({ label, targetId, url: async () => url });

function fixture(initialPages = [], tabs = []) {
  const pages = [...initialPages];
  let allocations = 0;
  let adoptions = 0;
  return {
    task: {
      pages: async () => [...pages],
      tabs: async () => tabs,
      newPage: async () => {
        allocations++;
        const page = managed(`p${pages.length + 1}`, "about:blank");
        pages.push(page);
        return page;
      },
      adopt: async (page) => { adoptions++; return page; },
    },
    pages,
    get allocations() { return allocations; },
    get adoptions() { return adoptions; },
  };
}

test("missing conversation Page is allocated without operator input", async () => {
  const f = fixture();
  const result = await recoverConversationPage(f.task, target);
  assert.equal(result.page, f.pages[0]);
  assert.equal(result.needsNavigation, true);
  assert.equal(f.allocations, 1);
});

test("a matching managed conversation is reused while other Pages remain untouched", async () => {
  const p1 = managed("p1", conversation(other));
  const p2 = managed("p2", conversation(target));
  const f = fixture([p1, p2]);
  const result = await recoverConversationPage(f.task, target);
  assert.equal(result.page, p2);
  assert.equal(result.needsNavigation, false);
  assert.equal(f.allocations, 0);
});

test("missing target beside another active conversation opens one additional Page", async () => {
  const p1 = managed("p1", conversation(other));
  const f = fixture([p1]);
  const result = await recoverConversationPage(f.task, target);
  assert.equal(result.needsNavigation, true);
  assert.equal(f.allocations, 1);
  assert.equal(f.pages[0], p1);
});

test("interrupted allocation resumes the single agent-owned blank Page", async () => {
  const p1 = managed("p1", conversation(other));
  const p2 = managed("p2", "chrome://new-tab-page/", "tab2");
  const f = fixture([p1, p2], [
    { label: "p2", url: "chrome://new-tab-page/", openedBy: "agent", targetId: "tab2" },
  ]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await recoverConversationPage(f.task, target);
    assert.equal(result.page, p2);
    assert.equal(result.needsNavigation, true);
  }
  assert.equal(f.allocations, 0);
});

test("agent-owned target tab is adopted with exact-host and targetId proof", async () => {
  const page = { targetId: "tab1" };
  const f = fixture([], [
    { url: conversation(target), openedBy: "agent", targetId: "tab1", page },
  ]);
  const result = await recoverConversationPage(f.task, target);
  assert.equal(result.page, page);
  assert.equal(result.needsNavigation, false);
  assert.equal(f.adoptions, 1);
  assert.equal(f.allocations, 0);
});

test("ambiguous matches and unknown managed Pages stop without allocation", async () => {
  const duplicates = fixture([managed("p1", conversation(target)), managed("p2", conversation(target))]);
  await assert.rejects(recoverConversationPage(duplicates.task, target), { code: "PAGE_URL_MATCH_AMBIGUOUS" });
  assert.equal(duplicates.allocations, 0);

  const unknown = fixture([managed("p1", "https://chatgpt.com/")]);
  await assert.rejects(recoverConversationPage(unknown.task, target), { code: "PAGE_URL_MATCH_NOT_FOUND" });
  assert.equal(unknown.allocations, 0);
});

test("untrusted tabs cannot be adopted and managed blanks survive missing tab metadata", async () => {
  const page = { targetId: "tab1" };
  const userTab = fixture([], [
    { url: conversation(target), openedBy: "user", targetId: "tab1", page },
  ]);
  await assert.rejects(recoverConversationPage(userTab.task, target), { code: "PAGE_ADOPTION_EVIDENCE_INCOMPLETE" });
  assert.equal(userTab.allocations, 0);

  const blank = fixture([managed("p1", "about:blank")], []);
  assert.equal((await recoverConversationPage(blank.task, target)).page, blank.pages[0]);
  assert.equal(blank.allocations, 0);

  const contradicted = fixture([managed("p1", "about:blank")], [
    { label: "p1", url: "about:blank", openedBy: "user", targetId: "p1" },
  ]);
  await assert.rejects(recoverConversationPage(contradicted.task, target), { code: "BLANK_PAGE_OWNERSHIP_UNPROVEN" });

  const disguised = fixture([managed("p1", "about:blank")], [
    { label: "unknown", url: "about:blank", openedBy: "user", targetId: "p1" },
  ]);
  await assert.rejects(recoverConversationPage(disguised.task, target), { code: "BLANK_PAGE_OWNERSHIP_UNPROVEN" });
});

test("#31: release accepts managed restart blanks and registered conversation Pages", async () => {
  const pages = [managed("p1", conversation(target)), managed("p2", "chrome://new-tab-page/")];
  const tabs = [
    { label: "p1", url: conversation(target), openedBy: "agent", targetId: "p1" },
    { label: "p2", url: "chrome://new-tab-page/", openedBy: "agent", targetId: "p2" },
  ];
  await assertManagedReleasePages(pages, tabs, [target]);
  await assertManagedReleasePages([pages[1]], [], [target]);
  await assert.rejects(assertManagedReleasePages(pages, [
    tabs[0], { ...tabs[1], openedBy: "user" },
  ], [target]), { code: "SPACE_HAS_UNOWNED_TAB_STOP" });
  await assert.rejects(assertManagedReleasePages(pages, [
    tabs[0], { ...tabs[1], targetId: "another-target" },
  ], [target]), { code: "SPACE_HAS_UNOWNED_TAB_STOP" });
  await assert.rejects(assertManagedReleasePages([
    managed("p3", "https://example.org/"),
  ], [], [target]), { code: "SPACE_HAS_UNREGISTERED_PAGE_STOP" });
  await assert.rejects(assertManagedReleasePages(pages, [
    ...tabs, { label: "p3", url: "about:blank", openedBy: "agent", targetId: "p3" },
  ], [target]), { code: "SPACE_HAS_UNREGISTERED_PAGE_STOP" });
});

test("unreadable URLs and multiple blank Pages retain fail-closed behavior", async () => {
  const failed = fixture([{ label: "p1", url: async () => { throw new Error("offline"); } }]);
  await assert.rejects(recoverConversationPage(failed.task, target), { code: "PAGE_URL_INSPECTION_FAILED" });

  const blanks = fixture([managed("p1", "about:blank"), managed("p2", "about:blank")]);
  await assert.rejects(recoverConversationPage(blanks.task, target), { code: "BLANK_PAGE_AMBIGUOUS" });
  assert.equal(blanks.allocations, 0);
});
