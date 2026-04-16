# Codex File Links Open In IDE

Make normal file-reference clicks in the macOS Codex desktop app open in your configured IDE again.

Recent Codex desktop builds can route markdown file links like `src/app.ts:42` into the Codex side panel instead of your IDE. The context-menu action still opens the IDE, but normal click behavior is the annoying part. This skill patches that narrow click path so a normal click goes through Codex's existing `open-file` flow again.

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

After:

- Click the same file reference.
- Codex uses its configured IDE target, such as VS Code, Cursor, or another supported target.

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

When Codex updates and the behavior comes back, ask Codex the same thing again.

## Run Directly

Inspect the installed app without changing anything:

```bash
node ~/.codex/skills/codex-file-links-open-in-ide/scripts/patch-codex-file-links.js --dry-run
```

Apply the patch and ad-hoc re-sign the app:

```bash
node ~/.codex/skills/codex-file-links-open-in-ide/scripts/patch-codex-file-links.js --resign
```

If Codex is installed somewhere else:

```bash
node ~/.codex/skills/codex-file-links-open-in-ide/scripts/patch-codex-file-links.js --app "/path/to/Codex.app" --resign
```

Restart Codex after patching. Already-open windows keep the old renderer JavaScript until the app restarts.

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

Because the replacement is the same byte length, the packed file layout stays unchanged. Modern Electron still validates the changed JavaScript file against ASAR integrity metadata, so the script also recomputes that file's SHA-256 integrity entry inside the ASAR header and writes the new ASAR header hash to `Info.plist`.

## Safety

The script is deliberately conservative:

- It backs up `app.asar` and `Info.plist` to `~/.codex/backups/codex-file-links-open-in-ide/`.
- It requires exactly one known unpatched token before writing.
- It recognizes an already patched app and does not patch twice.
- It verifies that the ASAR header hash still matches `Info.plist`.
- It updates the target file's ASAR integrity metadata so Electron's ASAR validator accepts the patched bundle.
- It can ad-hoc sign Codex.app with the Electron entitlements needed for launch.
- It clears stale app-bundle provenance metadata after ad-hoc signing so macOS does not enforce the old Gatekeeper assessment.

Re-signing is local ad-hoc signing. That means `codesign --verify` can pass, but the app is no longer carrying OpenAI's original notarized signature until you reinstall or update Codex. This is normal for a locally patched macOS app bundle.

The script signs Electron app and XPC targets with:

- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`
- `com.apple.security.cs.disable-library-validation`

Without those entitlements, macOS can launch Codex and then immediately kill it with a dyld error like `Library Validation failed` when the main process loads `Electron Framework.framework`.

## Troubleshooting

`Expected exactly one unpatched click-handler token`

Codex changed its renderer bundle. Do not force the patch. Open an issue with your Codex version and the script output.

`Codex app not found`

Pass the app path explicitly:

```bash
node scripts/patch-codex-file-links.js --app "/path/to/Codex.app" --dry-run
```

macOS refuses to launch Codex

Run the patch with `--resign`, then restart Codex. This re-signs with the Electron launch entitlements and clears app-bundle provenance metadata. If Gatekeeper still blocks it, the cleanest restore is to reinstall or update Codex.

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
