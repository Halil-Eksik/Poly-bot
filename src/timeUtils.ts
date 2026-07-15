/** UTC datetime formatting — avoid naive/local timestamp bugs. */

/** Serialize datetime as ISO-8601 UTC with Z suffix (RFC 3339 style). */
export function formatUtcIsoZ(dt: Date): string {
  return dt.toISOString().replace('+00:00', 'Z');
}
