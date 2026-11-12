# Public Release Checklist

## Reviewed Scope

The public source export is an explicit allowlist of source code, tests, build configuration, documentation and two generic SVG assets. Tests generate their PDFs with pdf-lib; no real schematic, board drawing, customer document or screenshot is required to build or test the application.

The exporter deliberately excludes dependencies, generated PDF.js resources, dist output, screenshots, release folders, build logs, archives, local environment files, editor data and model/agent notes. The existing runnable release folders are local outputs, not the source upload.

## Export

```powershell
npm.cmd run test:privacy
npm.cmd run export:public
npm.cmd run audit:release
```

Extract the generated ZIP under `exports/` into a separate clean folder and initialize a new Git repository there. Upload only that folder, not the entire development workspace. `PUBLIC-SOURCE-MANIFEST.json` records relative file names and SHA-256 hashes, never absolute machine paths. The exporter checks both selected files and the ZIP's actual entries.

`audit:release` inspects the current build's app.asar and companion text/SVG files. It also runs automatically after `package:win`. Existing older builds can be checked by passing their unpacked directories directly to `node scripts/audit-distribution.mjs`. Binary runtime internals and images still require an appropriate review before external distribution.

The checks detect common credentials, user-home paths, credential-bearing URLs and private-network URLs. For company names, internal project codes or private domains, set the optional `PUBLIC_AUDIT_TERMS` environment variable locally to a JSON array of those strings. Do not commit the list or include it in issue reports. The exporter reports categories and file names rather than matched secret values.

## Before Uploading

- Confirm company permission to publish code created for work. Removing names does not resolve intellectual-property ownership.
- Review the exported file manifest and inspect every image or document added in the future. Automated checks cannot identify all confidential business meaning.
- Do not add company PDFs, screenshots, CAD/BOM exports, recordings, internal hosts, sample directories, environment files, signing certificates or tokens. Ignore rules are a guard, not an access-control boundary.
- If a file was ever committed, deleting it or adding it to `.gitignore` does not remove its history. Review every branch and tag before pushing. If credentials were disclosed, revoke/rotate them even after rewriting history.
- Do not upload existing runtime profiles, caches, crash dumps, local build logs or unscreened older release archives.
- Rebuild binaries from the clean exported source before publishing GitHub Releases. Verify the app archive and every extra file, not just the visible EXE.
- Choose an appropriate license only after ownership is confirmed. No project license is assigned automatically by this cleanup.
- Keep third-party copyright and license notices intact. Names in Electron, Chromium, PDF.js and font licenses identify upstream rights holders, not project-private company data.

The automated result is a scoped inspection, not a guarantee about unknown company identifiers, future files, external folders, cloud backups or machine-wide data. The original source documents outside this workspace are not modified by the export.

## Signed Updates

The updater accepts only a signed manifest for the fixed repository's newer stable Windows x64 ZIP. `npm.cmd run package:win` bundles ZIP parsing dependencies into the desktop module, audits the package, and invokes `scripts/sign-release.mjs`. If a matching publisher key is available it creates `update-manifest.json`; otherwise the ZIP is for manual installation only. `exports/publish-release.mjs` verifies the archive, signature and all file hashes before allowing publication and includes the signed manifest as a Release asset.

The publisher's Ed25519 private key must remain outside the repository. Initialize a new publisher key with `node scripts/sign-release.mjs --init`; only the public key is printed. The default private key location uses `LOCALAPPDATA` (or the user home fallback) under `PDFCrossProbePublisher/update-signing.pem`; an external `PDF_UPDATE_SIGNING_KEY` path may override it. Keep an access-controlled offline backup. Never commit, upload, paste into a chat, or include this private key in a package. A different key does not match the shipped public trust key and cannot sign official automatic updates; key rotation requires an intentionally authenticated migration. Update signatures do not provide Windows Authenticode signing or remove Windows reputation warnings.

Do not overwrite published versions. Keep version metadata, UI version, output directory, ZIP name and manifest version aligned. The first updater-enabled release must be installed manually from v1.0.0. Run the opt-in installer tests only on temporary copies, including successful startup, a broken executable, and recovery after the backup rename. No GitHub publication or end-user in-place installation should occur as part of normal tests.