import { findBestDashboardHitForLabel, parseSearchHitsFromMcpText } from './dashboardSearchParse';

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

describe('findBestDashboardHitForLabel', () => {
    const hits = [
        { uid: 'notes', title: 'Notes about Skywater-FL plant' },
        { uid: 'real', title: '2103-176030 / Skywater-FL' },
        { uid: 'copy', title: 'Copy of Skywater-FL extra' },
    ];

    it('picks the structured title match, not the first substring hit', () => {
        expect(findBestDashboardHitForLabel(hits, 'Skywater-FL')?.uid).toBe('real');
    });

    it('treats "Skywater FL" as the same title as Skywater-FL', () => {
        expect(findBestDashboardHitForLabel(hits, 'Skywater FL')?.uid).toBe('real');
    });

    it('picks a machine-id prefix title over a "Copy of" substring', () => {
        const machineHits = [
            { uid: 'copy', title: 'Copy of 2103-176030 / Skywater-MN' },
            { uid: 'real', title: '2103-176030 / Skywater-MN' },
        ];
        expect(findBestDashboardHitForLabel(machineHits, '2103-176030')?.uid).toBe('real');
    });

    it('does not take a lone substring hit such as Copy of …', () => {
        expect(
            findBestDashboardHitForLabel(
                [{ uid: 'copy', title: 'Copy of 2103-176030 / Skywater-MN extra' }],
                '2103-176030'
            )
        ).toBeUndefined();
    });

    it('returns undefined when two structured titles collide', () => {
        const ambiguous = [
            { uid: 'mn', title: '2103-176030 / Skywater-MN' },
            { uid: 'fl', title: '2103-176030 / Skywater-FL' },
        ];
        expect(findBestDashboardHitForLabel(ambiguous, '2103-176030')).toBeUndefined();
    });
});
