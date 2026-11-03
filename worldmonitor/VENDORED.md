# Vendored upstream

Source: https://github.com/koala73/worldmonitor
Commit: ba1e50a922dd4719b2fbaedb0ff3de8245435ee3 (2026-11-03)
License: AGPL-3.0 (see LICENSE in this directory). Everything in this directory inherits AGPL-3.0.

## Why it is here

AegisMonitor is built on WorldMonitor. The dispatch workspace is a WorldMonitor panel; the rest of
this repository (the core service in `../src`, `../public`, `../kb`, `../contracts`) talks to it over
documented REST + WebSocket only and links none of this code. If this repository is distributed or
offered over a network, AGPL-3.0 obligations (source availability) apply to this directory and to the
modifications below; have counsel confirm how that interacts with the licence of the rest.

## What was ADDED (new files, AGPL-3.0, marked in their headers)

- `src/services/aegis-cad.ts`: REST + WebSocket client for aegis-core-service
- `src/components/AegisCadPanel.ts`, `src/components/aegis-tactical-map.ts`: the CAD panel and its tactical map
- `src/styles/aegis-cad.css`
- `tests/aegis-cad.test.mts`

## What was MODIFIED in upstream files (one registration line or block each)

- `src/config/panels.ts`: `'aegis-cad'` in FULL_PANELS (`enabled: false`) and in the `dataTracking` category
- `src/app/panel-layout.ts`: lazy import of the panel; entry in `DEFERRED_PANEL_NATURAL_FOOTPRINTS`
- `src/config/commands.ts`: CMD+K command `panel:aegis-cad`
- `src/styles/main.css`: `@import './aegis-cad.css'`

No locale file was changed (the panel title is a literal), so upstream's translation pipeline is untouched.
Nothing else under this directory was edited. The `.git` directory was removed so the files are tracked by
the AegisMonitor repository; re-pin with the commit above when updating.

## Running it

```bash
cd worldmonitor && npm ci --ignore-scripts && npm run inventory:facts   # inventory:facts writes gitignored files a fresh checkout lacks
VITE_VARIANT=full npx vite --port 5173 --host 127.0.0.1
# enable "Aegis CAD (Rescue Dispatch)" in panel settings (or CMD+K "aegis"), with aegis-core-service on 127.0.0.1:3001
```

Set `VITE_AEGIS_URL` to point the panel at another core service. A dispatcher token (when the core service
requires one) is typed into the panel and held in memory only.
