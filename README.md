# pi-meguru

English | [简体中文](README.zh-CN.md)

Lightweight DAG orchestration for Pi codemode.

## Install

Enable the `codemode` tool in Pi first. This extension does nothing without it.

```sh
pi install npm:pi-meguru
```

## How it works

A node is one independent PTC, defined with `ptc(name, fn)`. The orchestration is plain async JS inside `flow(name, fn, opts)`: `if` for branches, `for` for loops, and arguments to pass outputs between nodes.

When a script calls `flow()`, the extension appends the runtime and the saved records to the end of the script, and codemode runs them in its QuickJS sandbox. Tool calls keep Pi's usual permissions and hooks.

- **Resume**: each send runs the orchestration from the start. Node calls are matched with the records in call order. When the source and the arguments are the same, the saved output is returned. Otherwise the run continues from that call.
- **`pause`**: stops and returns `paused`, so control goes back to the model. Send the same script again to continue after the pause.
- **`watch`**: evaluated after each node. Only changes are recorded, and the run does not stop. The records come back with the result of `flow()`.

The records are kept in the extension's memory only, not in the session. They are cleared when the flow is done, when the session changes, or when you move in the session tree. Tools cannot be called between nodes, because that code runs again on each send.

## Test

```sh
npm test
node test/pi-smoke.mjs
```

## Example

[Cat post office](example.js)
