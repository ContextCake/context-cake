import { isDeepStrictEqual } from 'node:util'

const THEME_VALUES = new Set(['system', 'light', 'dark'])
const DENSITY_VALUES = new Set(['comfortable', 'compact'])
const WRITABLE_FIELDS = new Set(['theme', 'density', 'updateCheck', 'anonymousMetrics', 'reducedTransparency'])

export function validatePreferencePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Preference patch must be an object.')
  for (const key of Object.keys(patch)) {
    if (!WRITABLE_FIELDS.has(key)) throw new Error('Preference patch contains an unsupported field.')
  }
  if (patch.theme !== undefined && !THEME_VALUES.has(patch.theme)) throw new Error('Invalid theme preference.')
  if (patch.density !== undefined && !DENSITY_VALUES.has(patch.density)) throw new Error('Invalid density preference.')
  if (patch.updateCheck !== undefined && typeof patch.updateCheck !== 'boolean') throw new Error('Invalid update preference.')
  if (patch.anonymousMetrics !== undefined && typeof patch.anonymousMetrics !== 'boolean') throw new Error('Invalid metrics preference.')
  // null is a real value here: "follow this Mac's Reduce Transparency setting",
  // which is the default and the only way back to it once overridden.
  if (patch.reducedTransparency !== undefined
    && patch.reducedTransparency !== null
    && typeof patch.reducedTransparency !== 'boolean') throw new Error('Invalid transparency preference.')
  return patch
}

export function changedPreferencePatch(current, candidate) {
  const patch = validatePreferencePatch(candidate)
  return Object.fromEntries(Object.entries(patch).filter(([key, value]) => !isDeepStrictEqual(current?.[key], value)))
}
