export function shouldSurfaceThreadLoadError(full?: {
  turns?: unknown[] | null;
}) {
  return !Array.isArray(full?.turns) || full.turns.length === 0;
}

/**
 * Claude writes its transcript after a turn finishes. Do not replace a usable
 * cached transcript with the temporary empty response returned mid-turn.
 */
export function shouldKeepLoadedThread(
  current?: { turns?: unknown[] | null },
  incoming?: { turns?: unknown[] | null },
) {
  return (
    Array.isArray(current?.turns) &&
    current.turns.length > 0 &&
    Array.isArray(incoming?.turns) &&
    incoming.turns.length === 0
  );
}
