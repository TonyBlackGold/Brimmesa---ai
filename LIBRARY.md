# Coach libraries (ATLAS imports)

User uploads stay in the browser. Repo files are the admin shelf. At load, `data/library/manifest.json` is fetched and each file is merged into the on-device index. An item is indexed once. The cache key is a hash of `hashKey` (or the URL, or the title plus text) plus a content hash of the title, URL, and chunks. The same content hash is not chunked again. Edit the text and keep the same `hashKey` to replace that item on the next load. A new `hashKey` adds a new item.

## Add an item

1. Create `data/library/<coach>/<name>.json`. `<coach>` is `marcus`, `amara`, `jasmine`, `renee`, `aria`, or `shared`.
2. Use the shape below. `chunks` may be omitted if you set `text`; the app will chunk `text` on first import.
3. Add the path to the `files` array in `data/library/manifest.json`.
4. Commit and push to `main`. The next Pages deploy ships it. Visitors merge it on their next load.

```json
{
  "items": [
    {
      "id": "atlas-example",
      "coaches": ["marcus"],
      "title": "Short original title",
      "sourceType": "notes",
      "url": "",
      "channel": "Brimmesa",
      "timestamps": [],
      "chunks": [{ "id": "c0", "text": "One original sentence.", "start": null }],
      "tags": ["security+"],
      "attribution": "Who wrote this, and that it is not copied course text.",
      "hashKey": "atlas:marcus:example"
    }
  ]
}
```

`sourceType` is `youtube`, `playlist`, `transcript`, `notes`, or `takeout`. `start` is seconds, or null. Do not paste copyrighted transcripts or exam dumps. Original notes and reference links only.

The sample already shipped is `data/library/marcus/cia-note.json`.
