import {
    enforceScopedPanelDashboardMerge,
    isExplicitScopedPanelFixCommand,
    parseScopedPanelFixRequest,
    panelMatchesTarget,
} from './panelFixScope';
import { userWantsDashboardPanelFix } from './dashboardCloneProgress';

const userMsg =
    'on dash board "6gawrgawrgragg" in panel id#35 which is named "Module 5 Current — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ).", ' +
    'i still get these errors: Status: 400 parse error: unexpected identifier "v"';

describe('parseScopedPanelFixRequest', () => {
    it('parses dashboard uid and panel id from user message', () => {
        const s = parseScopedPanelFixRequest(userMsg);
        expect(s?.dashboardUid).toBe('6gawrgawrgragg');
        expect(s?.panelId).toBe(35);
        expect(s?.panelTitle).toContain('Module 5 Current');
    });

    it('parses unquoted dashboard uid with panel id#', () => {
        const s = parseScopedPanelFixRequest(
            'dashboard 6gawrgawrgragg panel id#35 Status 400 parse error'
        );
        expect(s?.dashboardUid).toBe('6gawrgawrgragg');
        expect(s?.panelId).toBe(35);
    });
});

describe('userWantsDashboardPanelFix', () => {
    it('matches Status 400 panel error reports', () => {
        expect(userWantsDashboardPanelFix(userMsg)).toBe(true);
    });

    it('matches scoped fix only panel commands with ix typo', () => {
        const typo =
            'ix only panel named "Module 5 Current — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ)" on dashboard uid 6gawrgawrgragg. Do not change other panels.';
        expect(isExplicitScopedPanelFixCommand(typo)).toBe(true);
        expect(userWantsDashboardPanelFix(typo)).toBe(true);
        expect(parseScopedPanelFixRequest(typo)?.dashboardUid).toBe('6gawrgawrgragg');
    });
});

describe('enforceScopedPanelDashboardMerge', () => {
    it('keeps other panels from baseline unchanged', () => {
        const baseline = {
            uid: '6gawrgawrgragg',
            version: 1,
            panels: [
                { id: 1, title: 'Other', targets: [{ expr: 'up' }] },
                { id: 35, title: 'Module 5', targets: [{ expr: 'broken(v' }] },
            ],
        };
        const proposed = {
            uid: '6gawrgawrgragg',
            version: 2,
            panels: [
                { id: 1, title: 'CHANGED', targets: [{ expr: 'bad' }] },
                { id: 35, title: 'Module 5', targets: [{ expr: 'sum(rate(x[5m]))' }] },
            ],
        };
        const target = { dashboardUid: '6gawrgawrgragg', panelId: 35 };
        const { merged, panelsReverted } = enforceScopedPanelDashboardMerge(
            baseline,
            proposed,
            target
        );
        const panels = merged.panels as Record<string, unknown>[];
        expect((panels[0] as { title?: string }).title).toBe('Other');
        expect((panels[1] as { targets?: { expr: string }[] }).targets?.[0]?.expr).toBe(
            'sum(rate(x[5m]))'
        );
        expect(panelsReverted).toBeGreaterThan(0);
    });
});

describe('panelMatchesTarget', () => {
    it('matches by panel id', () => {
        expect(panelMatchesTarget({ id: 35, title: 'X' }, { dashboardUid: 'a', panelId: 35 })).toBe(
            true
        );
    });
});
