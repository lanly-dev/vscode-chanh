/**
 * Pure reasoning-effort resolution for the native model picker.
 *
 * Kept free of VS Code imports so the rules can be unit-tested with plain
 * Node (see test/reasoningEffort.test.cjs). The LM provider feeds these
 * helpers the `chanh.reasoningEfforts` map, the model's server labels, and
 * the picker's per-model value; they decide which effort levels a model
 * offers and which effort a request sends. The semantics mirror the
 * official Lemonade extension, so the two providers behave alike against
 * the same server.
 */

/** Picker labels for the well-known effort levels. */
export const REASONING_LEVEL_LABELS: Record<string, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High'
}

/**
 * Whether the model's server labels mark it as a reasoning model. Label
 * matching elsewhere in this codebase is case-insensitive (see
 * `ModelManager.capabilityFor`), so this check is too.
 */
export function hasReasoningLabel(labels: readonly string[] | undefined): boolean {
  return (labels ?? []).some((l) => l.toLowerCase() === 'reasoning')
}

/**
 * Resolve the reasoning-effort levels a model offers in the picker, or
 * `undefined` when it offers none (no picker is shown).
 *
 * `effortsMap` maps a case-insensitive substring of the model id to its
 * levels; the first matching key wins and applies whether or not the
 * model is reasoning-labelled. The `'*'` entry is the fallback and only
 * applies to reasoning-labelled models. An empty list disables the
 * picker for the models it matches.
 */
export function resolveReasoningLevels(
  modelId: string,
  labels: readonly string[] | undefined,
  effortsMap: Readonly<Record<string, readonly string[]>>
): string[] | undefined {
  const id = modelId.toLowerCase()
  const key = Object.keys(effortsMap).find((k) => k !== '*' && id.includes(k.toLowerCase()))
  const levels = key !== undefined ? effortsMap[key] : hasReasoningLabel(labels) ? effortsMap['*'] : undefined
  return Array.isArray(levels) && levels.length > 0 ? [...levels] : undefined
}

/** The per-model configuration schema shape the chat host renders as a picker. */
export interface ReasoningConfigurationSchema {
  properties: {
    reasoningEffort: {
      type: 'string'
      title: string
      description: string
      enum: string[]
      enumItemLabels: string[]
      default: string
      group: string
    }
  }
}

/**
 * Build the configuration schema that renders a Reasoning picker for a
 * model in the chat model menu. The default is `medium` when offered,
 * else the first level.
 */
export function buildReasoningConfigurationSchema(levels: readonly string[]): ReasoningConfigurationSchema {
  return {
    properties: {
      reasoningEffort: {
        type: 'string',
        title: 'Reasoning',
        description: 'Reasoning effort sent to the Lemonade server as reasoning_effort.',
        enum: [...levels],
        enumItemLabels: levels.map((l) => REASONING_LEVEL_LABELS[l] ?? l),
        default: levels.includes('medium') ? 'medium' : levels[0],
        group: 'navigation'
      }
    }
  }
}

/**
 * Resolve the effort a request sends: the model menu's per-model picker
 * value wins over the global `chanh.reasoningEffort` setting. An empty or
 * non-string value at either level means "no override"; when neither
 * level resolves, the result is `undefined` and the request carries no
 * effort (the server default applies).
 */
export function resolveReasoningEffort(pickerValue: unknown, settingValue: string | undefined): string | undefined {
  if (typeof pickerValue === 'string' && pickerValue) return pickerValue
  return settingValue ? settingValue : undefined
}
