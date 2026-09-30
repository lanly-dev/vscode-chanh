# Chanh development notes

Verified against the current TypeScript source on 2026-09-30. Treat this file as agent-facing implementation guidance, not as a substitute for checking the Lemonade Server API version supported by a release.

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

## Backend installation and `/v1/system-info`

`ServerViewProvider` caches the `/v1/system-info` report (`_systemInfo` / `_systemInfoStale`) because it is large and only changes when a backend is installed. `refreshServer()` sets `_systemInfoStale = true` so the next `getChildren` re-queries it, and `ModelManager.selectBackend()` calls `refreshServer()` right after an on-demand `installBackend()`.

Known limitation:

- After an on-demand backend install, the server's `/v1/system-info` is not guaranteed to report the new backend immediately. The freshly fetched report can still show `state: 'installable'` for the backend that was just installed, so the tree's backend count, the installed/installed icons, and the `Installed` / `Installable` labels in the "Select Backend" quick pick can lag behind reality. Only the server is authoritative here; the extension does not patch the cached response. A later `refreshServer()` (or restarting the server) is what converges the view.

## Native agent provider contract

`ChanhLmcProvider` is a thin translator between VS Code's agent harness and the OpenAI-compatible Lemonade API:

- Forward `options.tools` without executing tools in the provider.
- Omit `tools` and `tool_choice` when the tool list is empty; some servers reject empty arrays.
- Run one streamed completion per `provideLanguageModelChatResponse()` call.
- Report text as `LanguageModelTextPart` and tool calls as `LanguageModelToolCallPart`.
- Preserve tool results as `role: 'tool'` messages keyed by `tool_call_id`; do not flatten them into user text.
- The native picker lists only models carrying both exact `chat` and `tool-calling` labels. Plain chat models remain available through `@chanh`.
- A `vision` label enables image input and picker detail. Text token counts come from the server's own tokenizer (`POST /v1/tokenize`), keeping `ceil(chars / 4)` only as the fallback when the server is unreachable; images are still estimated at 1500 tokens each.
- Output is budgeted on both sides of the contract: `maxOutputTokens` declares `outputTokenBudget(context_length)` and every request sends that same number as `max_tokens`, unless `options.modelOptions.max_tokens` overrides it. The window is shared by prompt and completion, so the budget keeps roughly half of it free for the conversation.

Do not add a provider-side tool-execution loop or completion retry loop; VS Code owns that agent loop.

The `LanguageModelChatProvider` interface in the pinned 1.138.0 engine exposes only the four methods above — there is no prepare/precache hook — so the provider cannot inject project context itself. Improving how the model behaves in agent mode is therefore a matter of correct metadata (budgets, capabilities, versions) and of the host's own tool selection, not a provider-side loop. See "Agent quality (native agent mode)" under Current TODO for the specific gaps.

## Request and timeout policy

`LemonadeClient` uses socket inactivity rather than total wall-clock limits:

| Request class | Current guard | Purpose |
| --- | --- | --- |
| Normal JSON requests | 15 seconds | Fail fast for health, catalog, options, and delete requests |
| `POST /v1/load` | 10 minutes | Allow long silent model loads |
| Chat completion stream | 120 seconds of socket silence | Detect a hung response while allowing slow streaming |

The stream watchdog resets whenever socket activity arrives. It also bounds initial prefill: a very large first prompt on a slow CPU-only model can exceed 120 seconds before the first token. Tool-call-only streamed responses are valid and must not be treated as empty failures.

---

## Landed fixes

Verified against Lemonade Server 11.8.1 (llama.cpp backend, `Qwen3-0.6B-GGUF`) on 2026-09-30. The commit named in each heading is where that change landed.

### Unparseable tool arguments fail the turn instead of running the tool empty (pending commit)

`parseToolCall()` returned `args: {}` for any `arguments` string it could not parse, so a corrupt call ran the tool with no arguments and nothing was logged — the tool reported its own missing parameters and the model was never told to retry.

The shape is real, not hypothetical: the merged-parallel-call bug fixed in `7dc969f` produced concatenated argument objects, which is how the swallow was found. A Markdown-fenced or single-quoted object does the same.

Absent, `null`, and `[]` arguments still count as "no arguments" — a parameterless tool sends those, so failing them would break every no-arg tool. Anything else that does not parse to a JSON object drops the call and logs a bounded copy of the raw fragment. The client already resolved that case (its empty-response check uses its own accumulator), so dropped calls with no text and no survivors now reject with the count and a pointer to the output channel; `reportedText` is exact because empty chunks never reach `onToken` (`src/lemonadeClient.ts:525`).

The call site already skipped `undefined` (`if (tc) toolCalls.push(tc)`), so a dead branch went live rather than new plumbing being added. It is the only place in `src/` that parses model-produced tool arguments.

### A single turn can no longer consume the whole context window (`f00a788`)

