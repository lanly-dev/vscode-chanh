# Chanh 🍋 — interactive UI mockup

A self-contained, clickable prototype of the **Chanh** VS Code extension. It recreates the surfaces a user actually touches — the server/model tree, model info, chat, the native model picker, settings, quick picks and notifications — using simulated data.

The goal is to demo and iterate on the UX without installing the extension, running Lemonade, or downloading a model.

## Run it

Open [`index.html`](index.html) directly in a browser. There is no build step, server or dependency.

- Click **Play demo** in the title bar for a 7-step guided tour of the main workflows.
- `Ctrl/Cmd + Shift + P` opens a working command palette (`F1` works too).
- `Esc` closes overlays; `←` / `→` navigate the tour.

## What is clickable

| Surface | Things to try |
| --- | --- |
| **Server tree** | Expand/collapse sections, switch server mode, start/stop the server, refresh, hide the model catalog with the eye button |
| **Installed models** | 22 models grouped by capability; expand Chat/Image/Transcription; filter a group by sub-capability; toggle flat/grouped view |
| **Downloadable models** | Toggle hot-only, download a model, watch progress, cancel and retry a partial download |
| **Model rows** | Click for Model Info; hover for load/unload, info and backend actions; right-click for the full context menu |
| **Model Info** | Read all server metadata, change context size, pick a backend, open the model in chat, add a VS Code chat endpoint |
| **Chat** | Seeded `/explain` conversation, streaming answers, `/fix`, token footer, model picker, new chat |
| **Settings** | Change server mode/URL, ports, max loaded models, token stats, sample interval and chat model |
| **VS Code chrome** | Tabs, quick picks, command palette, toasts, dialogs and keyboard shortcuts |

## Design notes

- Mocked data mirrors the real tree labels, counts and actions in `src/serverTreeview.ts`, `src/modelManager.ts`, `src/lmcProvider.ts` and `src/chatParticipant.ts`.
- The native picker lists chat models with **tool-calling** and **vision** badges, matching the extension's agent-mode behaviour.
- Context size, backend selection, downloads, server switching and endpoint configuration are simulated in memory; nothing is written to disk and no network request is made.
- The look intentionally follows VS Code's dark theme, including activity bar, tabs, quick picks and status bar.

## Files

```
mockup/
├─ index.html        # shell + icon sprite
├─ styles.css        # VS Code dark theme
├─ app.js            # state, rendering and interactions
├─ assets/           # Chanh logo + capability icons copied from media/
├─ preview.png       # static preview of the initial view
└─ README.md
```

## Presenting it

1. Open on the **Model Info** tab and point out the live local server, model metadata, context window and backend.
2. Click **Play demo** and walk through the seven tour stops.
3. After the tour, download a model from the tree and open the Chat tab while it downloads.
4. Finish in **Settings** to show how server mode, ports and token stats are configured.
