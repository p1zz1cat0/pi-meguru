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
  return function () { return __m_node(name, fn, src, Array.prototype.slice.call(arguments)) }
}

// Stop the flow and give control back to the model. A resend continues after this pause.
async function pause(name) {
  var r = __m_enter(typeof name === "string" && name ? name : "pause")
  await __m_flush(r)
  var i = r.i++, rec = r.saved[i]
  if (rec && rec.k === "pause" && rec.n === r.busy.n) {
    r.trace.push({ at: r.busy.at })
    r.last = r.busy.at
    r.busy = null
    return
  }
  r.saved.length = i
  r.saved[i] = { k: "pause", n: r.busy.n }
  await __m_save(r, i, r.saved[i])
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
    name: name, saved: o.fresh ? [] : (all[name] || []).slice(), i: 0, tools: tools,
    busy: null, counts: {}, srcs: {}, last: null, failed: null, pending: null, stop: null,
    watch: o.watch || {}, seen: {}, latest: {}, all: {}, trace: [],
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
    if (o.fresh && (all[name] || []).length) await __m_save(r, 0)
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
    if (r.failed.i !== undefined) {
      try {
        await raw.meguru_save({ name: name, at: r.failed.i })
      } catch (e) {
        out.error += ". Also cannot save the checkpoint: " + __m_msg(e)
      }
    }
  }
  else if (threw) out = { status: "error", at: r.last, reason: "error", error: __m_msg(err) }
  else {
    out = { status: "done", at: r.last, reason: null, value: value }
    try {
      await raw.meguru_save({ name: name, at: 0 })
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
  var at = r.busy.at, h = __m_hash(src + "|" + argText), i = r.i++, rec = r.saved[i], reused = true

  if (!rec || rec.k !== "node" || rec.n !== name || rec.h !== h) {
    // A new call, or the script changed here. Records from here on are not valid any more.
    reused = false
    r.saved.length = i
    var out, failed = null
    try {
      out = await fn.apply(null, JSON.parse(argText))
      out = __m_json(out === undefined ? null : out)
    } catch (e) {
      failed = e
    }
    if (failed) {
      // Save the error only when the flow catches it and goes on: see __m_flush.
      r.failed = { e: failed, at: at }
      r.pending = { i: i, rec: { k: "node", n: name, h: h, err: __m_msg(failed) } }
      r.trace.push({ at: at, error: __m_msg(failed) })
      r.last = at
      r.busy = null
      throw failed
    }
    rec = { k: "node", n: name, h: h, out: out }
    r.saved[i] = rec
    await __m_save(r, i, rec)
  }

  r.last = at
  r.busy = null
  if (rec.err !== undefined) {
    var again = new Error(rec.err)
    r.failed = { e: again, at: at, i: i }
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

// Start a node or pause call. Return the flow with r.busy = { n, at }.
function __m_enter(n) {
  var r = __m_cur
  if (!r) throw new Error(n + "(): call nodes and pause() only inside flow()")
  if (r.stop) throw r.stop.signal
  if (r.busy) __m_throw(r, "nodes run one at a time, and a node cannot call a node or pause(). Await " + r.busy.at + " before you call " + n + ".")
  r.counts[n] = (r.counts[n] || 0) + 1
  r.busy = { n: n, at: n + "#" + r.counts[n] }
  return r
}

// Save a node error that the flow caught. The flow went on, so the error is part of the run.
async function __m_flush(r) {
  var p = r.pending
  if (!p) return
  r.pending = null
  r.saved[p.i] = p.rec
  await __m_save(r, p.i, p.rec)
}

// Cut the saved records to `at`, then add rec when given.
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
