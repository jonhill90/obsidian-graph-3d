# Graph 3D

A 3D graph view for Obsidian, drawn with WebGL. Notes are glowing points, links are lines,
and folders pull their notes together. Colours come from your own graph settings.

## What it does

- Adds a **Graph 3D** view, opened from the ribbon (orbit icon) or the command **Open Graph 3D**.
- Lays out every note and link in 3D with a force simulation, grouped by top folder.
- Reads the colour groups and `-path:` filters from your core graph settings
  (`.obsidian/graph.json`). It only reads that file; it never changes it.
- On-screen controls: search, orbit, reset camera, reheat and rebuild the layout.
- A `graph-3d` code block in a note renders a button that opens the view.
- The command **Run benchmark** measures layout and frame times and writes `bench.json`
  in the plugin's own folder.

No settings tab yet.

## Disclosures

- **Network:** none. The plugin makes no network requests.
- **Files outside the vault:** none.
- **Files it writes:** only `bench.json` in its own plugin folder, and only when you run the
  benchmark. If a `bench-request.json` is placed in the plugin folder, it runs the benchmark
  once at startup and deletes that request file.
- **Telemetry, ads, accounts, payment:** none.
- Works on desktop and mobile (`isDesktopOnly: false`); tested on desktop only.

## Install

Not in the community directory. Either:

- **BRAT:** add `jonhill90/obsidian-graph-3d` as a beta plugin.
- **Manual:** download `main.js`, `manifest.json` and `styles.css` from the latest release
  into `<vault>/.obsidian/plugins/graph-3d/`, then enable **Graph 3D** under
  Settings → Community plugins.

## Source

`main.js` is the source: plain JavaScript, no dependencies and no build step.
Where it came from is in [IMPORT.md](IMPORT.md).

## Releasing

1. Bump `version` in `manifest.json` and add it to `versions.json` with its minimum Obsidian version.
2. Tag the commit with the exact version, no `v` (for example `0.1.1`) and push the tag.
3. The release workflow checks the tag, attests the three files and drafts the release.

## Licence

MIT, see [LICENSE](LICENSE).
