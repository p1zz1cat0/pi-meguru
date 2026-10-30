// pi-meguru runtime. The extension appends this text to the end of a codemode script.
// Use only function declarations here. They hoist, so the script can call flow() and read
// ELSE before this text, and the line numbers of the script do not change.
// Do not declare top-level variables with a value: the script returns before they are set.

// Marks the last edge of a node. It is taken when no other guard is true.
function ELSE() { return true }

async function flow(name, opts) {
  try {
    return await __m_run(name, opts || {})
  } catch (e) {
    return { status: "error", at: null, reason: "error", error: __m_msg(e), ctx: {}, trace: [] }
  }
}

async function __m_run(name, o) {
  if (typeof name !== "string" || !name) return __m_fail("flow(name, opts): name must be a non-empty string")
  var plan = __m_check(o)
  if (typeof plan === "string") return __m_fail(plan)

  // Dependencies of the step that runs now: input keys it read and helpers it called.
  var cur = null
  var input = __m_freeze(__m_json(o.input === undefined ? {} : o.input))
  var fns
  try {
    fns = __m_build(o, plan, function (h) { if (cur) cur.helpers[h] = true })
  } catch (e) {
    return __m_fail(__m_msg(e))
  }

  // Load the checkpoint. A checkpoint is a list of events; "reset" starts a new run.
  var state = __m_state()
  if (o.fresh) {
    var resetErr = await __m_emit(name, [{ t: "reset" }])
    if (resetErr) return __m_fail(resetErr, "error")
  } else {
    var loaded
    try {
      loaded = await tools.meguru_state({ op: "load", name: name })
    } catch (e) {
      return __m_fail("cannot load the checkpoint: " + __m_msg(e), "error")
    }
    state = __m_fold(loaded.events)
  }

  // A done node cannot change. Compare it with the fingerprints in the checkpoint.
  for (var i = 0; i < state.path.length; i++) {
    var n = state.path[i]
    var why = !(n in o.graph) ? "it is not in graph any more"
      : __m_changed(state.print[n].action, __m_hash(__m_src(o.actions[n])), input, fns.helperSrc, "its action")
      || (n in state.route ? __m_changed(state.print[n].route, __m_hash(__m_routeSrc(n, plan)), input, fns.helperSrc, "its guards or edges") : null)
    if (why) {
      return __m_out("error", n, "frozen", n + " is done and frozen, but " + why +
        ". Change only the nodes after it, or pass { fresh: true } to start over.", undefined, state)
    }
  }

  var ctx = __m_ctx(o.graph, state.out, input, function (k) { if (cur) cur.input[k] = true })

  function begin() { cur = { input: {}, helpers: {} } }
  function end(src) {
    var d = cur
    cur = null
    var p = { src: __m_hash(src), input: {}, helpers: {} }
    for (var k in d.input) p.input[k] = __m_hash(__m_text(input[k]))
    for (var h in d.helpers) p.helpers[h] = __m_hash(fns.helperSrc[h])
    return p
  }
  // Choose the next node after n. Return { to } (null at the end), or { error, reason }.
  function pick(n) {
    begin()
    var r = __m_pick(n, plan, fns.guards, ctx)
    r.print = end(__m_routeSrc(n, plan))
    return r
  }
  function route(n, r) {
    state.route[n] = r.to
    state.print[n].route = r.print
    return { t: "route", n: n, to: r.to, print: r.print }
  }
  async function stop(status, at, reason, error, value, events) {
    var err = await __m_emit(name, events)
    if (err) return __m_out("error", at, "error", err, value, state)
    return __m_out(status, at, reason, error, value, state)
  }

  // Find the node to run next.
  var at, pending = []
  if (state.path.length === 0) {
    at = plan.start
  } else {
    var prev = state.path[state.path.length - 1]
    at = state.route[prev]
    if (at === undefined) {
      var first = pick(prev)
      if (first.error) return __m_out("error", prev, first.reason, first.error, undefined, state)
      if (first.to === null) return stop("done", prev, null, undefined, state.out[prev], [{ t: "reset" }])
      pending.push(route(prev, first))
      at = first.to
    }
  }

  for (;;) {
    // A break stops before the node runs, so this node and the nodes after it can still change.
    var b = fns.breaks[at]
    if (b !== undefined && state.hits.indexOf(at) < 0) {
      var hit
      try {
        hit = b === true || !!b(ctx)
      } catch (e) {
        return stop("error", at, "error", "break condition for " + at + " failed: " + __m_hint(e), undefined, pending)
      }
      if (hit) {
        state.hits.push(at)
        pending.push({ t: "hit", n: at })
        return stop("paused", at, "break", undefined, undefined, pending)
      }
    }

    var value
    begin()
    try {
      value = await fns.actions[at](ctx)
      value = __m_json(value === undefined ? null : value)
    } catch (e) {
      cur = null
      return stop("error", at, "error", __m_hint(e), undefined, pending)
    }
    state.out[at] = __m_freeze(value)
    state.path.push(at)
    state.print[at] = { action: end(__m_src(o.actions[at])) }
    pending.push({ t: "node", n: at, out: value, print: state.print[at].action })
    var rec = __m_watch(state, at, fns.watch, ctx)
    if (rec) pending.push({ t: "watch", rec: rec })

    var next = pick(at)
    if (next.error) return stop("error", at, next.reason, next.error, undefined, pending)
    if (next.to === null) {
      pending.push({ t: "reset" })
      return stop("done", at, null, undefined, value, pending)
    }
    pending.push(route(at, next))
    var saveErr = await __m_emit(name, pending)
    if (saveErr) return __m_out("error", at, "error", saveErr, undefined, state)
    pending = []
    at = next.to
  }
}

