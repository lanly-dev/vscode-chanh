# DEV — Lemonade downloads, deletes, and partial-download tracking

## Download vs remove APIs

- Download/start: `POST /v1/pull`
  - Body: `{ model_name, stream: true }`
  - Used by: `LemonadeClient.pullModelStream()`
  - Consumed in: `ModelManager.downloadModel()`
  - Behavior: one long-lived streaming response; server pushes progress lines.
  - Cancellation is client-side: `AbortController` destroys the HTTP request.

- Delete/remove: `POST /v1/delete`
  - Body: `{ model_name }`
  - Used by: `LemonadeClient.deleteModel()`
  - Consumed in: `ModelManager.deleteModel()`
  - Same endpoint is used for both complete models and partial downloads.
  - There is no partial-specific delete endpoint in the extension.

- Related one-shot endpoints:
  - `POST /v1/load`
  - `POST /v1/unload`
  - `POST /v1/models/{id}/options`
  - `GET /v1/health`
  - `GET /v1/models?show_all=true`

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
