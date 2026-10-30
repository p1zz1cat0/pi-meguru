import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { injectFlow, STATE_TOOL_NAME } from "../inject.mjs";

// Fake tools. `calls` counts how often each tool ran.
const calls = {};
// The checkpoint log of the test that runs now: flow name → events. Like the extension,
// the fake state tool appends at once, so the log stays when the script fails later.
let db = {};
const tools = [
	{
		name: "list",
		execute: async ({ n }) => {
			calls.list = (calls.list ?? 0) + 1;
			return Array.from({ length: n }, (_, i) => ({ id: i + 1, owner: i % 3 === 0 ? "a" : null }));
		},
	},
	{
		name: STATE_TOOL_NAME,
		execute: async ({ op, name, events }) => {
			db[name] ??= [];
			if (op === "append") db[name].push(...events);
			return { events: op === "load" ? db[name] : [] };
		},
	},
];
const sandbox = new CodemodeSandbox({ tools });
const quick = new CodemodeSandbox({ tools, timeoutMs: 1500 });
after(() => Promise.all([sandbox.close(), quick.close()]));

async function exec(code, box = sandbox) {
	return box.execute(injectFlow(code));
}

async function run(code) {
	const r = await exec(code);
	assert.ok(r.ok, r.ok ? "" : `${r.error.kind}: ${r.error.message}`);
	return r.value;
}

function fresh() {
	db = {};
	calls.list = 0;
}

const last = (name) => db[name]?.at(-1)?.t;

function script({ n = 20, brk = "{}", bulk = "ids => ids.length", fresh = false, triage = "i => !i.owner", guardBulk = "c => c.triage.length > 10" } = {}) {
	return `
const graph = {
  fetch:    ["triage"],
  triage:   ["empty", "bulk", "oneByOne"],
  empty:    [],
  bulk:     ["report"],
  oneByOne: ["report"],
  report:   [],
}
const actions = {
  fetch:    () => tools.list({ n: ${n} }),
  triage:   ({ fetch }) => fetch.filter(${triage}),
  empty:    () => "nothing",
  bulk:     async ({ triage }) => { const f = ${bulk}; return f(triage.map(i => i.id)) },
  oneByOne: ({ triage }) => triage.length,
  report:   (ctx) => ({ touched: ctx.any("bulk", "oneByOne") }),
}
const guards = {
  "triage→empty":    c => c.fetch.length === 0,
  "triage→bulk":     ${guardBulk},
  "triage→oneByOne": ELSE,
}
return await flow("issues", { graph, actions, guards, break: ${brk}, fresh: ${fresh},
  watch: { left: c => c.triage.length, done: c => c.report.touched } })
`;
}

test("runs to the end, picks the right branch, resets the checkpoint", async () => {
	fresh();
	const big = await run(script({ n: 20 }));
	assert.equal(big.status, "done");
	assert.deepEqual(big.value, { touched: 13 });
	assert.deepEqual(Object.keys(big.ctx), ["fetch", "triage", "bulk", "report"]);
	assert.equal(last("issues"), "reset");

	const small = await run(script({ n: 6 }));
	assert.deepEqual(Object.keys(small.ctx), ["fetch", "triage", "oneByOne", "report"]);

	const none = await run(script({ n: 0 }));
	assert.equal(none.at, "empty");
	assert.equal(none.value, "nothing");
});

test("break pauses once; resending continues and does not run fetch again", async () => {
	fresh();
	const p = await run(script({ brk: "{ bulk: true }" }));
	assert.equal(p.status, "paused");
	assert.equal(p.at, "bulk");
	assert.equal(p.reason, "break");
	assert.equal(last("issues"), "hit");

	const d = await run(script({ brk: "{ bulk: true }" }));
	assert.equal(d.status, "done");
	assert.equal(calls.list, 1);
	assert.equal(last("issues"), "reset");
});

test("conditional break stops only when true", async () => {
	fresh();
	const go = await run(script({ brk: "{ bulk: c => c.triage.length > 100 }" }));
	assert.equal(go.status, "done");
	const stop = await run(script({ brk: "{ bulk: c => c.triage.length > 5 }" }));
	assert.equal(stop.status, "paused");
});

test("a node that throws can be fixed and resumed; earlier nodes do not run again", async () => {
	fresh();
	const e = await run(script({ bulk: `ids => { throw new Error("boom") }` }));
	assert.equal(e.status, "error");
	assert.equal(e.at, "bulk");
	assert.equal(e.error, "boom");

	const d = await run(script());
	assert.equal(d.status, "done");
	assert.equal(calls.list, 1);
});