Uncapped, a turn generated until the server's context filled up, leaving the next agent iteration no room for its history. Measured against a 4096-token window: a rambling prompt returned `finish_reason: 'length'` with `completion_tokens: 4056` and `total_tokens: 4096` — exactly `ctx_size`. `provideLanguageModelChatResponse()` now sends `max_tokens`, taken from `options.modelOptions.max_tokens` when the host supplies a positive number, otherwise from `outputTokenBudget()`: half the window, floor 256, ceiling 4096. The same prompt with `max_tokens: 2048` stops at exactly `completion_tokens: 2048`, `total_tokens: 2088`.

Two consequences worth knowing when reading logs. Capping makes `finish_reason: 'length'` an expected ending for a long answer, so the truncation warning added in `bd70441` now fires on capped turns as well. The empty-response rejection also stays reachable: a thinking model can spend the whole budget on `reasoning_content` and still present as empty, only now at half the budget.

### `maxOutputTokens` no longer over-promises (`64927e1`)

`provideLanguageModelChatInformation()` published `maxOutputTokens: maxInputTokens`, so every model claimed to produce 4096 tokens on a window measured to hold 4096 *in total* — a 2x over-promise against the interface's own wording ("the maximum number of tokens the model can accept as input" / "is capable of producing"). Both values now come from the same `outputTokenBudget()`, so the declared ceiling and the `max_tokens` actually sent cannot disagree.

Deliberately left open: `maxInputTokens` still claims the entire window, so input + output can exceed it (6144 against a 4096 window today). The strictly consistent declaration is `maxInputTokens = window - output` (2048/2048 at 4096), but that makes the host trim history roughly twice as aggressively. Revisit only with evidence about how the host consumes these two fields.

### `provideTokenCount()` asks the server instead of guessing (`ee90799`)

`ChanhLmcProvider.provideTokenCount()` now awaits `LemonadeClient.tokenize()`, which wraps `POST /v1/tokenize`. `ceil(chars / 4)` survives only as `estimateTokens()`, used when the server cannot answer, so counting can never break a request. Counts are memoised in `ChanhLmcProvider.tokenCounts` because the host recounts the whole conversation on every request; the cache is bounded at 512 entries and cleared in `dispose()`. Message parts are joined and tokenized once, so one count costs one round trip.

The retired estimate was wrong in either direction depending on the content:

| Content | Chars | `ceil(chars / 4)` | Server | Error |
| --- | --- | --- | --- | --- |
| English prose | 44 | 11 | 10 | +10% |
| English prose | 119 | 30 | 23 | +30% |
| JSON schema | 77 | 20 | 18 | +11% |
| TypeScript | 64 | 16 | 12 | +33% |
| Windows path | 53 | 14 | 19 | -26% |
| Thai | 22 | 6 | 14 | -57% |

Endpoint behavior worth relying on:

- `POST /v1/tokenize` with `{"content": "<string>"}` returns `{"tokens": [<ids>]}`.
- `content` must be a string: a missing field and a numeric value both return `400`. An empty string returns `{"tokens": []}`.
- The route is **not** model-parameterised. A `model` field is accepted and ignored, so a count always reflects whichever model the server currently has loaded, not the model the caller named. Cross-family counts are therefore approximate.
- `GET /v1/tokenize` returns `405`.

### Streamed tool calls: `index` is authoritative, ids are the fallback (`7dc969f`)

`index` says which call a streamed `tool_calls` delta extends. Defaulting a missing `index` to `0` merged parallel calls into a single slot and concatenated their argument fragments; two calls arrived as one `LanguageModelToolCallPart` whose arguments were invalid JSON, which `parseToolCall()` then swallowed into `{}` — one call silently dropped, the survivor running with no arguments.

Indexed deltas are now authoritative and advance a synthetic allocator past themselves. A delta with no `index` starts a new slot whenever it announces a call id other than the current one, and the stream logs a single warning. A server that omits both `index` and `id` still cannot be split: the stream carries no boundary signal.

Live check: a two-city prompt returned two calls with `index` `0` and `1`, every delta carrying `index` and distinct 32-character ids that survived the round trip.

### Truncated completions are surfaced (`bd70441`)

`finish_reason` was parsed but never read. A stream ending in `finish_reason: 'length'` with no text and no tool calls used to resolve as a successful empty response; it now rejects with an explicit message, and truncation that still produced output logs a warning. Thinking models make this matter: `reasoning_content` deltas can dominate the stream while `delta.content` stays `null`, and reasoning is not forwarded to the host, so a request can burn its whole output budget and still present as an empty answer.

---

## Current TODO

Line references below were re-checked against the source on 2026-09-30. They drift as the files are edited, so grep the named symbol rather than trusting a number.

### Agent quality (native agent mode)

