# ⚠️ WARNING: FAILING PROJECT ⚠️

This project is a documented failed attempt to patch Codex desktop file-link behavior.

The goal was simple: make normal markdown file-reference clicks in Codex open in the configured IDE again, instead of opening inside Codex. The context-menu path already opens the IDE, so this should have been a setting. It is not exposed as one, and patching the app bundle runs into Electron ASAR validation, macOS signing, and macOS permission problems.

The frustrating result: users are stuck with the slower right-click/context-menu workflow until Codex exposes a supported setting or fixes normal file-link clicks upstream. That is annoying, unnecessary, and a pretty miserable place to land for something this basic.

## Findings

- Codex desktop routes normal markdown file-link clicks through an internal side-panel branch when a feature gate is enabled.
- The existing IDE-opening path still exists, which is why right-click/context-menu actions can open the IDE.
- A narrow byte patch can disable the side-panel branch, but modifying `app.asar` is not safe on current Codex desktop builds.
- Electron validates ASAR file blocks at runtime. Even after recomputing the visible file integrity hash and updating `Info.plist`, Codex still crashed with `Failed to validate block while ending ASAR file stream`.
- Editing the app bundle invalidates OpenAI's signature. Ad-hoc signing can make `codesign` pass, but it causes macOS trust, keychain, TCC, and permission prompt weirdness because the app is no longer signed by OpenAI.
- Re-signing without Electron entitlements also causes dyld to reject `Electron Framework.framework` with a `Library Validation failed` error.
- The safest recovery is to restore the original `app.asar` and `Info.plist`, re-sign only if necessary to repair the local bundle, and leave the click behavior unmodified.
- The published script now refuses to apply the patch and is safe for inspection only.

# Codex File Links Open In IDE

Make normal file-reference clicks in the macOS Codex desktop app open in your configured IDE again.

> **Current status:** patch application is disabled for current Codex builds because the patched ASAR can still crash Electron's runtime ASAR validator. See [issue #1](https://github.com/EthanSK/codex-file-links-open-in-ide/issues/1). The script is currently safe for inspection only.

Recent Codex desktop builds can route markdown file links like `src/app.ts:42` into the Codex side panel instead of your IDE. The context-menu action still opens the IDE, but normal click behavior is the annoying part. This repository documents the attempted patch and why it is currently disabled.

## What This Is

This repository contains:

- A Codex skill you can install into `~/.codex/skills`.
- A self-contained Node script that patches `/Applications/Codex.app`.
- Friendly checks, backups, and validation so the patch fails closed if Codex changes.

It is intentionally small. It does not install npm dependencies, phone home, modify your projects, or change your IDE preference.

## Before And After

Before:

- Click a Codex markdown file reference.
- Codex opens the file in its side panel.
- You have to right-click or use a context menu to open it in your IDE.

Intended after:

- Click the same file reference.
- Codex uses its configured IDE target, such as VS Code, Cursor, or another supported target.

Actual status:

- The patch is disabled because the patched Codex app crashes.
- Use the context menu until Codex exposes a supported setting or fixes the click path.

## Compatibility

Supported:

- macOS
- Codex desktop app installed at `/Applications/Codex.app`
- Node.js available on your `PATH`
- Codex builds that still contain the known minified click-handler token

Not supported:

- Windows or Linux
- Codex web
- Future Codex builds where the click handler has changed enough that the token is gone

The script was originally written against Codex desktop `26.409.20454`. It is designed to inspect the installed app and stop if it cannot prove the expected patch is still valid.

## Install As A Codex Skill

Clone this repository into your Codex skills folder:

```bash
mkdir -p ~/.codex/skills
git clone https://github.com/EthanSK/codex-file-links-open-in-ide.git ~/.codex/skills/codex-file-links-open-in-ide
```

Then ask Codex:

```text
Use $codex-file-links-open-in-ide to patch Codex file links so they open in my IDE.
```