test("progress stays when the script fails or times out after a node is done", async () => {
	fresh();
	const thrown = await exec(script({ brk: "{ bulk: true }" }).replace("return await flow", "await flow") + "\nthrow new Error('late')");
	assert.equal(thrown.ok, false);
	const d = await run(script({ brk: "{ bulk: true }" }));
	assert.equal(d.status, "done");
	assert.equal(calls.list, 1);

	fresh();
	const hang = await exec(script({ bulk: "ids => { for (;;) {} }" }), quick);
	assert.equal(hang.ok, false);
	assert.equal(hang.error.kind, "timeout");
	const after = await run(script());
	assert.equal(after.status, "done");
	assert.equal(calls.list, 1);
});

test("changing a done node is frozen; fresh starts over", async () => {
	fresh();
	await run(script({ brk: "{ bulk: true }" }));
	const f = await run(script({ brk: "{ bulk: true }", triage: "i => i.owner === null" }));
	assert.equal(f.status, "error");
	assert.equal(f.reason, "frozen");
	assert.equal(f.at, "triage");
	assert.match(f.error, /its action changed/);
	assert.equal(last("issues"), "hit", "a frozen error does not change the checkpoint");

	const again = await run(script({ brk: "{ bulk: true }", triage: "i => i.owner === null", fresh: true }));
	assert.equal(again.status, "paused");
	assert.equal(calls.list, 2);
});

test("changing a guard after its route is taken is frozen", async () => {
	fresh();
	await run(script({ brk: "{ bulk: true }" }));
	const f = await run(script({ brk: "{ bulk: true }", guardBulk: "c => c.triage.length > 3" }));
	assert.equal(f.reason, "frozen");
	assert.equal(f.at, "triage");
});

test("only whitespace changed is not frozen", async () => {
	fresh();
	await run(script({ brk: "{ bulk: true }" }));
	const d = await run(script({ brk: "{ bulk: true }", triage: "i  =>\n    !i.owner" }));
	assert.equal(d.status, "done");
});

test("no route stops at the node; its guards can still change", async () => {
	fresh();
	const code = (g) => `
return await flow("r", {
  graph: { a: ["b", "c"], b: [], c: [] },
  actions: { a: () => 5, b: () => "b", c: () => "c" },
  guards: { "a→b": c => c.a > ${g}, "a→c": c => c.a < 0 },
})`;
	const n = await run(code(10));
	assert.equal(n.status, "error");
	assert.equal(n.reason, "no route");
	assert.equal(n.at, "a");
	const d = await run(code(1));
	assert.equal(d.status, "done");
	assert.equal(d.value, "b");
});

test("watch records changes only and does not block", async () => {
	fresh();
	const d = await run(script());
	assert.equal(d.status, "done");
	assert.deepEqual(d.trace, [
		{ step: 1, node: "fetch", watch: { left: "—", done: "—" } },
		{ step: 2, node: "triage", watch: { left: 13 } },
		{ step: 4, node: "report", watch: { done: 13 } },
	]);
});

test("watch trace continues across a resume", async () => {
	fresh();
	await run(script({ brk: "{ bulk: true }" }));
	const d = await run(script({ brk: "{ bulk: true }" }));
	assert.equal(d.trace.length, 3);
	assert.deepEqual(d.trace[2], { step: 4, node: "report", watch: { done: 13 } });
});

test("reading a node that did not run throws; ctx.any works", async () => {
	fresh();
	const r = await run(`
return await flow("ctx", {
  graph: { a: ["b"], b: [] },
  actions: { a: () => 1, b: (c) => { try { c.b } catch (e) { return [e.message, c.any("x", "a")] } } },
})`);
	assert.deepEqual(r.value, ["b did not run on this path", 1]);
});

test("functions cannot read or change variables of the script", async () => {
	fresh();
	const read = await run(`
const LIMIT = 5
return await flow("read", { graph: { a: [] }, actions: { a: () => LIMIT } })`);
	assert.equal(read.status, "error");
	assert.match(read.error, /LIMIT is not defined.*input.*helpers/);

	const write = await run(`
let seen = 0
return await flow("write", { graph: { a: [] }, actions: { a: () => { seen = 1; return 1 } } })`);
	assert.equal(write.status, "error");
	assert.match(write.error, /seen is not defined/);
});

test("values in ctx are frozen", async () => {
	fresh();
	const r = await run(`
return await flow("frz", {
  graph: { a: ["b"], b: [] },
  actions: { a: () => [3, 1, 2], b: ({ a }) => a.sort() },
})`);
	assert.equal(r.status, "error");
	assert.match(r.error, /frozen.*Copy/);
});