- [ ] `src/lmcProvider.ts:105` - the `tokenCounts` memo is keyed by the text alone, while `/v1/tokenize` is not model-parameterised and counts with whichever model the server has loaded (see the note under `ee90799`). A count can therefore reflect a different vocabulary than the model being counted for, and it survives a model switch until the cache fills or `dispose()`. Key it by the loaded model, or clear it when the loaded model changes.
- [ ] `src/lmcProvider.ts:172` - `maxInputTokens` still claims the whole context window while `maxOutputTokens` now takes half of it, so the declared pair can exceed the real window (6144 against 4096 today). Publishing `window - output` would be consistent but roughly halves the history the host keeps. Decide with real host behaviour in hand rather than by guesswork.
- [ ] `src/lmcProvider.ts:159` - make the `chat` / `tool-calling` label match case-insensitive, reusing `ModelManager.capabilityFor()` (`src/modelManager.ts:38`). Defensive only: every label on the live 11.8.1 server is already lowercase, so the exact match is not hiding any model today, but a differently-cased label would drop a model from the picker with no error.
- [ ] `src/lmcProvider.ts:169` - derive a per-model `version` (mtime or size) instead of the hardcoded `'1.0.0'`, so the picker busts its cache when a model is updated.
- [ ] `src/lmcProvider.ts:253` - honor `options.toolMode` beyond the single-tool `Required` case; currently everything else becomes `tool_choice: 'auto'`. The server accepts both shapes of `tool_choice`, including the bare string `'required'`, so a multi-tool `Required` can be forwarded as-is. Caveat from the engine's own docs: `LanguageModelChatToolMode.Required` states "some models only support a single tool when using this mode", so keep the exact single-tool function form for one tool and treat a multi-tool `Required` as the case to forward, not to downgrade.

### Investigated and disproven (do not re-open without new evidence)

Re-checked against the running Lemonade 11.8.1 server on 2026-09-30. Each of these was recorded here as a defect and turned out not to be one:

- The `?? 8192` fallback for a missing `context_length` is unreachable. `context_length` is present on every catalog entry and does track `ctx_size` overrides (4096 <-> 32768 verified with a round trip through `/v1/models/{id}/options` on `LFM2-1.2B-GGUF`), so it is dead code rather than a silent cap on a larger model.
- The exact label match is not why any model is missing: every label on the live server is lowercase. The case-insensitivity item above is defensive, not a fix.
- `vscode.lm.registerTool()` is not what enables autonomy. `options.tools` is already forwarded (`src/lmcProvider.ts:249-252`) and VS Code owns the tool loop (`:246-248`), so agent mode works without the extension registering anything. The provider's job is metadata, not tools.
- `tool_choice: 'required'` is accepted by the server: a probe returned `finish_reason: 'tool_calls'` with `{"path": "foo.txt"}`, so the single-tool `Required` promotion is sound and could be extended.
- The `/v1/health` name match is sound: `all_models_loaded[].model_name` equals the `/v1/models` id, so the `alreadyLoaded` probe does not cause a redundant `/v1/load`.
- Model availability is not a constraint. 19 models are downloaded and 7 carry both `chat` and `tool-calling` (`Bonsai-1.7B/4B/8B`, `LFM2.5-1.2B-Instruct`, `MiniCPM-V-4.6`, `Qwen3-0.6B`, `Qwen3.5-4B-MTP`).

### Existing

- [ ] `src/lmcProvider.ts:197` - cache or drop the `/v1/health` pre-check before `/v1/load` (the `alreadyLoaded` probe around `client.getHealth()`).
- [ ] `src/modelManager.ts:454` - add tests for `setModelContext()` sizing, min/max limits, and reload failure.
- [ ] `src/serverManager.ts:527` / `src/serverManager.ts:803` - verify port-occupied, reconnect, and mode-switch paths in `start()` / `stop()`.
- [ ] `src/lemonadeClient.ts:133` - confirm real error codes for corrupt model files.
- [ ] `src/lemonadeClient.ts:622` - replace the generic `/fix` and `/explain` prompts in `buildSystemPrompt()` with tested templates.
- [ ] `src/serverTreeview.ts:1001` - decide on capability-group header actions, if any.
- [ ] `src/serverTreeview.ts:94` - probe server download APIs and reconcile with local partials (`_downloads`, `_partials`, `PARTIALS_STORAGE_KEY`).
- [ ] `src/serverTreeview.ts:129` - decide how to surface backends the server has installed but `/v1/system-info` still reports as `installable`.
- [ ] Add a test harness before the testing items above can be written: `package.json` defines no `test` script and the repository contains no test files. Any runner also needs a way to stand in for the `vscode` module, since `lmcProvider.ts`, `serverTreeview.ts`, and `modelManager.ts` all import it at module scope.
- [ ] Leaking test (incomplete note - kept verbatim; needs detail before it can be actioned.)
