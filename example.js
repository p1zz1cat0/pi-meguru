// Paste this script into codemode. The host must have Python 3.
// Put sample files in .work/cat-post/inbox before the first call.
// At the pause, check parcels and change destinations if required.
// Send the script again to continue. Delivery copies files and keeps the originals.
const inbox = ".work/cat-post/inbox"
const destinations = {
  pictures: ".work/cat-post/album",
  documents: ".work/cat-post/bookshelf",
  other: ".work/cat-post/treasure-box",
}

const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'"
async function python(source, data) {
  const result = await tools.bash({
    command: "python3 -c " + quote(source) + " " + quote(JSON.stringify(data)),
  })
  if (result.exit_code !== 0) throw new Error(result.output)
  return JSON.parse(result.output)
}
function category(name) {
  const ext = name.toLowerCase().split(".").pop()
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "pictures"
  if (["pdf", "md", "txt", "docx"].includes(ext)) return "documents"
  return "other"
}

const peek = ptc("peek", dir => python(`
import json, pathlib, sys
root = pathlib.Path(json.loads(sys.argv[1])).expanduser().resolve()
if not root.is_dir():
    raise ValueError("Create the inbox and add sample files first: " + str(root))
files = sorted(p.name for p in root.iterdir() if not p.is_symlink() and p.is_file())
print(json.dumps({"root": str(root), "files": files}))
`, dir))

const sort = ptc("sort", files => files.map(name => ({ name, basket: category(name) })))

// destinations is an argument, so a change while paused makes this node run with the new value.
const deliver = ptc("deliver", (root, items, destinations) => python(`
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
`, { root, items, destinations }))

const r = await flow("cat-post", async () => {
  const box = await peek(inbox)
  const parcels = await sort(box.files)
  if (parcels.length === 0) return { message: "The mailbox is empty. Time for a sunny nap! 💤", delivered: [] }
  await pause("check-parcels")
  return deliver(box.root, parcels, destinations)
}, {
  watch: {
    parcels: n => n.sort.length,
    baskets: n => n.sort.reduce((counts, item) => {
      counts[item.basket] = (counts[item.basket] || 0) + 1
      return counts
    }, {}),
    delivered: n => n.deliver.delivered.length,
  },
})

return r.status === "done" ? { ...r.value, trace: r.trace } : r
