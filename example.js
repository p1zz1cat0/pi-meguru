// Paste this script into codemode. The host must have Python 3.
// Put sample files in .work/cat-post/inbox before the first call.
// At the break, check parcels and change input.destinations if required.
// Send the script again to continue. Delivery copies files and keeps the originals.
const r = await flow("cat-post", {
  input: {
    inbox: ".work/cat-post/inbox",
    destinations: {
      pictures: ".work/cat-post/album",
      documents: ".work/cat-post/bookshelf",
      other: ".work/cat-post/treasure-box",
    },
  },

  helpers: {
    quote: value => "'" + String(value).replace(/'/g, "'\\''") + "'",
    python: async (source, data) => {
      const result = await tools.bash({
        command: "python3 -c " + quote(source) + " " + quote(JSON.stringify(data)),
      })
      if (result.exit_code !== 0) throw new Error(result.output)
      return JSON.parse(result.output)
    },
    category: name => {
      const ext = name.toLowerCase().split(".").pop()
      if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "pictures"
      if (["pdf", "md", "txt", "docx"].includes(ext)) return "documents"
      return "other"
    },
  },

  // Declare the possible routes. Only one branch runs.
  graph: {
    peek: ["sort"],
    sort: ["nap", "deliver"],
    nap: ["receipt"],
    deliver: ["receipt"],
    receipt: [],
  },

  actions: {
    peek: ({ input }) => python(`
import json, pathlib, sys
root = pathlib.Path(json.loads(sys.argv[1])).expanduser().resolve()
if not root.is_dir():
    raise ValueError("Create the inbox and add sample files first: " + str(root))
files = sorted(p.name for p in root.iterdir() if not p.is_symlink() and p.is_file())
print(json.dumps({"root": str(root), "files": files}))
`, input.inbox),

    sort: ({ peek }) => peek.files.map(name => ({ name, basket: category(name) })),
    nap: () => ({ message: "The mailbox is empty. Time for a sunny nap! 💤", delivered: [] }),

    // Read destinations here so they can change while this node is paused.
    deliver: ({ peek, sort, input }) => python(`
import filecmp, json, pathlib, shutil, sys
args = json.loads(sys.argv[1])
root = pathlib.Path(args["root"])
parcels = []
for item in args["items"]:
    source = root / item["name"]
    folder = pathlib.Path(args["destinations"][item["basket"]]).expanduser().resolve()
    target = folder / item["name"]
    if source.is_symlink() or not source.is_file():
        raise ValueError("Parcel is no longer a regular file: " + str(source))
    if source == target or target.is_symlink():
        raise ValueError("Choose another destination: " + str(target))
    if target.exists() and not filecmp.cmp(source, target, shallow=False):
        raise ValueError("A different parcel already exists: " + str(target))
    parcels.append((source, folder, target))
for source, folder, target in parcels:
    folder.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        with source.open("rb") as reader, target.open("xb") as writer:
            shutil.copyfileobj(reader, writer)
print(json.dumps({"message": "Special delivery, with little paw prints! 🐾",
                  "delivered": [str(target) for _, _, target in parcels]}))
`, { root: peek.root, items: sort, destinations: input.destinations }),

    receipt: ctx => ctx.any("nap", "deliver"),
  },

  guards: {
    "sort→nap": ({ sort }) => sort.length === 0,
    "sort→deliver": ELSE,
  },

  break: { deliver: true },
  watch: {
    parcels: c => c.sort.length,
    baskets: c => c.sort.reduce((counts, item) => {
      counts[item.basket] = (counts[item.basket] || 0) + 1
      return counts
    }, {}),
    delivered: c => c.deliver.delivered.length,
  },
})

if (r.status !== "done") {
  return {
    status: r.status, at: r.at, reason: r.reason, error: r.error,
    parcels: r.ctx.sort, trace: r.trace,
  }
}
return { ...r.value, trace: r.trace }
