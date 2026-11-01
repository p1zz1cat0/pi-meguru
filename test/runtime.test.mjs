import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { injectFlow, SAVE_TOOL_NAME } from "../inject.mjs";

// Fake tools. `calls` counts how often each tool ran.
let calls = {};
// The saved records: flow name → records. Same rules as the save tool in index.ts.
let db = {};
const tools = [
	{
		name: "work",
		execute: async ({ tag }) => {
			calls[tag] = (calls[tag] ?? 0) + 1;
			return calls[tag];
		},
	},
	{
		name: SAVE_TOOL_NAME,
		execute: async ({ name, at, rec }) => {
			if (at === undefined) delete db[name];
			else {
				const records = db[name] ?? Object.create(null);
				if (rec === undefined) delete records[at];
				else records[at] = rec;
				if (Object.keys(records).length) db[name] = records;
				else delete db[name];
			}
			return "ok";
		},
	},
];
const sandbox = new CodemodeSandbox({ tools });
const quick = new CodemodeSandbox({ tools, timeoutMs: 1500 });
after(() => Promise.all([sandbox.close(), quick.close()]));

function reset() {
	db = {};
	calls = {};
}

const exec = (code, box = sandbox) => box.execute(injectFlow(code, db));

async function run(code) {
	const r = await exec(code);
	assert.ok(r.ok, r.ok ? "" : `${r.error.kind}: ${r.error.message}`);
	return r.value;
}

const ats = (r) => r.trace.map((s) => s.at);

// A test → (build | diagnose) → review pause → report flow. `passed` decides the branch.
function delivery({ passed = true, build = "return { built: true }", watch = "{}", extra = "" } = {}) {
	return `
const test = ptc("test", async () => {
  await tools.work({ tag: "test" })
  return { passed: ${passed}, failed: ${passed ? 0 : 3} }
})
const build = ptc("build", async () => { await tools.work({ tag: "build" }); ${build} })
const diagnose = ptc("diagnose", async () => { await tools.work({ tag: "diagnose" }); return "diff" })
const report = ptc("report", (t, check) => ({ passed: t.passed, check }))
${extra}
return flow("delivery", async () => {
  const t = await test()
  const check = t.passed ? await build() : await diagnose()
  await pause("review")
  return report(t, check)
}, { watch: ${watch} })
`;
}

test("pauses, then a resend reuses done nodes and finishes", async () => {
	reset();
	const p = await run(delivery());
	assert.equal(p.status, "paused");
	assert.equal(p.at, "review#1");
	assert.deepEqual(ats(p), ["test#1", "build#1"]);

	const d = await run(delivery());
	assert.equal(d.status, "done");
	assert.deepEqual(d.value, { passed: true, check: { built: true } });
	assert.deepEqual(calls, { test: 1, build: 1 });
	assert.deepEqual(d.trace.map((s) => [s.at, !!s.reused]), [["test#1", true], ["build#1", true], ["review#1", false], ["report#1", false]]);
	assert.equal(db.delivery, undefined, "done clears the records");
});

test("native branches work", async () => {
	reset();
	await run(delivery({ passed: false }));
	const d = await run(delivery({ passed: false }));
	assert.deepEqual(d.value, { passed: false, check: "diff" });
	assert.deepEqual(calls, { test: 1, diagnose: 1 });
});

test("a failed node is retried with the same instance id", async () => {
	reset();
	const e = await run(delivery({ build: `throw new Error("boom")` }));
	assert.equal(e.status, "error");
	assert.equal(e.at, "build#1");
	assert.equal(e.error, "boom");

	const p = await run(delivery());
	assert.equal(p.status, "paused");
	assert.deepEqual(calls, { test: 1, build: 2 });
});

test("a changed node runs again without resetting an existing pause", async () => {
	reset();
	await run(delivery());
	const p = await run(delivery({ build: "return { built: 2 }" }));
	assert.equal(p.status, "done");
	assert.deepEqual(calls, { test: 1, build: 2 });
	assert.deepEqual(p.trace.map((s) => !!s.reused), [true, false, false, false]);
});

