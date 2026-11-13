# PDF Cross Probe

A local PDF.js viewer for linked schematic and reference-designator searches. PDFs are read locally, never uploaded, and never modified.

## Run

For Windows users, extract `release/1.1.4/PDF-Cross-Probe-1.1.4-win-x64.zip`, or copy the complete `release/1.1.4/win-unpacked` directory. Double-click `PDF Cross Probe.exe` or `Start.cmd`. The EXE needs its companion files; do not copy it alone. Python, Node.js, WebView2, a local server and an internet connection are not required for viewing. This build has no Windows code-signing certificate and may require approval under Windows or company security policy; do not disable security software. Chinese usage instructions are included in `README.txt`. Versioned output keeps an already-running older release untouched.

Development requires Node.js and npm:

```powershell
npm.cmd install
npm.cmd run dev -- --host 127.0.0.1
```

Use the URL printed by Vite for browser development. An occupied port causes Vite to select another port. To launch the desktop app from source, use `npm.cmd run desktop`. To rebuild the portable Windows folder and ZIP, use `npm.cmd run package:win`.

The desktop app serves bundled assets through a restricted `app://viewer` protocol, keeps Node.js disabled in sandboxed viewer windows, and blocks renderer network requests and arbitrary navigation. Launching the application again without file arguments or using New Window opens an independent blank workspace. Opening PDFs externally from Windows Explorer or the command line prompts to create a new independent A/B workspace or place the file into an existing workspace's A or B pane, with confirmation displaying the original filename before replacing an occupied pane. Multiple independent workspaces (such as two windows holding four unrelated PDFs) keep keywords, highlights, zoom and navigation isolated per workspace. Closing a main window closes only its linked B window; the last window exits the app. Documents are not restored after exit.

## Controls

- Open or drop a PDF in each pane. Password-protected PDFs prompt for a password in that pane, support retry on wrong password or cancellation, and keep the unlocked state across linked dual-window mode.
- Close a drawing with its header close button; this releases its worker and returns the pane to an empty state without changing the PDF.
- Each pane has an independent continuous-reading toggle. Preferences offers `不翻页` (buttons only), `多页滚动` (virtualized page flow), or `单页` (wheel at the boundary turns pages). Wheel-page mode suppresses momentum cascades; Ctrl+wheel zooms around the exact PDF point under the pointer in both single-page and continuous-scroll modes. Mixed page sizes and cross-page selection are supported. Modes and the PDF-coordinate viewing anchor are retained when detaching/restoring B.
- Standard RC4, AES-128 and AES-256 encrypted PDFs are covered by tests. Supply a known opening or owner password; this is not a password-recovery tool. Passwords are used only in current-session memory and local window messages, not written to application storage, URLs or logs.
- Enter one keyword per line and use the search command to append highlights. The last submitted word becomes active; other words retain highlights but display an unlocated status until selected.
- Clicking diagram text adds the complete word, preserves the clicked location in that pane, and locates its first match in the other document. Adjacent text fragments share one complete highlight outline.
- Drag across selectable PDF text to see a blue selection and use Ctrl+C (or the desktop right-click menu) to copy it; paste with Ctrl+V into an editable field or another application. Switch off the hand tool first. Image-only or non-extractable text cannot be selected this way.
- Drag the divider between the two document panes to resize them, or double-click it to return to an even split. Dragging the divider all the way to either edge smoothly collapses that pane and leaves a triangle tab on the edge; click or drag the triangle tab inward to expand the pane back to its previous split. The divider also supports arrow keys, Home and End; the horizontal and vertical layouts keep independent proportions.
- Toggle the left search sidebar (`Ctrl+F` to focus search), swap A/B pane positions with one click, rotate a diagram in 90° steps (`R` shortcut or toolbar button), and use `F3` / `Shift+F3` to step through matches.
- Open the Preferences dialog (`设置`) to switch themes (Light, Dark CAD, or System), adjust PADS spotlight mask opacity, set default highlight/tolerance/auto-fit/layout-memory preferences, and register or remove per-user Windows Explorer right-click menu & "Open with" associations without administrator privileges. External PDF launches always prompt for a new workspace or an existing workspace's A/B slot and ask for confirmation before replacing an existing drawing.
- Click a keyword to locate its first match in each document.
- Previous/next arrows traverse all matches in the selected document, with a current/total counter and wraparound.
- Consecutive clicks on the active word's current page cycle through that page's matches. Returning from another page or another active word starts with its first match.
- Use the hand-tool toggle for left-button dragging, or drag with the middle mouse button without changing tools.
- Ctrl + mouse wheel zooms around the pointer. The percentage input accepts 10% to 3200%.
- Zoom updates the existing preview immediately, then redraws the visible region from PDF content. Image-only PDFs remain limited by their source resolution.
- Page turns retain up to three recent previews/text layers, with a six-million-preview-pixel budget and a soft 30,000-text-node budget (the active page is retained). Neighbor pages are prepared during idle time after foreground rendering. First-time pages display graphics before text/highlights are ready; cached pages reuse their DOM and recent precision view. Precision page caches share a separate six-million-pixel budget.
- Precision rendering retains a 35% base overscan around the viewport and adds bounded lookahead in the scrolling direction, reducing low-resolution edges during moderate pans. A maximum of two graphics tasks run concurrently. Sustained scrolling makes progress without repeatedly canceling the same-scale render. Continuous mode shares preview/precision budgets across visible pages; visible and selected text layers take priority over the soft three-page/30,000-node cache targets. Complex pages can still require noticeable first-render time.
- Outline and dimmed-page modes share the same matches. Page and zoom controls remain independent.
- The dual-window command moves the B viewer to another browser window/tab. Closing it or using restore returns to two panes. Keywords, modes and selected matches remain linked.

