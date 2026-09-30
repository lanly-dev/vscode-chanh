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
- Translate `options.toolMode` into `tool_choice`: `Required` with one tool names that tool, `Required` with several tools sends the bare `'required'` string, and `Auto` sends `'auto'`. A local server may ignore the requirement, so an unmet one is logged rather than rejected (see "`Required` is forwarded instead of downgraded" under Landed fixes).
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

### `Required` is forwarded instead of downgraded (92672be)

`options.toolMode` was only honoured for the single-tool case (`options.toolMode === Required && tools.length === 1`) and everything else became `tool_choice: 'auto'`, so an agent turn that told the model a tool call was *required* reached the server as a suggestion. The engine is explicit that this is the provider's job: "The tool-selecting mode to use. The provider must implement respecting this" (`@types/vscode` 1.138.0, `ProvideLanguageModelChatResponseOptions.toolMode`, `index.d.ts:20580`), and the enum says "The language model must call one of the provided tools. Note- some models only support a single tool when using this mode" (`:20911`).

`toolChoiceFor()` now maps the mode: `Auto` stays `'auto'`, `Required` with one tool keeps the explicit function form, and `Required` with several tools goes out as the bare `'required'` string. Measured on `Qwen3-0.6B-GGUF` with two tools (`get_weather`, `get_time`) and "What is the weather in Paris? Use the tool.":

| `tool_choice` sent | Result | Completion tokens |
| --- | --- | --- |
| `'auto'` | `finish_reason: 'tool_calls'`, `get_weather({"city": "Paris"})` | 113 |
| `'required'` | `finish_reason: 'tool_calls'`, `get_weather({"city": "Paris"})` | 98 |
| `'required'` + `enable_thinking: false` | `finish_reason: 'tool_calls'`, `get_weather({"city": "Paris"})` | 20 |

Accepting the requirement is not enforcing it, which is why the turn also reports the miss. Asked for a tool call on a prompt whose answer is prose ("Write one short sentence about lemons.", same two tools, `'required'`), the model returned **no** `tool_calls`: it wrote `{"name": "get_weather", "arguments": {"city": "lemons"}}` blocks into the message *text* and repeated them until `finish_reason: 'length'` at the 200-token cap. A two-city prompt ("...Paris and ...Lyon? Use the tools.") also ended in `'length'` at the 128-token cap with no call. llama.cpp's `--jinja` hands `tool_choice` to the template and the model is free to ignore it, so `provideLanguageModelChatResponse()` logs a warning when a `Required` turn ends without a tool call: the shape it sent, how many tools were offered, whether text or nothing came back, and any dropped calls.

It deliberately does not reject the turn. The prose is still a usable answer, and rejecting would turn a prose-preferring model into a hard failure on every agent turn, where a turn that delivers *nothing* is already rejected by the empty-response check (`bd70441`) and the dropped-call guard (`09937ae`).

`interfaces.ts`'s `tool_choice` union grew the `'required'` arm; it was `'auto' | 'none' | {…}`, so the string now sent had to be added to the only typed contract for the request body.

### Token counts are dropped when the loaded model changes (92672be)

`/v1/tokenize` is not model-parameterised (see the note under `ee90799`), so every memoised count in `tokenCounts` belongs to whichever model the server had loaded when it was taken — yet the memo was keyed by the text alone, so after a model switch the host kept sizing requests with counts from the previous vocabulary until the cache filled or the provider was disposed.

`noteTokenCountModel()` records the model the memo belongs to and clears it when that changes. The request path calls it once the model it is about to call is loaded (or confirmed loaded), and the status handler calls it when the server reports `RUNNING` again, because a restart discards the loaded set; the log line names the model whose counts were dropped.

Known limitation, unchanged: the loaded model is only observed where a request ensures it, so counts taken while a different model is loaded stay cached until the next request, and two llms loaded at once cannot be told apart here. Counting is host bookkeeping — it sizes prompts and never reaches the model — so this is a correctness tidy-up rather than an agent-quality fix.

### Unparseable tool arguments fail the turn instead of running the tool empty (09937ae)

