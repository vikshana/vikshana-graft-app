import { coerceScopedPanelFixUpdateArgs, normalizeUpdateDashboardArgs } from './updateDashboardArgs';

describe('normalizeUpdateDashboardArgs', () => {
    it('parses stringified operations array', () => {
        const ops = [{ op: 'replace', path: '$.panels[0].title', value: 'x' }];
        const args = normalizeUpdateDashboardArgs({
            uid: 'abc',
            operations: JSON.stringify(ops),
        });
        expect(Array.isArray(args.operations)).toBe(true);
        expect((args.operations as unknown[]).length).toBe(1);
    });

    it('coerces a stringified overwrite to a real boolean (MCP expects Go bool)', () => {
        // Regression: the LLM emitted overwrite:"true" → "cannot unmarshal string
        // into Go struct field UpdateDashboardParams.overwrite of type bool" mid-clone.
        expect(normalizeUpdateDashboardArgs({ uid: 'a', overwrite: 'true' }).overwrite).toBe(true);
        expect(normalizeUpdateDashboardArgs({ uid: 'a', overwrite: 'false' }).overwrite).toBe(false);
        expect(normalizeUpdateDashboardArgs({ uid: 'a', overwrite: 'TRUE' }).overwrite).toBe(true);
        expect(normalizeUpdateDashboardArgs({ uid: 'a', overwrite: true }).overwrite).toBe(true);
        expect(normalizeUpdateDashboardArgs({ uid: 'a', overwrite: false }).overwrite).toBe(false);
    });

    it('leaves overwrite absent when not provided', () => {
        expect('overwrite' in normalizeUpdateDashboardArgs({ uid: 'a' })).toBe(false);
    });

    it('defaults an unparseable overwrite string to true (avoid the unmarshal error)', () => {
        expect(normalizeUpdateDashboardArgs({ uid: 'a', overwrite: 'maybe' }).overwrite).toBe(true);
    });
});

describe('coerceScopedPanelFixUpdateArgs', () => {
    it('converts patch operations to full dashboard save', () => {
        const baseline = {
            uid: '6gawrgawrgragg',
            version: 10,
            panels: [{ id: 35, title: 'P35', targets: [{ refId: 'A', query: 'old' }] }],
        };
        const args = coerceScopedPanelFixUpdateArgs(
            {
                uid: '6gawrgawrgragg',
                operations: [
                    {
                        op: 'replace',
                        path: '$.panels[0].targets[0].query',
                        value: 'from() |> stddev()',
                    },
                ],
            },
            baseline,
            { dashboardUid: '6gawrgawrgragg', panelId: 35 }
        );
        expect(args.operations).toBeUndefined();
        expect(args.dashboard).toBeDefined();
        const panels = (args.dashboard as { panels: { id: number; targets: { query: string }[] }[] }).panels;
        expect(panels[0].targets[0].query).toBe('from() |> stddev()');
    });
});
