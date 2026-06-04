/** Default top-level panel slots per save (rows count as one slot). */
export const DEFAULT_PANEL_CHUNK_SIZE = 6;

/** Split top-level `dashboard.panels` entries for batched saves. */
export function splitPanelsIntoChunks(
    panels: unknown[],
    chunkSize = DEFAULT_PANEL_CHUNK_SIZE
): unknown[][] {
    if (!panels.length) {
        return [[]];
    }
    const chunks: unknown[][] = [];
    for (let i = 0; i < panels.length; i += chunkSize) {
        chunks.push(panels.slice(i, i + chunkSize));
    }
    return chunks;
}

export function totalTopLevelPanelSlots(panels: unknown[]): number {
    return panels.length;
}
