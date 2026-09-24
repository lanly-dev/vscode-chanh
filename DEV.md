## Current partial-download tracking: local only

Incomplete downloads are tracked only inside the extension:

- Runtime state: `ServerViewProvider._partials`
- Persistence: VS Code `workspaceState`
  - Key: `partialDownloads`
  - Value: `Array<[modelId, pct]>`
- Created in:
  - `ModelManager.downloadModel()` cancellation path
  - `ModelManager.downloadModel()` failure path
- Cleared in:
  - Successful download
  - Retry/start of download
  - Successful delete/remove
- Displayed in:
  - `getPartialDownloadChildren()`
  - Context value: `CHANH_PARTIAL_MODEL`
- Actions on partial rows:
  - Retry: `chanh.downloadModel` → `POST /v1/pull`
  - Remove: `chanh.removeModel` → `POST /v1/delete`

Limitations:

- No cross-machine visibility.
- No detection of interruptions outside the extension.
- Can go stale if files change outside the extension.
- The extension infers completion from the `/v1/pull` stream, not from a server-owned job ledger.

## Server-owned download state: available but unused

Relevant but currently uncalled endpoints:

- `GET /v1/downloads`
  - Probable purpose: query the server's download-job ledger.
  - Expected data: job id, model, status, percent, bytes, files.
- `POST /v1/downloads/control`
  - Probable purpose: manage an existing download job.
  - Actions are unverified; do not implement pause/resume/cancel/retry/remove through it yet.
- `POST /v1/pull`
  - Documented server-owned mode uses:
    - `stream: true`
    - `subscribe: false`
  - Returns a job snapshot; progress can then be observed through the downloads ledger.

Related upstream work:

- PR #3235: makes `/api/v1/downloads` the source of truth for the desktop GUI.
- PR #2876: interrupted downloads should remain resumable and should not be exposed as completed models.
- Test reference: `test/server_downloads.py`.

## Refactor goal

Stop relying on local `workspaceState` as the source of truth for partial downloads.

Target behavior:

1. Query `/v1/downloads` to determine which downloads/models are incomplete.
2. Derive "Incomplete Downloads" rows from server-owned job records.
3. Keep local partial tracking only as a fallback for:
   - old server versions without `/v1/downloads`;
   - transient client-only cancellation state;
   - offline/unavailable responses.
4. Do not implement `/v1/downloads/control` actions until the action enum is verified against the running server.
5. Retry should eventually reuse/resume server-side state rather than blindly restarting the pull stream.

## Verification steps before refactoring

1. Add a temporary read-only `listDownloads()` client method.
2. Call `GET /v1/downloads` against the local server.
3. Log raw response JSON.
4. Confirm:
   - exact job field names;
   - status values;
   - percent/byte fields;
   - whether cancelled/failed jobs persist;
   - whether partial state survives server restart.
5. Confirm the same on the minimum supported server version.
6. Only then replace `_partials` hydration and row derivation.

## Open questions

- Exact `POST /v1/downloads/control` request and action enum.
- Whether dead jobs are retained or removed automatically.
- Whether non-terminal job records include enough identity to map back to model ids.
- Whether old servers without `/v1/downloads` need indefinite local fallback.

---

## Agent harness and timeout policy

The language model provider (`lmcProvider.ts`) is a **thin translator** for the
VS Code agent harness — the host (Copilot Chat agent mode) owns the tools, the
tool-call loop, edit application, and confirmations. Do not re-add provider-side
tool execution or retry loops:

- Forward `options.tools` as-is (omit `tools`/`tool_choice` when empty — some
  servers reject empty arrays).
- Run exactly one completion per `provideLanguageModelChatResponse()` call.
- Report text via `LanguageModelTextPart` and tool calls via
  `LanguageModelToolCallPart`; never execute tool calls in the provider.
- Translate `LanguageModelToolResultPart` to `role: 'tool'` messages keyed by
  `tool_call_id` — flattening them into user text breaks tool-call correlation.

Model listing policy:

- The picker lists only models with both `chat` + `tool-calling` labels;
  plain chat models remain reachable through the `@chanh` participant, whose
  quick pick intentionally has no tool-calling filter.