test("helpers work by name, call each other, and work in method shorthand", async () => {
	fresh();
	const r = await run(`
return await flow("h", {
  helpers: { double: x => x * 2, quad: x => double(double(x)) },
  graph: { a: ["b"], b: [] },
  actions: { a() { return quad(1) }, async b({ a }) { return double(a) } },
})`);
	assert.equal(r.status, "done");
	assert.equal(r.value, 8);
});

test("input: a key read by a done node is frozen, a key read only later is not", async () => {
	fresh();
	const code = (repo, limit) => `
return await flow("in", {
  input: { repo: "${repo}", limit: ${limit}, token: "SECRET_123" },
  graph: { a: ["b"], b: [] },
  actions: { a: ({ input }) => input.repo, b: ({ a, input }) => a + ":" + input.limit },
  break: { b: true },
})`;
	await run(code("omo", 5));
	const later = await run(code("omo", 9));
	assert.equal(later.status, "done");
	assert.equal(later.value, "omo:9");

	await run(code("omo", 5));
	const frozen = await run(code("pi", 5));
	assert.equal(frozen.reason, "frozen");
	assert.match(frozen.error, /input\.repo changed/);
	assert.ok(!JSON.stringify(db).includes("SECRET_123"), "input values are not saved");
});

test("helpers: a helper used by a done node is frozen, one used only later is not", async () => {
	fresh();
	const code = (f, g) => `
return await flow("hf", {
  helpers: { f: x => ${f}, g: x => ${g} },
  graph: { a: ["b"], b: [] },
  actions: { a: () => f(1), b: ({ a }) => g(a) },
  break: { b: true },
})`;
	await run(code("x + 1", "x * 10"));
	const later = await run(code("x + 1", "x * 100"));
	assert.equal(later.value, 200);

	await run(code("x + 1", "x * 10"));
	const frozen = await run(code("x + 2", "x * 10"));
	assert.equal(frozen.reason, "frozen");
	assert.match(frozen.error, /helpers\.f changed/);
});

test("guards must be synchronous", async () => {
	fresh();
	const r = await run(`
return await flow("g", {
  graph: { a: ["b", "c"], b: [], c: [] },
  actions: { a: () => 1, b: () => 1, c: () => 1 },
  guards: { "a→b": async () => true, "a→c": ELSE },
})`);
	assert.equal(r.status, "error");
	assert.match(r.error, /synchronous/);
});

test("invalid flows fail before any node runs", async () => {
	fresh();
	const cases = [
		[`{ a: ["b"], b: ["a"] }`, `{ a: () => 1, b: () => 1 }`, `{}`, /exactly one start/],
		[`{ s: ["a"], a: ["b"], b: ["a"] }`, `{ s: () => 1, a: () => 1, b: () => 1 }`, `{}`, /cycle/],
		[`{ a: ["b", "c"], b: [], c: [] }`, `{ a: () => 1, b: () => 1, c: () => 1 }`, `{ "a→x": ELSE }`, /no matching edge/],
		[`{ a: ["b", "c"], b: [], c: [] }`, `{ a: () => 1, b: () => 1, c: () => 1 }`, `{ "a→b": () => true }`, /a→c needs a guard/],
		[`{ a: ["b", "c"], b: [], c: [] }`, `{ a: () => 1, b: () => 1, c: () => 1 }`, `{ "a→b": ELSE, "a→c": () => true }`, /ELSE must be the last/],
		[`{ a: [] }`, `{ a: () => 1, z: () => 1 }`, `{}`, /actions.z/],
		[`{ input: [] }`, `{ input: () => 1 }`, `{}`, /cannot be a node name/],
	];
	for (const [graph, actions, guards, err] of cases) {
		const r = await run(`return await flow("v", { graph: ${graph}, actions: ${actions}, guards: ${guards} })`);
		assert.equal(r.status, "error");
		assert.equal(r.reason, "invalid");
		assert.match(r.error, err);
	}
	const badHelper = await run(`return await flow("v", { graph: { a: [] }, actions: { a: () => 1 }, helpers: { tools: () => 1 } })`);
	assert.match(badHelper.error, /helpers.tools/);
	assert.deepEqual(db.v ?? [], [], "an invalid flow saves nothing");
});

test("injectFlow leaves other scripts alone", () => {
	assert.equal(injectFlow("return 1"), "return 1");
	assert.equal(injectFlow("function flow() {}\nflow()"), "function flow() {}\nflow()");
	assert.ok(injectFlow("flow('x', {})").includes("function ELSE"));
});
