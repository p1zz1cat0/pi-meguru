const root = "."
const missionBudget = 2
const districts = [
  { name: "Workshop 🛠️", patterns: ["**/*.{js,mjs,cjs,ts,tsx,jsx}", "!**/test/**", "!**/tests/**", "!**/*.test.*", "!**/*.spec.*"] },
  { name: "Training grounds 🧶", patterns: ["**/test/**", "**/tests/**", "**/*.test.*", "**/*.spec.*"] },
  { name: "Library 📚", patterns: ["**/*.{md,mdx}"] },
]

// Retry business failures. Let pause and checkpoint signals reach the flow.
const retry = (node, attempts) => async (...args) => {
  for (let i = 0; i < attempts; i++) {
    try { return await node(...args) }
    catch (error) { if (isFlowStop(error) || i === attempts - 1) throw error }
  }
}

const scout = ptc("scout", async (path, district) => {
  const r = await tools.glob({ path, pattern: district.patterns, limit: 8 })
  if (r.failed) throw new Error(JSON.stringify(r.failed))
  return {
    name: district.name,
    patterns: district.patterns,
    files: r.total ?? null,
    sample: r.items ?? [],
    complete: r.scanComplete && r.pageComplete && !r.hasMore,
  }
})

const patrol = ptc("patrol", async (path, district) => {
  const r = await tools.grep({
    path,
    glob: district.patterns,
    pattern: "\\b(TODO|FIXME|HACK)\\b",
    limit: 6,
  })
  if (r.failed) throw new Error(JSON.stringify(r.failed))
  return {
    name: district.name,
    markers: r.total ?? null,
    clues: r.items ?? [],
    complete: r.scanComplete && r.pageComplete && !r.hasMore,
    skipped: r.skippedFiles ?? null,
  }
})

const inspect = ptc("inspect", async query => {
  const r = await tools.grep({
    path: query.root,
    glob: query.patterns,
    pattern: "\\b" + query.marker + "\\b",
    limit: query.limit,
  })
  if (r.failed) throw new Error(JSON.stringify(r.failed))
  return {
    marker: query.marker,
    matches: r.total ?? null,
    sample: r.items ?? [],
    complete: !!(r.scanComplete && r.pageComplete && !r.hasMore),
    skipped: r.skippedFiles ?? null,
  }
})

const briefing = ptc("briefing", (visits, command) => ({
  message: "Captain Mochi has sorted the paw prints. The mission board is ready! 🐾",
  districts: visits.map(({ area }) => ({
    name: area.name,
    files: area.files,
    sample: area.sample,
    inventoryComplete: area.complete,
  })),
  patrols: visits.flatMap(visit => visit.clues ? [visit.clues] : []),
  command,
}))

const report = ptc("report", (camp, title) => ({
  ...camp,
  title,
  message: "Expedition complete. Snacks for every scout! 🐟",
  note: "Markers are review leads, not confirmed bugs. Samples are bounded; incomplete or skipped scans are not a clean bill of health. Tool traversal exclusions still apply.",
}))

const explore = group("district", async ({ root, district }) => {
  const area = await scout(root, district)
  const clues = area.files !== 0 || !area.complete
    ? await patrol(root, district)
    : null
  return { area, clues }
})

// Each lead has its own scope, retry history, and optional wider search.
const followLead = group("lead", async ({ root, patterns, marker }) => {
  const search = retry(inspect, 2)
  try {
    const first = await search({ root, patterns, marker, limit: 4 })
    const evidence = first.complete
      ? first
      : await search({ root, patterns, marker, limit: 12 })
    return {
      ...evidence,
      status: evidence.matches > 0 || evidence.sample.length > 0 ? "observed"
        : evidence.matches === 0 && evidence.complete ? "not-observed"
        : "uncertain",
      widened: !first.complete,
    }
  } catch (error) {
    if (isFlowStop(error)) throw error
    return { marker, status: "unavailable", complete: false, error: String(error) }
  }
})

const investigate = group("mission", async mission => {
  const leads = await followLead.map(
    mission.markers.map(marker => ({ root: mission.root, patterns: mission.patterns, marker })),
    { key: lead => lead.marker },
  )
  return {
    name: mission.name,
    priority: mission.priority,
    coverageGap: mission.coverageGap,
    leads,
    observed: leads.filter(lead => lead.status === "observed").map(lead => lead.marker),
    unresolved: leads.filter(lead => !lead.complete || lead.skipped || lead.status === "unavailable").map(lead => lead.marker),
  }
})

// Captain Mochi turns scout results into a bounded, data-dependent mission tree.
const captain = group("captain", async ({ root, visits, budget }) => {
  const priorities = { FIXME: 5, HACK: 3, TODO: 1 }
  const plan = visits
    .filter(({ area, clues }) => !area.complete || (clues && (clues.markers !== 0 || !clues.complete || clues.skipped)))
    .map(({ area, clues }) => {
      const sample = JSON.stringify(clues?.clues ?? [])
      const observed = Object.keys(priorities).filter(marker => new RegExp("\\b" + marker + "\\b").test(sample))
      const markers = observed.length ? observed : Object.keys(priorities)
      const coverageGap = !area.complete || !clues?.complete || !!clues?.skipped
      return {
        root,
        name: area.name,
        patterns: area.patterns,
        markers,
        coverageGap,
        priority: markers.reduce((score, marker) => score + priorities[marker], 0) + (coverageGap ? 4 : 0),
      }
    })
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))

  const missions = await investigate.map(plan.slice(0, budget), { key: mission => mission.name })
  const unchecked = plan.slice(budget).map(mission => mission.name)
  const findings = missions.flatMap(mission => mission.observed.map(marker => ({ district: mission.name, marker })))
  const gaps = missions.filter(mission => mission.coverageGap || mission.unresolved.length)
  const decision = unchecked.length || gaps.length ? "needs-more-patrols"
    : findings.length ? "captain-review"
    : "no-markers-observed"

  const camp = await briefing(visits, {
    captain: "Captain Mochi 🐱",
    decision,
    queue: plan.map(({ name, priority, markers }) => ({ name, priority, markers })),
    missions,
    unchecked,
    findings,
    gaps: gaps.map(mission => mission.name),
  })
  if (decision !== "no-markers-observed") await pause("captain-review")
  return camp
})

const r = await flow("cat-expedition", async () => {
  const visits = await explore.map(
    districts.slice(0, 3).map(district => ({ root, district })),
    { key: stop => stop.district.name },
  )
  const camp = await captain({ root, visits, budget: missionBudget })
  return report(camp, "Cat Expedition · Captain Mochi's Mission Board 🐾")
}, {
  watch: {
    scouts: n => n["district.map"].length,
    missions: n => n["mission.map"].length,
    decision: n => n.briefing.command.decision,
    camp: n => n.briefing,
  },
})

return r.status === "done" ? { ...r.value, trace: r.trace } : r
