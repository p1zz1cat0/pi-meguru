const root = "."
const districts = [
  { name: "Workshop 🛠️", patterns: ["**/*.{js,mjs,cjs,ts,tsx,jsx}", "!**/test/**", "!**/tests/**", "!**/*.test.*", "!**/*.spec.*"] },
  { name: "Training grounds 🧶", patterns: ["**/test/**", "**/tests/**", "**/*.test.*", "**/*.spec.*"] },
  { name: "Library 📚", patterns: ["**/*.{md,mdx}"] },
]

const scout = ptc("scout", async (path, district) => {
  const r = await tools.glob({ path, pattern: district.patterns, limit: 8 })
  if (r.failed?.length) throw new Error(JSON.stringify(r.failed))
  return {
    name: district.name,
    patterns: district.patterns,
    files: r.total ?? null,
    sample: r.items,
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
  if (r.failed?.length) throw new Error(JSON.stringify(r.failed))
  return {
    name: district.name,
    markers: r.total ?? null,
    clues: r.items,
    complete: r.scanComplete && r.pageComplete && !r.hasMore,
    skipped: r.skippedFiles ?? null,
  }
})

const briefing = ptc("briefing", (map, patrols) => ({
  message: "Scouts are back! Check the paw prints before we pack the report. 🐾",
  districts: map.map(area => ({
    name: area.name,
    files: area.files,
    sample: area.sample,
    inventoryComplete: area.complete,
  })),
  patrols,
}))

const report = ptc("report", (camp, title) => ({
  ...camp,
  title,
  message: "Expedition complete. Snacks for every scout! 🐟",
  note: "Markers are review leads, not confirmed bugs. Samples are bounded; incomplete or skipped scans are not a clean bill of health. Tool traversal exclusions still apply.",
}))

const r = await flow("cat-expedition", async () => {
  const map = []
  const patrols = []
  for (const district of districts.slice(0, 3)) {
    const area = await scout(root, district)
    map.push(area)
    if (area.files !== 0 || !area.complete) {
      patrols.push(await patrol(root, district))
    }
  }
  const camp = await briefing(map, patrols)
  await pause("campfire-review")
  return report(camp, "Cat Expedition · Repository Field Notes 🐾")
}, {
  watch: {
    scouts: n => n.all.scout.length,
    latestDistrict: n => n.scout.name,
    camp: n => n.briefing,
  },
})

return r.status === "done" ? { ...r.value, trace: r.trace } : r