test("changed arguments run the node again", async () => {
	reset();
	const flow = (n) => `
const double = ptc("double", x => x * 2)
return flow("args", async () => { const v = await double(${n}); await pause("p"); return v })`;
	await run(flow(1));
	assert.equal((await run(flow(1))).value, 2);
	await run(flow(5));
	const d = await run(flow(5));
	assert.equal(d.value, 10);
});

test("a changed call order preserves independently matched records", async () => {
	reset();
	const flow = (order) => `
const a = ptc("a", () => tools.work({ tag: "a" }))
const b = ptc("b", () => tools.work({ tag: "b" }))
return flow("order", async () => { ${order}; await pause("p"); return "ok" })`;
	await run(flow("await a(); await b()"));
	await run(flow("await b(); await a()"));
	assert.deepEqual(calls, { a: 1, b: 1 });
});

test("a loop with pause gives each iteration its own instance", async () => {
	reset();
	const script = `
const check = ptc("check", () => tools.work({ tag: "check" }))
return flow("loop", async () => {
  for (let i = 0; i < 5; i++) {
    if (await check() >= 3) return "green"
    await pause("fix")
  }
  return "gave up"
})`;
	assert.equal((await run(script)).at, "fix#1");
	assert.equal((await run(script)).at, "fix#2");
	const d = await run(script);
	assert.equal(d.status, "done");
	assert.equal(d.value, "green");
	assert.deepEqual(ats(d), ["check#1", "fix#1", "check#2", "fix#2", "check#3"]);
	assert.equal(calls.check, 3);
});

test("catching the pause signal does not keep the flow running", async () => {
	reset();
	const r = await run(`
const after = ptc("after", () => tools.work({ tag: "after" }))
return flow("swallow", async () => {
  try { await pause("p") } catch {}
  try { await after() } catch {}
  return "no"
})`);
	assert.equal(r.status, "paused");
	assert.equal(r.at, "p#1");
	assert.equal(calls.after, undefined);
});

test("a caught node error is a branch: it is saved and given again on resend", async () => {
	reset();
	const script = `
const build = ptc("build", async () => { await tools.work({ tag: "build" }); throw new Error("red") })
const diagnose = ptc("diagnose", () => tools.work({ tag: "diagnose" }))
return flow("caught", async () => {
  let why
  try { await build() } catch (e) { why = e.message; await diagnose() }
  await pause("p")
  return why
})`;
	assert.equal((await run(script)).status, "paused");
	const d = await run(script);
	assert.equal(d.value, "red");
	assert.deepEqual(calls, { build: 1, diagnose: 1 });
});

test("a saved error that is not caught any more is dropped, so the node is retried", async () => {
	reset();
	const node = `const build = ptc("build", async () => { await tools.work({ tag: "build" }); throw new Error("red") })
const after = ptc("after", () => 1)`;
	await run(`${node}
return flow("drop", async () => { try { await build() } catch {} ; await after(); await pause("p") })`);
	const e = await run(`${node}
return flow("drop", async () => { await build() })`);
	assert.equal(e.status, "error");
	assert.equal(e.at, "build#1");
	assert.equal(calls.build, 1, "the saved error is given again, not run");
	await run(`${node}
return flow("drop", async () => { await build() })`);
	assert.equal(calls.build, 2);
});

test("tools cannot be called between nodes", async () => {
	reset();
	const r = await run(`return flow("outside", async () => tools.work({ tag: "x" }))`);
	assert.equal(r.status, "error");
	assert.match(r.error, /only inside a ptc\(\) node/);
	assert.equal(calls.x, undefined);
	const back = await run(`await flow("outside", async () => 1); return tools.work({ tag: "y" })`);
	assert.equal(back, 1, "tools work again after flow() returns");
});

test("nodes run one at a time", async () => {
	reset();
	const r = await run(`
const a = ptc("a", () => 1)
const b = ptc("b", () => 2)
return flow("par", async () => Promise.all([a(), b()]))`);
	assert.equal(r.status, "error");
	assert.match(r.error, /one at a time/);
});

