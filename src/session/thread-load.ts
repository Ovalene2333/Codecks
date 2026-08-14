export function shouldSurfaceThreadLoadError(full?: {
  turns?: unknown[] | null;
}) {
  return !Array.isArray(full?.turns) || full.turns.length === 0;
}
