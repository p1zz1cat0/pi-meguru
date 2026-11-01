import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { injectFlow, SAVE_TOOL_NAME } from "../inject.mjs";

const script = await readFile(new URL("../example.js", import.meta.url), "utf8");

function expedition(busy) {
  const saved = {};
  const calls = [];
  const attempts = new Map();
  const page = (items, complete = true) => ({
    items, total: items.length, scanComplete: true, pageComplete: complete, hasMore: !complete, skippedFiles: 0,
  });
  const sandbox = new CodemodeSandbox({ tools: [
    { name: "glob", execute: async query => {
      calls.push({ tool: "glob", query });
      return page(["sample.ts"]);
    } },
    { name: "grep", execute: async query => {
      calls.push({ tool: "grep", query });
      const library = query.glob[0].includes("md");
      const workshop = query.glob[0].includes("js");
      if (query.pattern.includes("|")) {
        return page(busy ? [{ path: "sample.ts", line: 1, text: workshop ? "FIXME HACK" : "TODO" }] : []);
      }
      const key = JSON.stringify([query.glob, query.pattern]);
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      if (query.pattern.includes("FIXME") && attempts.get(key) === 1) return { ...page([]), failed: 1 };
      if (library) throw new Error("library is closed");
      return page([{ path: "sample.ts", line: 1, text: query.pattern }], query.limit !== 4 || !query.pattern.includes("HACK"));
    } },
    { name: SAVE_TOOL_NAME, execute: async ({ name, at, rec }) => {
      if (at === undefined) delete saved[name];
      else {
        saved[name] ??= {};
        if (rec === undefined) delete saved[name][at];
        else saved[name][at] = rec;
      }
      return "saved";
    } },
  ] });
  return {
    calls, saved,
    async run() {
      const result = await sandbox.execute(injectFlow(script, saved));
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.value;
    },
    close: () => sandbox.close(),
  };
}

function flatten(trace) {
  return trace.flatMap(step => [step, ...flatten(step.children ?? [])]);
}

test("Captain Mochi dispatches nested missions, retries, widens searches and resumes without new calls", async () => {
  const crew = expedition(true);
  try {
    const paused = await crew.run();
    assert.equal(paused.status, "paused");
    assert.equal(paused.at, "captain#1/captain-review#1");
    assert.deepEqual(paused.trace.map(step => step.at), ["district.map#1", "captain#1"]);
    const briefing = flatten(paused.trace).find(step => step.at === "captain#1/briefing#1");
    const board = briefing.watch.camp.command;
    assert.equal(board.decision, "needs-more-patrols");
    assert.deepEqual(board.missions.map(mission => mission.name), ["Workshop 🛠️", "Library 📚"]);
    assert.deepEqual(board.unchecked, ["Training grounds 🧶"]);
    const hack = board.missions[0].leads.find(lead => lead.marker === "HACK");
    assert.equal(hack.widened, true);
    assert.equal(hack.complete, true);
    assert.equal(board.missions[1].leads[0].status, "unavailable");
    const fixmeCalls = crew.calls.filter(call => call.query.pattern === "\\bFIXME\\b");
    assert.equal(fixmeCalls.length, 2);
    assert.equal(crew.calls.filter(call => call.tool === "glob").length, 3);
    const count = crew.calls.length;
    const done = await crew.run();
    assert.equal(done.command.captain, "Captain Mochi 🐱");
    assert.deepEqual(done.command, board);
    assert.equal(crew.calls.length, count, "resend reuses successful searches and caught errors");
    assert.deepEqual(crew.saved, {});
  } finally { await crew.close(); }
});

test("Captain Mochi finishes a complete quiet patrol without pausing or launching missions", async () => {
  const crew = expedition(false);
  try {
    const done = await crew.run();
    assert.equal(done.command.decision, "no-markers-observed");
    assert.deepEqual(done.command.missions, []);
    assert.deepEqual(done.command.unchecked, []);
    assert.equal(crew.calls.length, 6);
    assert.deepEqual(crew.saved, {});
  } finally { await crew.close(); }
});