test("arguments are copies: a node cannot change the caller's value", async () => {
	reset();
	const r = await run(`
const grab = ptc("grab", () => ({ list: [1] }))
const push = ptc("push", o => { o.list.push(2); return o.list.length })
return flow("copy", async () => { const o = await grab(); const n = await push(o); return { n, o } })`);
	assert.deepEqual(r.value, { n: 2, o: { list: [1] } });
});

test("watch records changes only, sees n.all, and is rebuilt on resend", async () => {
	reset();
	const watch = `{ failed: n => n.test.failed, runs: n => n.all.test.length, built: n => n.build.built }`;
	const p = await run(delivery({ watch }));
	assert.deepEqual(p.trace[0].watch, { failed: 0, runs: 1, built: "—" });
	assert.deepEqual(p.trace[1].watch, { built: true });

	const d = await run(delivery({ watch }));
	assert.deepEqual(d.trace[0].watch, p.trace[0].watch);
	assert.equal(d.trace[3].watch, undefined);
});

test("progress stays when the script fails or times out after a node is done", async () => {
	reset();
	const late = await exec(delivery().replace("return flow", "await flow") + "\nthrow new Error('late')");
	assert.equal(late.ok, false);
	assert.equal((await run(delivery())).status, "done");
	assert.deepEqual(calls, { test: 1, build: 1 });

	reset();
	const hang = await exec(delivery({ build: "for (;;) {}" }), quick);
	assert.equal(hang.ok, false);
	assert.equal(hang.error.kind, "timeout");
	await run(delivery());
	assert.equal(calls.test, 1);
});

test("fresh starts over", async () => {
	reset();
	await run(delivery());
	const p = await run(delivery().replace("{ watch: {} }", "{ watch: {}, fresh: true }"));
	assert.equal(p.status, "paused");
	assert.equal(calls.test, 2);
});

test("invalid calls are reported", async () => {
	reset();
	assert.equal((await run(`return flow("", async () => 1)`)).reason, "invalid");
	assert.equal((await run(`return flow("x", 1)`)).reason, "invalid");
	assert.equal((await run(`return flow("x", async () => 1, { watch: { a: 1 } })`)).reason, "invalid");
	const two = await run(`
const a1 = ptc("a", () => 1)
const a2 = ptc("a", () => 2)
return flow("dup", async () => { await a1(); return a2() })`);
	assert.match(two.error, /two different ptc\(\) nodes are named a/);
	const outside = await exec(`const a = ptc("a", () => 1); await a(); return flow("x", async () => 1)`);
	assert.equal(outside.ok, false);
	assert.match(outside.error.message, /only inside flow\(\)/);
});

test("injectFlow leaves other scripts alone", () => {
	assert.equal(injectFlow("return 1"), "return 1");
	assert.equal(injectFlow("function flow() {} flow()"), "function flow() {} flow()");
	assert.match(injectFlow("flow()", { a: [1] }), /function __m_saved\(\) \{ return \{"a":\[1\]\} \}/);
});

test("inserting a node preserves siblings and changed outputs invalidate consumers", async () => {
	reset();
	const script = (insert, value) => `
const a = ptc("a", async () => { await tools.work({ tag: "a" }); return ${value} })
const b = ptc("b", x => tools.work({ tag: "b" + x }))
const extra = ptc("extra", () => tools.work({ tag: "extra" }))
return flow("insert", async () => {
  const x = await a(); ${insert ? 'await extra();' : ''}
  await b(x); await pause("review"); await pause("finish")
})`;
	await run(script(false, 1));
	const p = await run(script(true, 1));
	assert.equal(p.at, "finish#1");
	assert.deepEqual(calls, { a: 1, b1: 1, extra: 1 });
	const d = await run(script(true, 2));
	assert.equal(d.status, "done");
	assert.deepEqual(calls, { a: 2, b1: 1, extra: 1, b2: 1 });
});