// Check the flow before any node runs. Return a plan, or an error message.
function __m_check(o) {
  var graph = o.graph, actions = o.actions, guards = o.guards || {}
  if (!graph || typeof graph !== "object") return "graph must be an object"
  if (!actions || typeof actions !== "object") return "actions must be an object"
  var nodes = Object.keys(graph)
  if (nodes.length === 0) return "graph has no nodes"

  var edges = {}, incoming = {}, i, j, k, n, list
  for (i = 0; i < nodes.length; i++) incoming[nodes[i]] = 0
  for (i = 0; i < nodes.length; i++) {
    n = nodes[i]
    var to = graph[n]
    if (n === "input" || n === "any") return "\"" + n + "\" cannot be a node name"
    if (!Array.isArray(to)) return "graph." + n + " must be an array of node names"
    if (typeof actions[n] !== "function") return "actions." + n + " is missing or is not a function"
    edges[n] = []
    for (j = 0; j < to.length; j++) {
      if (!(to[j] in graph)) return "edge " + n + "→" + to[j] + ": node " + to[j] + " is not in graph"
      incoming[to[j]]++
      edges[n].push({ to: to[j], guard: undefined })
    }
  }
  var extra = Object.keys(actions).filter(function (x) { return !(x in graph) })
  if (extra.length) return "actions." + extra[0] + " is not a node in graph"

  var keys = Object.keys(guards)
  for (i = 0; i < keys.length; i++) {
    var m = /^\s*([^\s→>-]+)\s*(?:→|->)\s*(\S+)\s*$/.exec(keys[i])
    if (!m) return "guard key \"" + keys[i] + "\" must look like \"a→b\""
    list = edges[m[1]]
    var edge = list && list.filter(function (e) { return e.to === m[2] })[0]
    if (!edge) return "guard \"" + keys[i] + "\" has no matching edge in graph"
    if (typeof guards[keys[i]] !== "function") return "guard \"" + keys[i] + "\" must be a function or ELSE"
    edge.guard = guards[keys[i]]
  }
  for (i = 0; i < nodes.length; i++) {
    list = edges[nodes[i]]
    for (j = 0; j < list.length; j++) {
      if (list.length > 1 && !list[j].guard) return "edge " + nodes[i] + "→" + list[j].to + " needs a guard"
      if (list[j].guard === ELSE && j !== list.length - 1) return "ELSE must be the last edge of " + nodes[i]
    }
  }

  var starts = nodes.filter(function (x) { return incoming[x] === 0 })
  if (starts.length !== 1) return "graph must have exactly one start node (no incoming edges), found: " + (starts.join(", ") || "none")

  // Depth-first walk: 1 = on the current walk, 2 = done. A node seen with 1 closes a cycle.
  var mark = {}
  function walk(x) {
    if (mark[x] === 1) return x
    if (mark[x] === 2) return null
    mark[x] = 1
    for (var q = 0; q < edges[x].length; q++) {
      var c = walk(edges[x][q].to)
      if (c) return c
    }
    mark[x] = 2
    return null
  }
  var loop = walk(starts[0])
  if (loop) return "graph has a cycle through " + loop + ". Put loops inside an action."
  var lost = nodes.filter(function (x) { return !mark[x] })
  if (lost.length) return "node " + lost[0] + " cannot be reached from " + starts[0]

  var brk = o.break || {}, watch = o.watch || {}, helpers = o.helpers || {}
  for (k in brk) {
    if (!(k in graph)) return "break." + k + " is not a node in graph"
    if (brk[k] !== true && typeof brk[k] !== "function") return "break." + k + " must be true or a function"
  }
  for (k in watch) if (typeof watch[k] !== "function") return "watch." + k + " must be a function"
  var reserved = ["tools", "ctx", "input", "flow", "ELSE", "text", "image", "console", "exit", "store", "load", "eval", "arguments"]
  for (k in helpers) {
    if (!/^[A-Za-z_$][\w$]*$/.test(k) || reserved.indexOf(k) >= 0 || k.indexOf("__m_") === 0) return "helpers." + k + ": this name cannot be used"
    if (typeof helpers[k] !== "function") return "helpers." + k + " must be a function"
  }
  if (o.input !== undefined && (o.input === null || typeof o.input !== "object" || Array.isArray(o.input))) return "input must be an object"

  return { start: starts[0], edges: edges }
}