`parseToolCall()` returned `args: {}` for any `arguments` string it could not parse, so a corrupt call ran the tool with no arguments and nothing was logged — the tool reported its own missing parameters and the model was never told to retry.

The shape is real, not hypothetical: the merged-parallel-call bug fixed in `7dc969f` produced concatenated argument objects, which is how the swallow was found. A Markdown-fenced or single-quoted object does the same.

Absent, `null`, and `[]` arguments still count as "no arguments" — a parameterless tool sends those, so failing them would break every no-arg tool. Anything else that does not parse to a JSON object drops the call and logs a bounded copy of the raw fragment. The client already resolved that case (its empty-response check uses its own accumulator), so dropped calls with no text and no survivors now reject with the count and a pointer to the output channel; `reportedText` is exact because empty chunks never reach `onToken` (`src/lemonadeClient.ts:525`).

The call site already skipped `undefined` (`if (tc) toolCalls.push(tc)`), so a dead branch went live rather than new plumbing being added. It is the only place in `src/` that parses model-produced tool arguments.

### The declared context window is split between input and output (966d95d)

`provideLanguageModelChatInformation()` published the whole window as `maxInputTokens` while `maxOutputTokens` took half of it, so the declared pair summed to 1.5x the real window (6144 against 4096 on the test model). On llama.cpp the window is shared by prompt and completion — an uncapped turn stopped at exactly `total_tokens == ctx_size` — so the host could assemble a prompt the completion no longer fitted alongside, and the server then dropped the oldest tokens without saying so. `contextBudget()` now returns both halves, input being the window minus the completion share, and the tooltip shows the window alongside the reserved share.

The request cap follows the declared output: `outputTokenLimit()` prefers `maxOutputTokens`, because re-deriving it from the shrunken `maxInputTokens` would halve the cap and would also break the `64927e1` invariant that the declared and sent numbers agree. The completion share itself is unchanged, so a 4096-token window still caps at the 2048 measured under `f00a788`. The trade-off: on a small window the host now keeps roughly half the history it used to, and buying that back means shrinking the completion share — a decision to make with live agent-mode behaviour in hand rather than by guesswork.

### Picker labels match case-insensitively (966d95d)

`provideLanguageModelChatInformation()` filtered with `labels?.includes('chat') && labels?.includes('tool-calling')`, so a `Chat` or `Tool-Calling` label would have hidden a model from the picker with no error. Every label on the live 11.8.1 server is lowercase, so nothing is hidden today; the filter is now `isToolCallingChatModel()`, where `ModelManager.capabilityFor()` owns the `chat`/`llm` alias and `tool-calling` is compared lowercased.

`vision` sets `imageInput` and the `detail` subtext, and it stays a substring test rather than `capabilityFor`, which folds image *generation* into `image` and must not claim image input. `capabilityFor` also maps an `llm` label to the chat capability, so an `llm`-labelled model that advertises tool calling is now listed where a strict `chat` test skipped it.

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

- [ ] `src/lmcProvider.ts:341` - a reasoning model is never told to stop thinking, and on the one model measured that costs real work. Adding `chat_template_kwargs: {"enable_thinking": false}` to the request body against `Qwen3-0.6B-GGUF` returned the identical tool call for a fifth of the tokens (20 completion tokens against 98), and twice turned a turn that had ended in `finish_reason: 'length'` with nothing forwarded into a clean call. It is a candidate rather than a proven fix: one 0.6B model and one recipe were measured, the flag is llama.cpp-specific, and the only gate the provider can see is the server's `reasoning` label. Shape it as an opt-in `chanh.*` setting (1.138's `LanguageModelChatInformation` has no `configurationSchema`, so there is no per-model control in the picker, and the server's own `--reasoning-budget 0` only applies at load time) and default it to today's behaviour until a 4B-class reasoning model has been measured on a real agent task. `interfaces.ts` has no field for it yet.

### Investigated and disproven (do not re-open without new evidence)

Re-checked against the running Lemonade 11.8.1 server on 2026-09-30. Each of these was recorded here as a defect and turned out not to be one:

