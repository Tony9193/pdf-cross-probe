# PDF Cross Probe

A local PDF.js viewer for linked schematic and reference-designator searches. PDFs are read locally, never uploaded, and never modified.

## Run

For Windows users, extract `release/0.1.1/PDF-Cross-Probe-0.1.1-win-x64.zip`, or copy the complete `release/0.1.1/win-unpacked` directory. Double-click `PDF Cross Probe.exe` or `Start.cmd`. The EXE needs its companion files; do not copy it alone. Python, Node.js, WebView2, a local server and an internet connection are not required. This unsigned build may require approval under Windows or company security policy; do not disable security software. Chinese usage instructions are included in `README.txt`. Versioned output keeps an already-running older release untouched.

Development requires Node.js and npm:

```powershell
npm.cmd install
npm.cmd run dev -- --host 127.0.0.1
```

Use the URL printed by Vite for browser development. An occupied port causes Vite to select another port. To launch the desktop app from source, use `npm.cmd run desktop`. To rebuild the portable Windows folder and ZIP, use `npm.cmd run package:win`.

The desktop app serves bundled assets through a restricted `app://viewer` protocol, keeps Node.js disabled in sandboxed viewer windows, blocks external network requests and arbitrary navigation, and permits only the linked B window. Closing the main window exits the application. This version does not restore documents after exit.

## Controls

- Open or drop a PDF in each pane.
- Enter one keyword per line and use the search command to append highlights. The last submitted word becomes active; other words retain highlights but display an unlocated status until selected.
- Clicking diagram text adds the complete word, preserves the clicked location in that pane, and locates its first match in the other document. Adjacent text fragments share one complete highlight outline.
- Click a keyword to locate its first match in each document.
- Previous/next arrows traverse all matches in the selected document, with a current/total counter and wraparound.
- Consecutive clicks on the active word's current page cycle through that page's matches. Returning from another page or another active word starts with its first match.
- Use the hand-tool toggle for left-button dragging, or drag with the middle mouse button without changing tools.
- Ctrl + mouse wheel zooms around the pointer. The percentage input accepts 10% to 3200%.
- Zoom updates the existing preview immediately, then redraws the visible region from PDF content. Image-only PDFs remain limited by their source resolution.
- Page turns retain up to three recent previews/text layers, with a six-million-preview-pixel budget and a soft 30,000-text-node budget (the active page is retained). Neighbor pages are prepared during idle time after foreground rendering. First-time pages display graphics before text/highlights are ready; cached pages reuse their DOM and recent precision view. Precision page caches share a separate six-million-pixel budget.
- Precision rendering includes approximately 15% extra viewport width/height on each side. Small pans reuse this buffer without redrawing; leaving the buffer or changing zoom schedules a new precision render. The six-million-pixel canvas budget remains unchanged.
- Outline and dimmed-page modes share the same matches. Page and zoom controls remain independent.
- The dual-window command moves the B viewer to another browser window/tab. Closing it or using restore returns to two panes. Keywords, modes and selected matches remain linked.

## Matching Boundaries

Exact matching treats letters, digits and `_+./#~[]-` as identifier characters. Automatic substring fallback is decided per keyword across the complete document; successful fallback hits are labelled as tolerant, while zero results display not found. During indexing, exact results appear progressively; automatic tolerant results are withheld until scanning finishes. Changing the per-pane forced-tolerance switch relocates that pane's active word using the new results.

Documents without extractable text support viewing only. No OCR, EDA decoding, manual region mapping, or electrical-connectivity inference is performed. A textual hit is not proof of an electrical connection.

## Verification

```powershell
npm.cmd test
npm.cmd run test:viewer
npm.cmd run test:desktop
npm.cmd run build
```

Browser tests require installed Microsoft Edge. Generated PDFs cover same-page navigation, fragmented identifiers, tail-character clicks, rotated subpixel text at actual PDF coordinates, same-start keyword identity, source-view preservation, tolerance switching, initial multi-window navigation and clear-state synchronization, worker disposal, invalid text mappings, damaged files, pointer zoom and panning. Desktop/mobile screenshots are generated under `artifacts/`.

The desktop test uses bundled Electron. When a packaged EXE exists, it copies the complete folder to a temporary Chinese/space-containing path and tests the actual EXE without a dev server. It checks PDF loading, native two-window synchronization, restoration, sandbox isolation and blocked external access.

PDF.js workers, CMaps, fonts and WASM are bundled locally. Generated resources refresh when the PDF.js version changes. Development-only sample access requires `PDF_SAMPLE_DIR`; it exposes PDF filenames from that directory and is absent from production builds.

## Public Source Export

Run `npm.cmd run test:privacy` and `npm.cmd run export:public` to create an allowlisted source ZIP under `exports/`, with a file/hash manifest. It excludes PDFs, CAD/BOM files, screenshots, dependencies, runtime profiles, build logs and generated releases. Use the extracted clean folder for a new GitHub repository rather than uploading the full workspace. `npm.cmd run audit:release` checks the current packaged application and is also run after packaging. See [PUBLISHING.md](PUBLISHING.md) for private-keyword checks, ownership/licensing review, Git history caveats and the limits of automated detection.