// Rebuild every function from its source, in strict mode and outside the script scope.
// So a function cannot read or change a variable of the script, before or after a resume.
// Helpers are given to each function as parameters with their own names.
function __m_build(o, plan, onHelper) {
  var hs = o.helpers || {}, names = Object.keys(hs), raw = {}, wrapped = {}, helperSrc = {}
  names.forEach(function (h) {
    helperSrc[h] = __m_src(hs[h])
    wrapped[h] = function () { onHelper(h); return raw[h].apply(this, arguments) }
  })
  function make(fn, what) { return __m_rebuild(fn, names, wrapped, what) }
  names.forEach(function (h) { raw[h] = make(hs[h], "helpers." + h) })

  var actions = {}, guards = {}, breaks = {}, watch = {}, n, k
  for (n in o.actions) actions[n] = make(o.actions[n], "actions." + n)
  for (n in plan.edges) {
    guards[n] = plan.edges[n].map(function (e) {
      return !e.guard || e.guard === ELSE ? e.guard : make(e.guard, "guard " + n + "→" + e.to)
    })
  }
  for (k in o.break || {}) breaks[k] = o.break[k] === true ? true : make(o.break[k], "break." + k)
  for (k in o.watch || {}) watch[k] = make(o.watch[k], "watch." + k)
  return { actions: actions, guards: guards, breaks: breaks, watch: watch, helperSrc: helperSrc }
}

function __m_rebuild(fn, names, wrapped, what) {
  var s = String(fn)
  if (/\{\s*\[native code\]\s*\}\s*$/.test(s)) throw new Error(what + " must be written in the script, not a built-in or bound function")
  var head = "(function (" + names.join(", ") + ") { \"use strict\"; return "
  var f
  try {
    f = (0, eval)(head + "(" + s + ") })")
  } catch (e) {
    // Method shorthand, such as fetch() { ... }, is not an expression. Read it from an object.
    try {
      f = (0, eval)(head + "Object.values(({ " + s + " }))[0] })")
    } catch (e2) {
      throw new Error(what + ": cannot rebuild this function from its source: " + __m_msg(e))
    }
  }
  return f.apply(null, names.map(function (h) { return wrapped[h] }))
}

function __m_pick(n, plan, guards, ctx) {
  var list = plan.edges[n]
  if (list.length === 0) return { to: null }
  for (var i = 0; i < list.length; i++) {
    var g = guards[n][i]
    if (!g || g === ELSE) return { to: list[i].to }
    var r
    try {
      r = g(ctx)
    } catch (e) {
      return { error: "guard " + n + "→" + list[i].to + " failed: " + __m_hint(e), reason: "error" }
    }
    if (r && typeof r.then === "function") {
      return { error: "guard " + n + "→" + list[i].to + " returned a Promise. Guards must be synchronous.", reason: "error" }
    }
    if (r) return { to: list[i].to }
  }
  return { error: "no guard after " + n + " is true and there is no ELSE", reason: "no route" }
}

