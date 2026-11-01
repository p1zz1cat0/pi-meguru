// pi-meguru runtime. The extension appends this text to the end of a codemode script,
// with a function __m_saved() that returns the saved records of each flow.
// Use only function declarations and a declaration without a value here. They hoist, so the
// script can call flow() before this text, and the line numbers of the script do not change.
// Do not give a top-level variable a value: the script returns before that line runs.

// The flow that runs now, or undefined.
var __m_cur

// Define a node. The returned async function runs fn once per call, or gives the saved
// output when the same call was done before in this run.
function ptc(name, fn) {
  if (typeof name !== "string" || !name || name === "all") throw new Error("ptc(name, fn): name must be a non-empty string other than \"all\"")
  if (typeof fn !== "function") throw new Error("ptc(" + name + ", fn): fn must be a function")
  var src = __m_hash(__m_src(fn))
  var node = function () { return __m_node(name, fn, src, Array.prototype.slice.call(arguments)) }
  node.map = function (items, opts) { return __m_map(name, node, items, opts) }
  return node
}

// Stop the flow and give control back to the model. A resend continues after this pause.
async function pause(name) {
  var r = __m_enter(typeof name === "string" && name ? name : "pause")
  await __m_flush(r)
  var at = r.busy.at, rec = r.saved[at]
  if (rec && rec.k === "pause") {
    r.trace.push({ at: at })
    r.last = at
    r.busy = null
    return
  }
  r.saved[at] = { k: "pause" }
  await __m_save(r, at, r.saved[at])
  __m_stop(r, { status: "paused", at: r.busy.at, reason: "pause" })
}

async function flow(name, fn, opts) {
  var o = opts || {}
  var bad = __m_cur ? "flow() cannot run inside another flow()"
    : typeof name !== "string" || !name ? "flow(name, fn): name must be a non-empty string"
    : typeof fn !== "function" ? "flow(name, fn): fn must be an async function"
    : __m_badWatch(o.watch)
  if (bad) return { status: "error", at: null, reason: "invalid", error: bad, trace: [] }

  var all = __m_saved()
  var r = {
    name: name, saved: Object.assign(Object.create(null), o.fresh ? {} : all[name]), tools: tools,
    prefix: "",
    busy: null, counts: Object.create(null), srcs: Object.create(null), last: null, failed: null, pending: null, stop: null,
    watch: o.watch || {}, seen: Object.create(null), latest: Object.create(null), all: Object.create(null), trace: [],
  }
  var raw = tools, value, err, threw = false
  __m_cur = r
  // codemode passes tools as a parameter of the script function, and this text is in that
  // function, so this changes the tools that the script sees.
  tools = new Proxy(raw, {
    get: function (t, k) {
      if (!r.busy || r.busy.k !== "node") throw new Error("Call tools only inside a ptc() node. The code between nodes runs again on each resend.")
      return t[k]
    },
  })
  try {
    if (o.fresh && all[name]) await __m_save(r)
    value = await fn()
    value = __m_json(value === undefined ? null : value)
  } catch (e) {
    err = e
    threw = true
  } finally {
    tools = raw
    __m_cur = undefined
  }

  var out
  if (r.stop) out = r.stop
  else if (threw && r.failed && err === r.failed.e) {
    out = { status: "error", at: r.failed.at, reason: "error", error: __m_msg(err) }
    // A saved error that the flow does not catch now: drop it, so a resend runs the node again.
    if (r.failed.saved) {
      try {
        await raw.meguru_save({ name: name, at: r.failed.at })
      } catch (e) {
        out.error += ". Also cannot save the checkpoint: " + __m_msg(e)
      }
    }
  }
  else if (threw) out = { status: "error", at: r.last, reason: "error", error: __m_msg(err) }
  else {
    out = { status: "done", at: r.last, reason: null, value: value }
    try {
      await raw.meguru_save({ name: name })
    } catch (e) {
      out = { status: "error", at: r.last, reason: "error", error: "cannot clear the checkpoint: " + __m_msg(e) }
    }
  }
  out.trace = r.trace
  return out
}