## Matching Boundaries

Exact matching treats letters, digits and `_+./#~[]-` as identifier characters. Automatic substring fallback is decided per keyword across the complete document; successful fallback hits are labelled as tolerant, while zero results display not found. During indexing, exact results appear progressively; automatic tolerant results are withheld until scanning finishes. Changing the per-pane forced-tolerance switch relocates that pane's active word using the new results.

On pages containing at least three distinct invisible PDF text markers of the form `PAU` followed by a component reference, recognized markers can also be clicked and searched by the reference alone. The raw marker remains searchable; an identical visible marker is left unchanged. Other marker formats are not inferred.

Documents without extractable text support viewing only. No OCR, EDA decoding, manual region mapping, or electrical-connectivity inference is performed. A textual hit is not proof of an electrical connection.

## Online Updates

Desktop Preferences can automatically check the fixed `Tony9193/pdf-cross-probe` GitHub stable release. Only the main-process update session accesses the network; PDFs and their paths are never sent. Download is optional and cancelable. Installation requires a separate confirmation to close all viewer windows. Releases must include an Ed25519-signed `update-manifest.json`, archive SHA-256, compatible Windows x64 metadata, and per-file hashes. Update signatures are not Windows Authenticode signatures.

Normal exit cancels any in-progress download and waits for cleanup of downloads that have not entered installation. Installation transaction data and recovery backups are preserved; unrelated directories are not scanned or deleted.

The installer stages files next to the portable directory, preserves extra local files, retains an old-version backup, waits for the old process to exit and requires a new-viewer readiness handshake. A local Windows management service starts the independent helper without elevation; if this is unavailable, the viewer stays open and offers manual installation. Failed startup restores the backup. A transaction journal and helper remain under the local application profile's `updates` directory; an interrupted transaction can be recovered by rerunning that job's helper with its `transaction.json`. Do not delete the backup or journal before recovery. Read-only locations, organization policies and unavailable GitHub access may require manual installation; no privilege escalation is attempted. Review the error state and use the fixed GitHub manual-download action when needed.

Published v1.0.0 has no updater, and v1.1.0 through v1.1.2 may fail when GitHub redirects an update request. Manually install v1.1.3 or later once to obtain the fixed updater. Encrypted PDFs require their password again after restarting. See [PUBLISHING.md](PUBLISHING.md) for signing-key custody and signed release publication.

## Verification

```powershell
npm.cmd test
npm.cmd run test:viewer
npm.cmd run test:desktop
npm.cmd run build
```

Browser tests require installed Microsoft Edge. Generated PDFs cover same-page navigation, fragmented identifiers, tail-character clicks, rotated subpixel text at actual PDF coordinates, same-start keyword identity, source-view preservation, tolerance switching, initial multi-window navigation and clear-state synchronization, worker disposal, invalid text mappings, damaged files, pointer zoom and panning. Desktop/mobile screenshots are generated under `artifacts/`.

The desktop test uses bundled Electron. When a packaged EXE exists, it copies the complete folder to a temporary Chinese/space-containing path and tests the actual EXE without a dev server. It checks PDF loading, independent workspaces, linked-window ownership, view restoration, sandbox isolation and a mocked update check. Tests preserve the host clipboard by default; `PDF_TEST_OS_CLIPBOARD=1` explicitly enables a text-only backup/restore clipboard check. `PDF_TEST_INSTALLER=1` enables the temporary-copy Windows install, broken-executable rollback and interrupted-transaction recovery tests in `tests/updater.test.mjs`; `PDF_TEST_FULL_UPDATE=1` enables the packaged signed-download and installation handoff test in `tests/electron.test.mjs`. Package v1.1.4 and retain a v1.0.0 reference folder first. These tests never update the working release folder.

PDF.js workers, CMaps, fonts and WASM are bundled locally. Generated resources refresh when the PDF.js version changes. Development-only sample access requires `PDF_SAMPLE_DIR`; it exposes PDF filenames from that directory and is absent from production builds.

## Public Source Export

Run `npm.cmd run test:privacy` and `npm.cmd run export:public` to create an allowlisted source ZIP under `exports/`, with a file/hash manifest. It excludes PDFs, CAD/BOM files, screenshots, dependencies, runtime profiles, build logs and generated releases. Use the extracted clean folder for a new GitHub repository rather than uploading the full workspace. `npm.cmd run audit:release` checks the current packaged application and is also run after packaging. See [PUBLISHING.md](PUBLISHING.md) for private-keyword checks, ownership/licensing review, Git history caveats and the limits of automated detection.
