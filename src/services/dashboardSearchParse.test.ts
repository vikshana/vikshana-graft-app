import { parseSearchHitsFromMcpText } from './dashboardSearchParse';

describe('parseSearchHitsFromMcpText', () => {
    it('parses search_dashboards JSON from MCP', () => {
        const hits = parseSearchHitsFromMcpText(
            JSON.stringify({
                dashboards: [
                    { uid: 'abc123', title: '2505-200033 / Keysight', tags: ['2505-200033'] },
                    { uid: 'other', title: 'Plant Overview' },
                ],
            })
        );
        expect(hits).toHaveLength(2);
        expect(hits[0]).toEqual({
            uid: 'abc123',
            title: '2505-200033 / Keysight',
            tags: ['2505-200033'],
        });
    });

    it('falls back to markdown table when JSON is absent', () => {
        const hits = parseSearchHitsFromMcpText(
            '| # | Title | UID |\n| 1 | 2505-200033 / Keysight | `abc123` |'
        );
        expect(hits).toEqual([{ uid: 'abc123', title: '2505-200033 / Keysight' }]);
    });
});