// Record the watch values after a step. Record only the values that changed.
function __m_watch(state, node, watch, ctx) {
  var changed = {}, any = false
  for (var k in watch) {
    var v
    try {
      v = watch[k](ctx)
      v = v && typeof v.then === "function" ? "—" : __m_json(v === undefined ? null : v)
    } catch (e) {
      v = "—"
    }
    var s = JSON.stringify(v)
    if (state.last[k] !== s) {
      state.last[k] = s
      changed[k] = v
      any = true
    }
  }
  if (!any) return null
  var rec = { step: state.path.length, node: node, watch: changed }
  state.trace.push(rec)
  return rec
}

function __m_state() {
  return { path: [], out: {}, print: {}, route: {}, hits: [], trace: [], last: {} }
}

function __m_fold(events) {
  var s = __m_state()
  for (var i = 0; i < events.length; i++) {
    var e = events[i]
    if (e.t === "reset") s = __m_state()
    else if (e.t === "node") { s.path.push(e.n); s.out[e.n] = __m_freeze(e.out); s.print[e.n] = { action: e.print } }
    else if (e.t === "route") { s.route[e.n] = e.to; s.print[e.n].route = e.print }
    else if (e.t === "hit") s.hits.push(e.n)
    else if (e.t === "watch") {
      s.trace.push(e.rec)
      for (var k in e.rec.watch) s.last[k] = JSON.stringify(e.rec.watch[k])
    }
  }
  return s
}

// Return an error message when the save fails, else null.
async function __m_emit(name, events) {
  if (!events.length) return null
  try {
    await tools.meguru_state({ op: "append", name: name, events: events })
    return null
  } catch (e) {
    return "cannot save the checkpoint: " + __m_msg(e)
  }
}

// Return why a fingerprint changed, or null.
function __m_changed(saved, src, input, helperSrc, what) {
  if (saved.src !== src) return what + " changed"
  for (var k in saved.input) {
    if (saved.input[k] !== __m_hash(__m_text(input[k]))) return "input." + k + " changed and it read input." + k
  }
  for (var h in saved.helpers) {
    if (!(h in helperSrc) || saved.helpers[h] !== __m_hash(helperSrc[h])) return "helpers." + h + " changed and it called " + h
  }
  return null
}

// Read-only view of the outputs. A node that did not run on this path throws.
function __m_ctx(graph, out, input, onInput) {
  var inputView = new Proxy(input, {
    get: function (t, k) { if (typeof k === "string") onInput(k); return t[k] },
    has: function (t, k) { if (typeof k === "string") onInput(k); return k in t },
    ownKeys: function (t) { Object.keys(t).forEach(onInput); return Reflect.ownKeys(t) },
  })
  function any() {
    for (var i = 0; i < arguments.length; i++) if (arguments[i] in out) return out[arguments[i]]
    throw new Error("none of " + Array.prototype.join.call(arguments, ", ") + " ran on this path")
  }
  return new Proxy(out, {
    get: function (t, k) {
      if (k === "input") return inputView
      if (k === "any") return any
      if (typeof k === "string" && k in graph && !(k in t)) throw new Error(k + " did not run on this path")
      return t[k]
    },
    set: function () { throw new Error("ctx is read-only. Return a value from the action instead.") },
    deleteProperty: function () { throw new Error("ctx is read-only") },
  })
}

function __m_routeSrc(n, plan) {
  return plan.edges[n].map(function (e) {
    return e.to + ":" + (e.guard === ELSE ? "ELSE" : e.guard ? __m_src(e.guard) : "")
  }).join("|")
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

function __m_text(v) {
  return v === undefined ? "undefined" : JSON.stringify(v)
}

function __m_json(v) {
  return JSON.parse(JSON.stringify(v))
}

// Freeze a JSON value and all values in it.
function __m_freeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (var k in v) __m_freeze(v[k])
  }
  return v
}

function __m_hint(e) {
  var m = __m_msg(e)
  if (e instanceof ReferenceError) {
    return m + ". Functions given to flow() cannot read variables of the script. Pass data in input and shared functions in helpers."
  }
  if (e instanceof TypeError && /read.?only|not extensible|frozen/i.test(m)) {
    return m + ". Values in ctx are frozen. Copy before you change them: [...x], { ...x }."
  }
  return m
}

function __m_msg(e) {
  return e && e.message ? e.message : String(e)
}

function __m_fail(error, reason) {
  return { status: "error", at: null, reason: reason || "invalid", error: error, ctx: {}, trace: [] }
}

function __m_out(status, at, reason, error, value, state) {
  var r = { status: status, at: at, reason: reason, ctx: __m_json(state.out), trace: state.trace }
  if (error !== undefined) r.error = error
  if (value !== undefined) r.value = value
  return r
}
