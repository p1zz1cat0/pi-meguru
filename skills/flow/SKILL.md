---
name: flow
description: Use codemode flows for branching tool work with breakpoints and checkpoints.
---

# flow

Call `flow(name, opts)` inside codemode. Split work into `graph`, `actions`, and `guards`.

```js
const r = await flow("check", {
  input: { command: "git status --short", title: "Changed files" },
  helpers: { lines: s => s.split("\n").filter(Boolean) },
  graph: { inspect: ["empty", "report"], empty: [], report: [] },
  actions: {
    inspect: async ({ input }) => {
      const r = await tools.bash({ command: input.command })
      if (r.exit_code !== 0) throw new Error(r.output)
      return lines(r.output)
    },
    empty: () => "No changes",
    report: ({ inspect, input }) => ({ title: input.title, files: inspect }),
  },
  guards: {
    "inspect→empty": c => c.inspect.length === 0,
    "inspect→report": ELSE,
  },
  break: { report: true },
  watch: { count: c => c.inspect.length },
})
return r.status === "done"
  ? { value: r.value, trace: r.trace }
  : { status: r.status, at: r.at, reason: r.reason, error: r.error,
      preview: r.ctx.inspect, trace: r.trace }
```

## Execution

- `graph`: a DAG with one start node. Each run follows one path. `[]` ends it. Put loops inside actions. Node names cannot be `input` or `any`.
- `actions`: async functions returning JSON. Read completed outputs as `ctx.<node>`; nodes that have not run throw. At joins, use `ctx.any("a", "b")` for the first output available.
- `guards`: synchronous conditions, checked in graph order; first true wins. Every edge of a branch needs a guard. Put `ELSE` last. No match returns `reason: "no route"`. Do not call tools in guards.
- `break`: `true` or a synchronous condition, checked before the node. A hit returns `paused`; the same breakpoint stops only once per run.
- `watch`: synchronous expressions, evaluated after each node. Changes go into `trace` without pausing. Unavailable or failed values become `"—"`. Do not call tools in watches.

## State and continuation

Functions are rebuilt from source and cannot capture script variables. Put JSON data in `input`, read it through `ctx.input`, and put shared functions in `helpers`. Call helpers by name; they can call other helpers and `tools`. Values in `ctx` are deeply frozen; copy before modifying.

Send the script again with the same flow name to continue. Completed nodes reuse saved outputs. You can edit pending actions, and inputs or helpers unused by completed actions and routed guards. Changing completed dependencies returns `reason: "frozen"`; use `fresh: true` to restart. Fix a failed action and resend to retry it. Progress is saved at node boundaries, including before a later script failure or timeout.

Do not call tools outside `flow()`: outer code runs again on continuation. Return only the results needed by the model; `flow()` does not print. Results contain `status`, `at`, `reason`, `ctx`, `trace`, and optional `value` or `error`.

Keep node outputs small; they remain in the session history. Input values are not included in checkpoint payloads, but literals in the script are still part of the conversation.