async function __m_node(name, fn, src, args) {
  var r = __m_enter(name)
  r.busy.k = "node"
  if (r.srcs[name] !== undefined && r.srcs[name] !== src) __m_throw(r, "two different ptc() nodes are named " + name)
  r.srcs[name] = src
  var argText
  try {
    argText = JSON.stringify(args)
  } catch (e) {
    __m_throw(r, name + "(): arguments must be JSON: " + __m_msg(e))
  }
  await __m_flush(r)
  var at = r.busy.at, h = __m_hash(src + "|" + argText), rec = r.saved[at], reused = true

  if (!rec || rec.k !== "node" || rec.n !== name || rec.h !== h) {
    // Replace only this instance when its source or arguments change.
    reused = false
    if (rec) {
      delete r.saved[at]
      await __m_save(r, at)
    }
    var out, failed = false, failure
    try {
      out = await fn.apply(null, JSON.parse(argText))
      out = __m_json(out === undefined ? null : out)
    } catch (e) {
      failed = true
      failure = e
    }
    if (failed) {
      // Save the error only when the flow catches it and goes on: see __m_flush.
      r.failed = { e: failure, at: at }
      r.pending = { at: at, rec: { k: "node", n: name, h: h, err: __m_msg(failure) } }
      r.trace.push({ at: at, error: __m_msg(failure) })
      r.last = at
      r.busy = null
      throw failure
    }
    rec = { k: "node", n: name, h: h, out: out }
    r.saved[at] = rec
    await __m_save(r, at, rec)
  }

  r.last = at
  r.busy = null
  if (rec.err !== undefined) {
    var again = new Error(rec.err)
    r.failed = { e: again, at: at, saved: true }
    r.trace.push({ at: at, reused: true, error: rec.err })
    throw again
  }
  r.latest[name] = rec.out
  ;(r.all[name] = r.all[name] || []).push(rec.out)
  var step = { at: at }
  if (reused) step.reused = true
  var w = __m_watch(r)
  if (w) step.watch = w
  r.trace.push(step)
  return __m_json(rec.out)
}

// Return true for a pause or checkpoint stop. Combinators must rethrow it.
function isFlowStop(error) {
  return !!(__m_cur && __m_cur.stop && error === __m_cur.stop.signal)
}

// Define a scoped subflow. Replay its orchestration and reuse its child records.
function group(name, fn) {
  if (typeof name !== "string" || !name || name === "all" || typeof fn !== "function") throw new Error("group(name, fn): provide a name and function")
  var node = function () {
    var args = Array.prototype.slice.call(arguments)
    return __m_group(name, function () { return fn.apply(null, __m_json(args)) })
  }
  node.map = function (items, opts) { return __m_map(name, node, items, opts) }
  return node
}

async function __m_group(name, fn, segment) {
  var r = __m_enter(name)
  await __m_flush(r)
  var at = segment === undefined ? r.busy.at : r.prefix + segment
  var parent = { prefix: r.prefix, counts: r.counts, srcs: r.srcs, trace: r.trace, latest: r.latest, all: r.all, seen: r.seen }
  var step = { at: at, children: [] }
  r.prefix = (segment === undefined ? at : parent.prefix + segment) + "/"
  r.counts = Object.create(null)
  r.srcs = Object.create(null)
  r.trace = step.children
  r.latest = Object.create(null)
  r.all = Object.create(null)
  r.seen = Object.create(null)
  r.busy = null
  var value, failed = false, error
  try {
    value = await fn()
    value = __m_json(value === undefined ? null : value)
    if (r.stop) throw r.stop.signal
  } catch (e) {
    failed = true
    error = e
    if (!isFlowStop(e)) step.error = __m_msg(e)
  } finally {
    r.prefix = parent.prefix
    r.counts = parent.counts
    r.srcs = parent.srcs
    r.trace = parent.trace
    r.latest = parent.latest
    r.all = parent.all
    r.seen = parent.seen
    r.busy = null
    r.trace.push(step)
  }
  if (failed) throw error
  r.last = at
  r.latest[name] = value
  ;(r.all[name] = r.all[name] || []).push(value)
  var watch = __m_watch(r)
  if (watch) step.watch = watch
  return __m_json(value)
}

