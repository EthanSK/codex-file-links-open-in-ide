---
name: codex-file-links-open-in-ide
description: Patch the macOS Codex desktop app so markdown file-reference clicks open through Codex's configured IDE target instead of the Codex side panel. Use when Codex updates restore file links opening inside Codex, when the user asks to reapply the file-link IDE patch, or when investigating this specific Codex app link-click regression.
---

# Codex File Links Open In IDE

## When To Use

Use this skill when the macOS Codex desktop app opens markdown file-reference clicks inside Codex instead of the user's configured IDE. This is usually noticed after a Codex update.

## Workflow

1. Resolve the skill directory from the loaded `SKILL.md`.
2. Run the bundled patch script in inspection mode:

```bash
node <skill-dir>/scripts/patch-codex-file-links.js --dry-run
```

3. If the script reports `patchable` or `already patched`, apply or re-sign the patch:

```bash
node <skill-dir>/scripts/patch-codex-file-links.js --resign
```

4. Verify the patch and launch state:

```bash
node <skill-dir>/scripts/patch-codex-file-links.js --dry-run
codesign --verify --deep --strict --verbose=2 /Applications/Codex.app
open -a /Applications/Codex.app
```

5. Tell the user to restart Codex. Already-running renderer windows keep old JavaScript until restart.

## What It Patches

The regression is caused by the renderer file-link click handler in `app.asar`. When Codex's side-panel feature gate is enabled, normal clicks open a Codex side panel before the existing `open-file` path reaches the configured IDE target.

The script applies a same-length byte patch to the packed ASAR:

```js
if(d&&m){PX(...)
```

becomes:

```js
if(0&&m){PX(...)
```

This disables only the side-panel click branch. Context-menu actions and the normal IDE-opening IPC path remain intact.

The script also updates the patched JavaScript file's ASAR integrity hash and then updates `Info.plist` with the new ASAR header hash. Without that, Electron can kill Codex at launch with an ASAR validation failure.

## Safety Rules

- Only use the bundled script; do not hand-edit `app.asar`.
- The script must fail if it cannot find exactly one known unpatched token.
- The script creates timestamped backups under `~/.codex/backups/codex-file-links-open-in-ide/`.
- Pass `--app <path>` if Codex is installed somewhere other than `/Applications/Codex.app`.
- Codex updates replace the app bundle, so this patch may need to be reapplied after updates.
- Actual patching requires `--resign`; dry-run mode is the only no-write mode.
- Re-signing is ad-hoc signing with the Electron entitlements needed for launch, including disabled library validation. It verifies locally with `codesign`, but it is no longer the original OpenAI notarized signature until Codex is updated or reinstalled.
- The script clears app-bundle provenance metadata after ad-hoc signing because macOS can otherwise enforce a stale Gatekeeper assessment. This touches only `/Applications/Codex.app`, not Codex user data or chat state.