test("map is one trace node and keyed items survive reorder, insertion and partial failure", async () => {
	reset();
	const script = (items, fail) => `
const verify = ptc("verify", async task => {
  const count = await tools.work({ tag: task.id });
  if (task.fail) throw new Error("broken");
  return { id: task.id, value: task.value, count };
})
return flow("batch", async () => {
  const result = await verify.map(${JSON.stringify(items.map(id => ({ id, value: id === 'b' ? 2 : 1, fail: fail && id === 'b' })))}, { key: task => task.id });
  await pause("review"); return result;
}, { watch: { batch: n => n["verify.map"] } })`;
	const e = await run(script(['a', 'b'], true));
	assert.equal(e.status, "error");
	assert.match(e.at, /verify.map#1\/\[%22b%22\]\/verify#1/);
	assert.equal(e.trace.length, 1);
	const p = await run(script(['b', 'c', 'a'], false));
	assert.equal(p.status, "paused");
	assert.equal(p.trace.length, 1);
	assert.equal(p.trace[0].children.length, 3);
	assert.equal(p.trace[0].children[2].children[0].reused, true);
	const d = await run(script(['b', 'c', 'a'], false));
	assert.deepEqual(d.value.map(x => x.id), ['b', 'c', 'a']);
	assert.deepEqual(calls, { a: 1, b: 2, c: 1 });
});

test("nested groups pause and resume with separate identities and watches", async () => {
	reset();
	const script = `
const leaf = ptc("leaf", task => tools.work({ tag: task.id }));
const inner = group("inner", async task => {
  const value = await leaf(task);
  await pause("review");
  return value;
});
const outer = group("outer", task => inner(task));
return flow("nested", () => outer.map([{id:"a"}, {id:"b"}], {key: x => x.id}), {
  watch: { count: n => n.all.leaf.length, result: n => n["outer.map"] }
});`;
	const a = await run(script);
	assert.equal(a.status, "paused");
	assert.match(a.at, /\[%22a%22\]\/outer#1\/inner#1\/review#1$/);
	const b = await run(script);
	assert.equal(b.status, "paused");
	assert.match(b.at, /\[%22b%22\]\/outer#1\/inner#1\/review#1$/);
	const d = await run(script);
	assert.equal(d.status, "done");
	assert.deepEqual(d.value, [1, 1]);
	assert.deepEqual(calls, { a: 1, b: 1 });
	assert.equal(d.trace.length, 1);
	assert.deepEqual(d.trace[0].watch.result, [1, 1]);
	assert.equal(d.trace[0].children[0].children[0].children[0].children[0].watch.count, 1);
});

test("native retry combinators replay failures and propagate control signals", async () => {
	reset();
	const script = `
const retry = (node, n) => async (...args) => {
  for (let i = 0; i < n; i++) {
    try { return await node(...args) }
    catch (e) { if (isFlowStop(e) || i === n - 1) throw e }
  }
};
const attempt = ptc("attempt", async () => {
  const count = await tools.work({ tag: "attempt" });
  if (count < 2) throw new Error("retry");
  return count;
});
const task = group("task", async () => {
  const value = await retry(attempt, 3)();
  await pause("review"); return value;
});
return flow("retry", () => retry(task, 3)());`;
	assert.equal((await run(script)).status, "paused");
	const d = await run(script);
	assert.equal(d.value, 2);
	assert.deepEqual(calls, { attempt: 2 });
});

test("map rejects invalid and duplicate keys before executing items", async () => {
	reset();
	const prefix = `const a = ptc("a", x => tools.work({tag: String(x)}));`;
	const dup = await run(`${prefix} return flow("dup-map", () => a.map([1, 1], {key: x => x}))`);
	assert.match(dup.error, /duplicate map key/);
	const invalid = await run(`${prefix} return flow("bad-map", () => a.map([1], {key: x => ({x})}))`);
	assert.match(invalid.error, /key must be a string or finite number/);
	assert.deepEqual(calls, {});
});
