import { DEFAULT_PANEL_CHUNK_SIZE, splitPanelsIntoChunks } from './dashboardCloneChunks';

describe('splitPanelsIntoChunks', () => {
    it('returns one empty chunk for no panels', () => {
        expect(splitPanelsIntoChunks([])).toEqual([[]]);
    });

    it('splits into chunks of DEFAULT_PANEL_CHUNK_SIZE', () => {
        const panels = Array.from({ length: 14 }, (_, i) => ({ id: i }));
        const chunks = splitPanelsIntoChunks(panels);
        expect(chunks).toHaveLength(3);
        expect(chunks[0]).toHaveLength(DEFAULT_PANEL_CHUNK_SIZE);
        expect(chunks[1]).toHaveLength(DEFAULT_PANEL_CHUNK_SIZE);
        expect(chunks[2]).toHaveLength(2);
    });
});
