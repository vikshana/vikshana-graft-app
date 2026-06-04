import { formatScopedPanelCrossReference } from './panelCrossReference';

describe('formatScopedPanelCrossReference', () => {
    const scope = { dashboardUid: '6gawrgawrgragg', panelId: 35 };
    const resolved = {
        panelId: 424,
        panelTitle: 'Module 5 Current — vs. Peer Band',
        panelArrayIndex: 12,
    };

    it('shows ids when user asked by panel name', () => {
        const msg =
            'Fix only panel named "Module 5 Current — vs. Peer Band" on dashboard uid 6gawrgawrgragg';
        const out = formatScopedPanelCrossReference(msg, scope, resolved);
        expect(out).toContain('Module 5 Current');
        expect(out).toContain('panel id **424**');
        expect(out).toContain('array index **12**');
    });

    it('shows title when user asked by panel id', () => {
        const msg =
            'Fix only panel id 35 on dashboard uid 6gawrgawrgragg. Do not change other panels';
        const out = formatScopedPanelCrossReference(msg, scope, resolved);
        expect(out).toContain('Module 5 Current');
        expect(out).toContain('panel id **424**');
        expect(out).toContain('You asked for panel id **35**');
    });

    it('shows title when user asked by array index', () => {
        const msg = 'Fix panel index 12 on dashboard uid 6gawrgawrgragg';
        const out = formatScopedPanelCrossReference(
            msg,
            { dashboardUid: 'x', panelArrayIndex: 12 },
            resolved
        );
        expect(out).toContain('Module 5 Current');
        expect(out).toContain('array index **12**');
    });
});
