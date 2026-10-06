// Structural equality for wire values (ACP option sets, command lists):
// cheaper than serialising either side, and it stops at the first difference.

/** Deep equality of two JSON values (key order ignored). */
export function sameJSON(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!sameJSON(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!sameJSON((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}
