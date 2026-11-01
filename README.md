# pi-meguru

English | [简体中文](README.zh-CN.md)

Lightweight DAG orchestration for Pi codemode.

## Install

Enable the `codemode` tool in Pi first. This extension does nothing without it.

```sh
pi install npm:pi-meguru
```

## How it works

The extension prepends meguru's composition model and API reference to codemode's model-facing tool description. Ordinary codemode scripts remain available; meguru can combine multiple stages into one resumable flow using ordinary JS. No separate skill is needed.

A node is one independent PTC, defined with `ptc(name, fn)`. The orchestration is plain async JS inside `flow(name, fn, opts)`: `if` for branches, `for` for loops, and arguments to pass outputs between nodes.

When a script calls `flow()`, the extension appends the runtime and the saved records to the end of the script, and codemode runs them in its QuickJS sandbox. Tool calls keep Pi's usual permissions and hooks.

- **Resume**: each send runs the orchestration from the start. Each node instance is matched by its scoped identity (`name#k`). Matching source and JSON arguments reuse its output. Inserting or reordering differently named nodes preserves other records; changed arguments or source rerun only that instance. A downstream node reruns when its own arguments change.
- **`pause`**: stops and returns `paused`, so control goes back to the model. Send the same script again to continue after the pause.
- **`watch`**: evaluated after each node. Only changes are recorded, and the run does not stop. The records come back with the result of `flow()`.

The records are kept in the extension's memory only, not in the session. They are cleared when the flow is done, when the session changes, or when you move in the session tree. Tools cannot be called between nodes, because that code runs again on each send.

## Groups and batches

Use `group(name, fn)` to give ordinary JS composition a scope and one parent trace entry. Its orchestration runs again on continuation; its child nodes have separate records. A group can call nodes, other groups, and `pause()`. Tools belong in leaf `ptc()` nodes. Node and group calls must be awaited sequentially; tool calls inside a leaf may run concurrently.

```js
const check = ptc("check", task => tools.bash({ command: task.command }))
const verify = group("verify", async task => {
  const result = await check(task)
  if (task.review) await pause("review")
  return { name: task.name, result }
})

return flow("release", () => verify.map([
  { name: "lint", command: "npm run lint", review: false },
  { name: "test", command: "npm test", review: true },
], { key: task => task.name }))
```

Both nodes and groups have `.map(items, { key })`. A batch is one trace entry with nested `children`, and executes items sequentially in input order. The key must be a unique string or finite number. Item records use that key instead of the array index, so inserting, removing, or reordering other items preserves their identities. Errors and pauses stop the batch; a resend reuses completed children and continues. Group outputs, including a completed batch array, are available to watches in the parent scope. Inside a group, watches see that group's local node outputs.

For example, an inner record has an identity like `verify.map#1/[%22test%22]/verify#1/check#1`; names and keys are encoded to keep path segments distinct. Repeated calls of the same name still use occurrence numbers, so inserting another call of that same name shifts later numbers. Independent repeated batches can be placed in named groups for separate scopes.

Native higher-order functions such as retry, pipe, and fallback can compose nodes and groups. In an error-catching combinator, use `if (isFlowStop(error)) throw error` before handling business errors, so a pause or checkpoint failure propagates unchanged. Attempts have separate records, not automatic pauses.

Pass changing dependencies as arguments. A new node that changes external files does not automatically invalidate an unchanged downstream call. Previously visited pause identities are also reused after edits; use a new pause name or `fresh: true` when another review is needed.

## Test

```sh
npm test
node test/pi-smoke.mjs
```

## Example

[Cat expedition](example.js): a read-only repository patrol using structured `glob` and `grep` results. Scouts visit source, test, and documentation districts, then **Captain Mochi 🐱** takes command:

- Derive missions from sampled markers and coverage gaps, score priorities, and sort the queue.
- Dispatch a bounded number of district missions, each with a nested keyed map of marker investigations.
- Retry failed searches with a native higher-order function, widen an incomplete sample once, and preserve unavailable evidence as a gap.
- Aggregate findings, coverage gaps, and undispatched missions, then decide whether to pause inside the captain's subflow for review.

Resending the same script reuses completed searches and caught failures before producing the report. A complete patrol with no observed markers finishes directly. Expand the trace to see `captain → mission.map → mission → lead.map → lead → inspect`. Watches record local stage outputs, including the mission board before a pause.

Set `root` to the repository path before starting. The example expects structured search results (`items`, `total`, `scanComplete`, `pageComplete`, `hasMore`, and optional `failed`/`skippedFiles`); adapt the `scout`, `patrol`, and `inspect` nodes to your available search tools. `missionBudget` bounds district investigations and defaults to 2. No shell, Python, or sample files are required. Samples and traversal exclusions limit coverage; markers are review leads, not confirmed bugs, and `no-markers-observed` does not mean the repository has no problems.