// Run a batch in order. Keys identify items independently of their positions.
async function __m_map(name, node, items, opts) {
  var o = opts || {}
  if (!Array.isArray(items) || typeof o.key !== "function") throw new Error("map(items, { key }): provide an array and a key function")
  var input = __m_json(items), keys = [], seen = Object.create(null)
  for (var i = 0; i < input.length; i++) {
    var key = o.key(input[i])
    if (typeof key !== "string" && !(typeof key === "number" && isFinite(key))) throw new Error("map key must be a string or finite number")
    var id = encodeURIComponent(JSON.stringify(key))
    if (seen[id]) throw new Error("duplicate map key: " + key)
    seen[id] = true
    keys.push(id)
  }
  return __m_group(name + ".map", async function () {
    var values = []
    for (var i = 0; i < input.length; i++) {
      values.push(await __m_group("item", function () { return node(input[i]) }, "[" + keys[i] + "]"))
    }
    return values
  })
}

// Start a node or pause call. Return the flow with r.busy = { n, at }.
function __m_enter(n) {
  var r = __m_cur
  if (!r) throw new Error(n + "(): call nodes and pause() only inside flow()")
  if (r.stop) throw r.stop.signal
  if (r.busy) __m_throw(r, "nodes run one at a time, and a node cannot call a node or pause(). Await " + r.busy.at + " before you call " + n + ".")
  r.counts[n] = (r.counts[n] || 0) + 1
  r.busy = { n: n, at: r.prefix + encodeURIComponent(n) + "#" + r.counts[n] }
  return r
}

// Save a node error that the flow caught. The flow went on, so the error is part of the run.
async function __m_flush(r) {
  var p = r.pending
  if (!p) return
  r.pending = null
  r.saved[p.at] = p.rec
  await __m_save(r, p.at, p.rec)
}

// Replace or delete one record. Clear the flow when at is absent.
async function __m_save(r, at, rec) {
  try {
    await r.tools.meguru_save(rec ? { name: r.name, at: at, rec: rec } : { name: r.name, at: at })
  } catch (e) {
    __m_stop(r, { status: "error", at: r.busy ? r.busy.at : r.last, reason: "error", error: "cannot save the checkpoint: " + __m_msg(e) })
  }
}

// End the flow. Later node and pause calls throw the same signal, also when the script catches it.
function __m_stop(r, out) {
  var signal = new Error("The flow stopped at " + out.at + " (" + out.status + "). Do not catch this error.")
  r.stop = out
  Object.defineProperty(out, "signal", { value: signal, enumerable: false })
  r.busy = null
  throw signal
}

function __m_throw(r, msg) {
  r.busy = null
  throw new Error(msg)
}

// Evaluate the watches after a node. Return the values that changed, or null.
function __m_watch(r) {
  var keys = Object.keys(r.watch)
  if (!keys.length) return null
  var changed = {}, any = false
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i], v
    var n = __m_json(r.latest)
    n.all = __m_json(r.all)
    try {
      v = r.watch[k](n)
      v = v && typeof v.then === "function" ? "—" : __m_json(v === undefined ? null : v)
    } catch (e) {
      v = "—"
    }
    var s = JSON.stringify(v)
    if (r.seen[k] !== s) {
      r.seen[k] = s
      changed[k] = v
      any = true
    }
  }
  return any ? changed : null
}

function __m_badWatch(watch) {
  if (watch === undefined) return null
  if (!watch || typeof watch !== "object") return "watch must be an object of functions"
  for (var k in watch) if (typeof watch[k] !== "function") return "watch." + k + " must be a function"
  return null
}

// ponytail: drops all whitespace, so an edit that changes only spaces inside a string
// literal is not seen. Use a JS tokenizer if that matters.
function __m_src(f) {
  return String(f).replace(/\s+/g, "")
}

// FNV-1a, 32 bit.
function __m_hash(s) {
  var h = 0x811c9dc5
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

function __m_json(v) {
  return JSON.parse(JSON.stringify(v))
}

function __m_msg(e) {
  return e && e.message ? e.message : String(e)
}