- Vision models (`vision` label, not `image` — that's image *generation*) set
  `capabilities.imageInput` and get `detail: 'vision'` in the picker (other
  entries omit `detail` — every listed model is tool-capable by construction,
  so labeling the baseline is noise). User-message images are translated from
  `LanguageModelDataPart` to
  OpenAI `image_url` data-URI content parts; `provideTokenCount` estimates
  ~1500 tokens per image.

Timeout policy in `LemonadeClient` — wall-clock timeouts are the wrong tool for
local inference (duration is unbounded), so each path has its own guard:

| Path | Guard | Rationale |
| --- | --- | --- |
| Health / models / config / delete (`request()` default) | `REQUEST_TIMEOUT_MS` = 15s inactivity | Local server should answer instantly; fail fast for status polling |
| `POST /v1/load` | `LOAD_TIMEOUT_MS` = 10min inactivity | Multi-GB GGUF loads sit silent for minutes |
| Chat (`chatCompletionStream()`) | `STREAM_INACTIVITY_MS` = 120s **silence watchdog** + user cancellation | Every streamed token resets the socket timer, so slow-but-streaming is unaffected; only a hung server trips it |

Watchdog notes:

- `req.setTimeout()` measures socket inactivity, not elapsed time — any byte
  resets it.
- The 120s also bounds **prefill** (silence before the first token). Huge
  agent-mode prompts on CPU-only large models can exceed it → false "hung"
  error. Bump the constant if that shows up in practice.
- Non-streaming `chatCompletion()` was deleted (only `chatCompletionStream()`
  remains); generation must always go through the streaming path.
- `chatCompletionStream()` treats tool-call-only responses (no text) as valid —
  agent-mode models often answer with only a tool call.

---

## TODO: Extension cleanup and disposables

- Evaluate `ServerViewProvider` for disposable cleanup:
  - It registers event listeners (`refreshEvents.onDidRequestRefresh`, `serverManager.onStatusChange`) that are not explicitly disposed.
  - Consider implementing `vscode.Disposable` on `ServerViewProvider` and cleaning up internal subscriptions on deactivation.
- Verify no resource leaks on extension deactivation (event emitters, HTTP clients, timers, etc.).
- Look at start/stop server if it makes sense for all modes or lemond mode only.

## TODO: Code review findings

Severity-ordered, from a full pass over `src/`. Fix in this order.

### Should fix

- [ ] `lmcProvider.ts` — `provideLanguageModelChatInformation` throws when the
  server is down (`client.listModels()` rejects), leaving the picker in an
  error/retry state. Wrap in try/catch and return `[]` with a log line.
- [ ] `serverManager.ts` `stop()` — SIGKILL escalation is dead code:
  `process.killed` becomes true once SIGTERM is *delivered*, not when the
  process exits, so a SIGTERM-ignoring server is never force-killed. Track the
  process `'exit'` event (reuse `_processExited`) instead of `killed`.
- [ ] `serverManager.ts` constructor — throws on CUSTOM mode without a URL and
  on unknown `serverMode` values, which rejects `activate()` and bricks the
  whole extension. Fall back to LEMONADE + error notification instead.
- [ ] `serverManager.ts` `listenConfigsChange` — any change to the watched
  settings with new mode !== LEMOND calls `stop()`, so editing e.g.
  `lemonadePort` while a LEMONADE server runs kills it. Only stop when
  switching *away* from LEMOND (the comment says that; the code doesn't).

### Worth fixing

- Open question (see inline TODO in `lmcProvider.ts`): the `/v1/health` +
  `/v1/load` pair is still 2 round-trips on a cold model — consider just
  calling `loadModel()` and catching errors instead of the pre-check.

### Load-error UX (from `Bert-Phishing-ONNX` 500 `model_load_error`, 2026-09-24)

- Server returned `500 {"error":{"code":"model_load_error","message":"Failed
  to load model ... need model.onnx + tokenizer.json + config.json"}}` — an
  incomplete/corrupt HF cache dir, surfaced raw as `Failed to load model:
  Error: Failed to load model: 500 {...}` (double-wrapped prefix).
- Follow-ups: (1) translate `model_load_error` in `LemonadeClient.loadModel()`
  into a friendly message like the existing `slots_pinned_error` mapping
  ("model files incomplete — remove and re-download"); (2) decide whether the
  `Bert-Phishing-ONNX` (classification model) attempt points at a picker
  filtering gap for chat/agent model selection.

### Nits / polish

- [ ] `chatParticipant.ts` `getModel()` filter uses `l.toLowerCase() === 'chat'`;
  everywhere else uses `labels?.includes('chat')` — unify.
- [ ] `modelManager.ts` `capabilityFor` maps `image` and `vision` labels to the
  same tree group, while the provider treats only `vision` as `imageInput` —
  cosmetic inconsistency, fine if intentional.
- [ ] `serverTreeview.ts` `createOrGet` — `await refreshEvents.fire()` awaits
  `void`; drop the `await`.
- [ ] `logger.ts` — output channel is never disposed; add to subscriptions.
- [ ] `lmcProvider.ts` `extractText` silently drops `LanguageModelDataPart` on
  assistant messages; add a warn log if that ever happens.
- Remove backend text when selecting model for agent