- The `?? 8192` fallback for a missing `context_length` is unreachable. `context_length` is present on every catalog entry and does track `ctx_size` overrides (4096 <-> 32768 verified with a round trip through `/v1/models/{id}/options` on `LFM2-1.2B-GGUF`), so it is dead code rather than a silent cap on a larger model.
- The exact label match is not why any model is missing: every label on the live server is lowercase. The case-insensitivity item above is defensive, not a fix.
- `vscode.lm.registerTool()` is not what enables autonomy. `options.tools` is already forwarded (`src/lmcProvider.ts:313-316`) and VS Code owns the tool loop (`:310-312`), so agent mode works without the extension registering anything. The provider's job is metadata, not tools.
- `tool_choice: 'required'` is accepted by the server: a probe returned `finish_reason: 'tool_calls'` with `{"path": "foo.txt"}`, so the single-tool `Required` promotion was sound. That answered the only question this list can answer (is the wire format accepted) and the forwarding itself is now implemented — see "`Required` is forwarded instead of downgraded" under Landed fixes. What the item got wrong was treating acceptance as enforcement.
- The `/v1/health` name match is sound: `all_models_loaded[].model_name` equals the `/v1/models` id, so the `alreadyLoaded` probe does not cause a redundant `/v1/load`.
- Model availability is not a constraint. 19 models are downloaded and 7 carry both `chat` and `tool-calling` (`Bonsai-1.7B/4B/8B`, `LFM2.5-1.2B-Instruct`, `MiniCPM-V-4.6`, `Qwen3-0.6B`, `Qwen3.5-4B-MTP`).
- Deriving a per-model `version` fixes nothing the picker needs. `LanguageModelChatInformation.version` is documented in 1.138.0 as "Opaque version string of the model. This is used as a lookup value in `LanguageModelChatSelector.version`" (`index.d.ts:20616`) — a `selectChatModels` key, with no caching semantics anywhere in the interface. The documented change signal is `onDidChangeLanguageModelChatInformation`, "An optional event fired when the available set of language models changes" (`:20696`), which the provider already fires on a status change to `RUNNING` (`src/lmcProvider.ts:167`) and on an active-server change, and `ModelManager` calls `lmcProvider.refresh()` after a context-size change (`src/modelManager.ts:438`). The proposed implementation was also unavailable as written: `LemonadeModel` carries no mtime, and `size` is a poor discriminator rather than an absent field — `Qwen3-0.6B-GGUF` reports `0.356` on `/v1/models` and `/v1/models?show_all=true` alike, the same value a same-quant re-download would report again.

### Existing

- [ ] `src/lmcProvider.ts:258` - cache or drop the `/v1/health` pre-check before `/v1/load` (the `alreadyLoaded` probe around `client.getHealth()`).
- [ ] `src/modelManager.ts:457` - add tests for `setModelContext()` sizing, min/max limits, and reload failure.
- [ ] `src/serverManager.ts:527` / `src/serverManager.ts:803` - verify port-occupied, reconnect, and mode-switch paths in `start()` / `stop()`.
- [ ] `src/lemonadeClient.ts:133` - confirm real error codes for corrupt model files.
- [ ] `src/lemonadeClient.ts:622` - replace the generic `/fix` and `/explain` prompts in `buildSystemPrompt()` with tested templates.
- [ ] `src/serverTreeview.ts:1001` - decide on capability-group header actions, if any.
- [ ] `src/serverTreeview.ts:94` - probe server download APIs and reconcile with local partials (`_downloads`, `_partials`, `PARTIALS_STORAGE_KEY`).
- [ ] `src/serverTreeview.ts:129` - decide how to surface backends the server has installed but `/v1/system-info` still reports as `installable`.
- [ ] Add a test harness before the testing items above can be written: `package.json` defines no `test` script and the repository contains no test files. Any runner also needs a way to stand in for the `vscode` module, since `lmcProvider.ts`, `serverTreeview.ts`, and `modelManager.ts` all import it at module scope.
- [ ] Need to check if memory leak, found many vscode processes)
