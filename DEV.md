# Chanh development notes

Verified against the current TypeScript source on 2026-09-24. Treat this file as agent-facing implementation guidance, not as a substitute for checking the Lemonade Server API version supported by a release.

## Project shape and ownership

- `src/extension.ts`: activation, dependency wiring, command registration, and disposables.
- `src/serverManager.ts`: server selection and lifecycle. Chanh can start/stop only the managed `lemond` process in `LEMOND` mode; `LEMONADE` and `CUSTOM` modes connect to externally managed servers.
- `src/lemonadeClient.ts`: HTTP client and wire-format translation for Lemonade endpoints.
- `src/modelManager.ts`: model lifecycle, download, context configuration, and model-info operations.
- `src/serverTreeview.ts`: server/model tree state, persisted view preferences, and partial-download rows.
- `src/lmcProvider.ts`: VS Code language-model provider for native agent mode.
- `src/chatParticipant.ts`: the separate `@chanh` chat participant.

Keep server process lifecycle in `ServerManager` and model operations in `ModelManager`. Tree items should remain presentation state; invoke the appropriate manager/API rather than duplicating API behavior in `serverTreeview.ts`.

## Download state: current implementation

Downloads are still extension-owned at runtime:

- Active pulls: `ServerViewProvider._downloads`.
- Cancelled or failed pulls: `ServerViewProvider._partials`.
- Persistence for incomplete pulls: VS Code `workspaceState` under `partialDownloads`, shaped as `Array<[modelId, pct]>`.
- Source of progress: the streaming `POST /v1/pull` response parsed by `LemonadeClient.pullModelStream()`.
- Partial-row retry starts another `/v1/pull`; remove uses the model-delete endpoint. There is no server-ledger reconciliation or explicit resume.

Known limitations:

- The extension cannot discover downloads interrupted by another client or while the server continued working.
- Local rows can become stale if files change outside VS Code.
- Completion is inferred from the stream, not a persistent server job.
- Cancelling the extension request does not imply a verified server-side pause/resume contract.

The client currently does not call Lemonade's download-list/control APIs. Before adopting them, verify the exact response schema, supported actions, restart semantics, and behavior on the oldest server version this extension intends to support. Keep local state as a compatibility fallback unless that migration is deliberately implemented and tested.

## Native agent provider contract

`ChanhLmcProvider` is a thin translator between VS Code's agent harness and the OpenAI-compatible Lemonade API:

- Forward `options.tools` without executing tools in the provider.
- Omit `tools` and `tool_choice` when the tool list is empty; some servers reject empty arrays.
- Run one streamed completion per `provideLanguageModelChatResponse()` call.
- Report text as `LanguageModelTextPart` and tool calls as `LanguageModelToolCallPart`.
- Preserve tool results as `role: 'tool'` messages keyed by `tool_call_id`; do not flatten them into user text.
- The native picker lists only models carrying both exact `chat` and `tool-calling` labels. Plain chat models remain available through `@chanh`.
- A `vision` label enables image input and picker detail. Text token counts are estimated at four characters per token; images are estimated at 1500 tokens each.

Do not add a provider-side tool-execution loop or completion retry loop; VS Code owns that agent loop.

## Request and timeout policy

`LemonadeClient` uses socket inactivity rather than total wall-clock limits:

| Request class | Current guard | Purpose |
| --- | --- | --- |
| Normal JSON requests | 15 seconds | Fail fast for health, catalog, options, and delete requests |
| `POST /v1/load` | 10 minutes | Allow long silent model loads |
| Chat completion stream | 120 seconds of socket silence | Detect a hung response while allowing slow streaming |

The stream watchdog resets whenever socket activity arrives. It also bounds initial prefill: a very large first prompt on a slow CPU-only model can exceed 120 seconds before the first token. Tool-call-only streamed responses are valid and must not be treated as empty failures.

---

## Current TODO

### Agent-provider load path

- [ ] In `lmcProvider.ts`, remove or cache the `/v1/health` pre-check before `/v1/load`. The current path adds a health round trip on every agent response and relies on `loadModel()` handling an already-loaded model. Measure behavior and preserve compatibility with supported servers.

### Context configuration validation

- [ ] Add coverage for `setModelContext()` across loaded/unloaded models, automatic (`-1`) sizing, 4K minimum input, `max_context_window`, missing options, and reload failure. Replace the old check this note with tests based on the implemented behavior.

### Managed server lifecycle

- [ ] Verify `ServerManager.start()` and `stop()` transitions for managed process start, reconnecting to an existing Chanh-owned binary, an occupied port owned by another process, and LEMOND-to-non-LEMOND mode changes. Ensure `_usingExistingServer` and `process` ownership cannot be confused.

### Model-load error UX

- [ ] Confirm the Lemonade error codes emitted for incomplete or corrupt model files, then test the friendly message in `loadModel()`. Avoid matching on an unverified single code if current servers expose a structured error shape.

### Download ownership migration

- [ ] Probe the supported server's download-list and download-control contracts. If migration is supported, add typed read-only discovery first, reconcile server jobs with tree rows, and preserve local `workspaceState` as a fallback until compatibility is proven.

### Capability-group actions

- [ ] Decide whether capability group headers need meaningful actions. Grouping, icons, tooltips, multi-capability duplication, hot filtering, and loaded-first ordering are already implemented; only add commands that provide real user value.

### Chat command prompts

- [ ] Replace the generic `/fix` and `/explain` system prompts with tested, repository-safe prompt templates that clearly separate instructions, selected code, and user context.
