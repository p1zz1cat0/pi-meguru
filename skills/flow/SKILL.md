---
name: flow
description: Use codemode flows for multi-step tool work that must pause, resume, or be watched.
---

# flow

Inside codemode, define nodes with `ptc(name, fn)` and orchestrate them with plain async JS in `flow(name, fn, opts)`.

```js
const test = ptc("test", async () => {
  const r = await tools.bash({ command: "npm test" })
  return { passed: r.exit_code === 0, log: r.output.slice(-2000) }
})
const build = ptc("build", async () => {
  const r = await tools.bash({ command: "npm run build" })
  if (r.exit_code !== 0) throw new Error(r.output.slice(-2000))
  return { ok: true }
})
const diagnose = ptc("diagnose", async () => (await tools.bash({ command: "git diff --stat" })).output)
const report = ptc("report", (t, check) => ({ passed: t.passed, check }))

const r = await flow("delivery", async () => {
  const t = await test()
  const check = t.passed ? await build() : await diagnose()
  await pause("review")
  return report(t, check)
}, { watch: { passed: n => n.test.passed } })

return r.status === "done" ? { value: r.value, trace: r.trace } : r
```

## Nodes

- A node is one normal codemode step. It can use closures, script functions, and `tools`.
- Each call is an instance: `test#1`, `test#2`. Arguments and return values must be JSON. Arguments are copied in, so a node cannot change the caller's values.
- Pass upstream outputs as arguments. Do not read or change outer variables from a node: a reused node does not run again, so its side effects on variables do not happen.
- Call tools only inside nodes. `tools` throws between nodes.
- Await each node before calling the next. Nodes do not run in parallel, and a node cannot call a node or `pause()`.

## Orchestration

- Use plain `if`, ternaries, `for`, `try/catch`. Put an upper limit on every loop.
- `await pause(name)` stops the flow and returns `paused`. For a conditional pause, write `if (cond) await pause(name)`. Do not catch the pause.
- The orchestration code runs again on every resend. Keep it deterministic: no `Date.now()` or `Math.random()` for branch decisions.
- A node error that the orchestration catches is a branch result. It is saved and thrown again on resend without running the node.
- An uncaught node error returns `error` at that instance. Fix it and resend to retry the same instance.

## Continuation

Send the same script again with the same flow name to continue. Each call is matched in order:

- Same node, same source, same arguments: the saved output is reused.
- Changed source or arguments, or a different call order: that call and every call after it run again.
- `fresh: true` drops all saved records.

The records are kept in memory only. They are cleared when the flow is done, when the session changes, and when you move in the session tree. They are not in the session history.

## Watch and result

- `watch: { key: n => ... }` runs after each node. `n.<node>` is the latest output, `n.all.<node>` is every output. Only changes are recorded. Failed or unavailable values become `"—"`. Do not call tools in watches. A node cannot be named `all`.
- `flow()` returns `{ status, at, reason, trace, value?, error? }` and prints nothing. `status` is `done`, `paused`, or `error`. `at` is an instance id. Each `trace` step has `at`, and optionally `reused`, `watch`, or `error`.
- Return only what the model needs. Keep node outputs small.
