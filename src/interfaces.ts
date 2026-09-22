/**
 * In-memory + tree-UI only (never persisted to settings). Values are UPPERCASE
 * because they feed TreeItem contextValues: `CHANH_SERVER_${status}`
 * must match the `viewItem == CHANH_SERVER_*` when-clauses in package.json.
 */
export enum ServerStatus {
  RUNNING = 'RUNNING',
  STARTING = 'STARTING',
  STOPPED = 'STOPPED',
  ERROR = 'ERROR',
}

/**
 * The user-selected Lemonade server to target for chat and model operations.
 * Persisted to `chanh.serverMode` in settings.json; values are UPPERCASE
 * to match the package.json enum and the enum keys.
 */
export enum ServerMode {
  LEMONADE = 'LEMONADE',
  LEMOND = 'LEMOND',
  CUSTOM = 'CUSTOM',
}

/** A single choice in a chat completion response. */
export interface ChatChoice {
  index: number
  message?: ChatMessage
  delta?: Partial<ChatMessage> & {
    reasoning_content?: string | null
  }
  finish_reason?: string | null
}
/** Request body for `/v1/chat/completions`. */
export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  top_p?: number
  tools?: ToolDefinition[]
  tool_choice?: 'auto' | 'none' | { type: 'function', function: { name: string } }
}

/** Non-streaming chat completion response. */
export interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: ChatChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/** A content part of a multimodal chat message (OpenAI format). */
export interface ChatContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

/** OpenAI chat message. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ChatContentPart[]
  name?: string
  tool_call_id?: string
  tool_calls?: OpenAIMessageToolCall[]
}

/** A tool call as returned by the model (OpenAI tool_calls entry). */
export interface OpenAIMessageToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/** A parsed tool call with JSON-deserialized arguments. */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** A tool definition sent to the model (OpenAI tools entry). */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: object
  }
}

/** Live progress of an in-progress model download (surface in the tree view). */
export interface DownloadProgress {
  /** Model being downloaded. */
  modelId: string
  /** Percent complete (0-100), or -1 when the server doesn't report a ratio. */
  pct: number
  /** Bytes downloaded so far, when reported by the server. */
  written?: number
  /** Total bytes to download, when reported by the server. */
  total?: number
  /** Human-friendly progress text from the server (fallback when pct is unknown). */
  message: string
}

/** Information about a GitHub release. */
export interface GitHubRelease {
  tag_name: string
  name: string
  assets: ReleaseAsset[]
}

/** Health response from `/v1/health`. */
export interface HealthResponse {
  model_loaded: string | null
  all_models_loaded: Array<{
    model_name: string
    is_busy: boolean
    is_streaming: boolean
    backend_url?: string
  }>
  max_loaded_models?: number
  pinned_models?: PinnedModels
}

/** A model entry returned by the Lemonade Server `/v1/models` endpoint. */
export interface LemonadeModel {
  id: string
  object?: string
  created?: number
  owned_by?: string
  /** Category labels of the model (e.g. ["transcription"], ["image"], ["chat"]). */
  labels?: string[]
  /** Human-friendly primary label derived from `labels`. */
  label?: string
  /** Machine-readable model type from the server. */
  type?: string
  /** Recipe (backend) used to load/run the model, e.g. "llamacpp". */
  recipe?: string
  /** Runtime context limit reported by the server, in tokens. */
  context_length?: number
  /** Maximum context window the model/backends support, in tokens. */
  max_context_window?: number
  /** Hugging Face/ModelScope checkpoint the model resolves to. */
  checkpoint?: string
  /** Registry the model was downloaded from (e.g. "huggingface"). */
  registry_source?: string
  /** Currently saved per-model recipe options on the server (may be empty). */
  recipe_options?: Record<string, unknown>
  /** Suggested models come from the server's built-in catalog: they are pullable but may not be downloaded yet. */
  suggested?: boolean
  /** Whether the model is already downloaded on disk (present when using `?show_all=true`). */
  downloaded?: boolean
  /** Whether an update is available for the model upstream. */
  update_available?: boolean
    /** Approximate model size in GB, when reported by the server. */
  size?: number
}

export interface ModelTreeItem {
  id: string
  label: string
  loaded: boolean
  description?: string
}

/** Number of pinned models per category, as reported by `/v1/health`. */
export interface PinnedModels {
  classification?: number
  embedding?: number
  image?: number
  llm?: number
  reranking?: number
  transcription?: number
  tts?: number
}

/** A single progress event emitted by the streaming `/v1/pull` endpoint. */
export interface DownloadProgressEvent {
  status?: string
  response?: string
  progress?: number
  bytes_written?: number
  bytes_total?: number
}

/** Information about a Lemonade Server release asset. */
export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

/** A server instance shown in the tree view. */
export interface ServerInstance {
  id: string
  name: string
  url: string
  status: ServerStatus
  version?: string
  health?: HealthResponse
  models?: LemonadeModel[]
  downloadableModels?: LemonadeModel[]
  error?: string
  maxLoadedModels?: number
}
