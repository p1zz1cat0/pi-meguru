# pi-meguru

English | [简体中文](README.zh-CN.md)

Lightweight DAG orchestration for Pi codemode.

## Install

Enable the `codemode` tool in Pi first. This extension does nothing without it.

```sh
pi install npm:pi-meguru
```

## How it works

One PTC call is split into three parts, written in plain JavaScript:

| Part | Definition |
| ---- | ---- |
| **`graph`** | Declares the nodes and how they connect. The graph must be a DAG with exactly one start node. Each run follows one path; branches do not run in parallel. |
| **`actions`** | Defines what each node does. A node is one normal codemode step. Its return value is the node's output, which later nodes read through the read-only `ctx.<node>`. |
| **`guards`** | Synchronous JS expressions that choose the next edge. Outgoing edges are checked in order, the first true condition wins, and `ELSE` is the last fallback. |

When a script calls `flow()`, the extension appends the runtime to the end of the script, and codemode runs both in its QuickJS sandbox. Tool calls keep Pi's usual permissions and hooks.

`watch` and `break` decide when the model sees the run:

- **Watchpoint**: after each node, the watch expressions are evaluated. Only changes are recorded, and the run does not stop. The records come back with the result of `flow()`, and the model reads them after this PTC call returns.
- **Breakpoint**: before a node runs, its condition is checked. When it is true, progress is saved and `flow()` returns `paused`. After this codemode script ends, control goes back to the model, which decides how to continue. Break conditions must be synchronous, and the break on a node stops only once per run.

When a node fails or no edge can be taken, progress is also saved and an error is returned. `flow()` only returns data and prints nothing by itself.

## Test

```sh
npm test
node test/pi-smoke.mjs
```

## Example

[Cat post office](example.js)
