# AegisMonitor: repo facts for Claude Code

Spec: `~/Downloads/finalprompt.md` (the brief). `README.md` has the requirement-by-requirement status; keep it honest.

## Commands

```bash
npm test      # 152 tests, ~1 s. Scoped to test/*.test.mjs on purpose (see landmines)
npm start     # 127.0.0.1:3001; panel /, phone app /field.html
# WorldMonitor extension (inside worldmonitor/): 
cd worldmonitor && npx tsc --noEmit && node scripts/run-data-tests.mjs tests/aegis-cad.test.mts tests/panel-config-guardrails.test.mjs
```

## Landmines (each one cost time)

- **`node --test test/` crashes on Node 25** (treats the dir as a module). Use the glob in `package.json`. Bare `node --test`
  would also discover ~thousands of WorldMonitor test files, so never run it from the repo root.
- **`worldmonitor/` is vendored, tracked, AGPL, and must never be gitignored** (the user wants it pushed with this repo).
  The root `.gitignore` anchors `/data/` so it does not swallow `worldmonitor/data`. Core-service code must not import from it.
- The core service needs **Node >= 22.13** (`node:sqlite`). Add `--disable-warning=ExperimentalWarning` when running by hand.
- Another local app often owns `*:3001` on IPv6; `localhost:3001` may hit it. Use `127.0.0.1`.
- zsh expands unquoted globs (`--include=*.ts` fails with "no matches"); quote them.
- A fresh WorldMonitor checkout shows a Vite error overlay until `npm run inventory:facts` creates gitignored generated files.
- `AEGIS_MASTER_KEY` unset = ephemeral device keys: restarting the server invalidates any sealed packet you saved.
- The panel/field/WM-extension were verified in a real browser by driving headless Chrome over the DevTools protocol (the
  Claude-in-Chrome extension was not connected). Harness lives outside the repo; re-create it if needed.

## Rules the code enforces (do not weaken without asking)

- Duress OR `silent_mode` => reply is exactly `HAPTIC_ACK_ONLY`; text downlink is refused (409). A cancel from a covert device is only a request.
- The triage object has exactly the 8 brief keys. Provenance goes beside it.
- Urgency never relaxes on its own; the model pass can only raise it; assets named by the model must exist in the slice.
- Unknown vitals are `0`, never invented. A layer with no data is reported `unavailable`, never faked.
- First-aid replies come from the incident's own facts (SOS code, vitals), never from nearby hazards.

## Open decisions for the user

Duress sequence (7 presses), priority/deterioration thresholds, per-mode speeds and weather minima, KB clinical review, and
whether to add a deck.gl layer to the main WorldMonitor map (about 20 upstream files plus guard tests) are all assumptions.