The skill currently inspects the app and refuses to patch. Do not use it as an automatic reapply tool until [issue #1](https://github.com/EthanSK/codex-file-links-open-in-ide/issues/1) is resolved.

## Run Directly

Inspect the installed app without changing anything:

```bash
node ~/.codex/skills/codex-file-links-open-in-ide/scripts/patch-codex-file-links.js --dry-run
```

Patch application is currently disabled because it can crash Codex. The old command is intentionally blocked:

```bash
node ~/.codex/skills/codex-file-links-open-in-ide/scripts/patch-codex-file-links.js --resign
```

If Codex is installed somewhere else:

```bash
node ~/.codex/skills/codex-file-links-open-in-ide/scripts/patch-codex-file-links.js --app "/path/to/Codex.app" --resign
```

Do not patch current Codex builds. The command is blocked because it can leave Codex crashing.

## How It Works

Codex desktop is an Electron app. The renderer code lives in `Contents/Resources/app.asar`. In the affected builds, the markdown file-link handler has a side-panel branch guarded by a feature gate. That branch wins before the existing IDE-opening path runs.

The patch changes one same-length minified JavaScript token:

```js
if(d&&m){PX(f,l==null?o:jt(l,o));return}
```

to:

```js
if(0&&m){PX(f,l==null?o:jt(l,o));return}
```

Because the replacement is the same byte length, the packed file layout stays unchanged. Modern Electron still validates the changed JavaScript file against ASAR integrity metadata, so the script also tried recomputing that file's SHA-256 integrity entry inside the ASAR header and writing the new ASAR header hash to `Info.plist`.

That was not sufficient on Codex `26.409.20454`: Electron still crashed with `Failed to validate block while ending ASAR file stream`. Until that is understood, the script refuses to apply the patch.

## What The Script Tried

The attempted patch had to do more than change one byte sequence. The full sequence was:

1. Inspect `/Applications/Codex.app/Contents/Resources/app.asar`.
2. Verify the ASAR header hash matches `Info.plist`.
3. Count the unpatched and patched click-handler tokens.
4. Stop unless the app is already patched or exactly one known unpatched token exists.
5. Back up `app.asar` and `Info.plist` under `~/.codex/backups/codex-file-links-open-in-ide/`.
6. Patch the side-panel branch in the renderer JavaScript. Currently disabled.
7. Locate the patched file entry inside the ASAR header.
8. Recompute that file's ASAR integrity hash and block hash.
9. Rewrite the ASAR header with the updated file integrity.
10. Write the new ASAR header hash back to `Info.plist`.
11. Ad-hoc sign nested Electron code and the app bundle with the required launch entitlements.
12. Clear stale app-bundle provenance metadata.
13. Verify the final app bundle with `codesign`.

This sequence is documented because it is what was tried. The script now stops before the write step until [issue #1](https://github.com/EthanSK/codex-file-links-open-in-ide/issues/1) is resolved.

The script only modifies the Codex app bundle and its own backup directory. It does not touch Codex chats, workspaces, browser state, project files, or `~/Library/Application Support/Codex`.

## Safety

The script is deliberately conservative:

- It backs up `app.asar` and `Info.plist` to `~/.codex/backups/codex-file-links-open-in-ide/`.
- It requires exactly one known unpatched token before writing.
- It recognizes an already patched app and does not patch twice.
- It currently refuses to write the patch because current Codex builds can crash after patching.
- It verifies that the ASAR header hash still matches `Info.plist`.
- It contains code for updating the target file's ASAR integrity metadata, but patch writes are disabled because that still did not satisfy Electron's runtime validator.
- It contains code for ad-hoc signing Codex.app with the Electron entitlements needed for launch, but that is not a substitute for OpenAI's official signature.
- It contains code for clearing stale app-bundle provenance metadata after ad-hoc signing, but patch writes are disabled.

Re-signing is local ad-hoc signing. That means `codesign --verify` can pass, but the app is no longer carrying OpenAI's original notarized signature until you reinstall or update Codex. This is normal for a locally patched macOS app bundle.

The script signs Electron app and XPC targets with:

- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`
- `com.apple.security.cs.disable-library-validation`

Without those entitlements, macOS can launch Codex and then immediately kill it with a dyld error like `Library Validation failed` when the main process loads `Electron Framework.framework`.

## Why The Extra Steps Matter

Two things made the first simple patch unsafe on current Codex desktop builds:

ASAR file integrity:

- The JavaScript token lives in `webview/assets/large-empty-state-DEvsPXBF.js` inside `app.asar`.
- Electron validates file blocks inside the ASAR at runtime.
- A byte-only patch can make Codex die with an error like `Failed to validate block while ending ASAR file stream`.
- Updating the per-file ASAR integrity entry and the top-level `Info.plist` ASAR hash fixes that.

macOS launch signing:

- Editing the bundle invalidates the original OpenAI signature.
- Re-signing without the right Electron entitlements can make dyld reject Electron's bundled framework.
- The observed failure looked like `Library Validation failed` for `Electron Framework.framework`.
- Signing with `allow-jit`, `allow-unsigned-executable-memory`, and `disable-library-validation` fixes that local launch path.

Gatekeeper provenance:

- macOS can keep app-bundle provenance metadata that points at a stale security assessment.
- The script clears provenance metadata only from `/Applications/Codex.app` after signing.
- User data and Codex state are not touched.

## Validation Checklist

In the safe, unpatched state, these checks should pass:

```bash
node ~/.codex/skills/codex-file-links-open-in-ide/scripts/patch-codex-file-links.js --dry-run
codesign --verify --deep --strict --verbose=2 /Applications/Codex.app
open -a /Applications/Codex.app
```

The dry-run should report:

```text
Old token matches: 1
Patched token matches: 0
Status: patchable, but patch application is disabled because it currently crashes Codex
```

It should also show the same ASAR header hash for:

```text
ASAR header hash
Info.plist ASAR header hash
```

If Codex is patched and crashing, restore the original `app.asar` and `Info.plist` from backup or reinstall/update Codex to get back to the official app bundle.

## Troubleshooting

`Expected exactly one unpatched click-handler token`

Codex changed its renderer bundle. Do not force the patch. Open an issue with your Codex version and the script output.

`Codex app not found`

Pass the app path explicitly:

```bash
node scripts/patch-codex-file-links.js --app "/path/to/Codex.app" --dry-run
```

macOS refuses to launch Codex

Do not run the patch on current Codex builds. The cleanest restore is to reinstall or update Codex. If using this repo's local backups, restore the original `app.asar` and `Info.plist`, then re-sign only if needed to repair the local bundle.

`Failed to validate block while ending ASAR file stream`

The app has a patched ASAR payload that Electron rejects at runtime. Restore the original ASAR or reinstall/update Codex.

`Library Validation failed` or `Electron Framework.framework not valid for use in process`

The app was ad-hoc signed without the Electron launch entitlements, or the local signature is otherwise not equivalent to OpenAI's. Reinstall/update Codex to return to the official signature.

Links open in the wrong editor

This patch only restores Codex's existing open-file path. Change Codex's IDE target in Codex settings or the relevant Codex state file, then retry a link.

## Restore

Codex updates replace the app bundle and remove the patch. That is the easiest way to return to the official signed app.

The script also keeps backups of the patched files under:

```text
~/.codex/backups/codex-file-links-open-in-ide/
```

Those backups are useful for inspection, but restoring the original Apple notarization state is best done by reinstalling or updating Codex.

## License

MIT
