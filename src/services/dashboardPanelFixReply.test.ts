import { applyOperatorFriendlyPanelFixReply, extractPanelsMentionedInFixReply } from './dashboardPanelFixReply';
import { userWantsDashboardPanelFix } from './dashboardCloneProgress';
import { clearPanelFixScope, setPanelFixBaseline, setPanelFixResolvedPanel, setPanelFixScope } from './panelFixSessionStorage';

const fixUser =
    'Fix panels on 2505-200033 / GlenTest that show errors or still use 2103-176030 instead of 2505-200033.';

const aggregateWindowUser =
    'dashboard named "2505-200033 / GlenTest" has a panel named "total current" that shows these errors Status: 500 aggregateWindow';

describe('userWantsDashboardPanelFix', () => {
    it('matches panel error reports without the word fix', () => {
        expect(userWantsDashboardPanelFix(aggregateWindowUser)).toBe(true);
        expect(userWantsDashboardPanelFix(fixUser)).toBe(true);
    });
});

describe('extractPanelsMentionedInFixReply', () => {
    it('pulls panel titles from model markdown', () => {
        expect(
            extractPanelsMentionedInFixReply(
                "I've fixed panel **Metal vs. Total Current** (panel index 7)."
            )
        ).toEqual(['Metal vs. Total Current']);
    });

    it('pulls panel from user request and Updated the **Title** pattern', () => {
        expect(
            extractPanelsMentionedInFixReply(
                'Updated the **Total Current** panel query.',
                'panel named "total current"'
            )
        ).toEqual(['total current', 'Total Current']);
    });
});

describe('applyOperatorFriendlyPanelFixReply', () => {
    it('returns short Done text without panel index tables', () => {
        const verbose =
            `Perfect! I've fixed panel **Metal vs. Total Current** (panel index 7).\n\n` +
            `**Done**\n\nThe dashboard has been saved.\n\n---\n**Panel index** — uid \`x\`\n| **0** |`;
        const out = applyOperatorFriendlyPanelFixReply(
            verbose,
            [{ name: 'update_dashboard', status: 'success', summary: 'Saved dashboard uid=abc, version=2' }],
            [fixUser],
            fixUser
        );
        expect(out).toContain('### Done (panel fix)');
        expect(out).toContain('Metal vs. Total Current');
        expect(out).toContain('2505-200033 / GlenTest');
        expect(out).not.toContain('Panel index');
        expect(out).not.toContain('arrayIndex');
        expect(out).not.toContain('Dashboard lookup reference');
    });

    it('puts Done status at the bottom with optional brief note above', () => {
        const keysightFix =
            'Fix panels on 2505-200033 / Keysight that show errors or still use 2103-176030 instead of 2505-200033.';
        const modelText =
            'The dashboard is complete and all panels reference `2505-200033`. No additional updates needed.\n\n**Done**';
        const out = applyOperatorFriendlyPanelFixReply(
            modelText,
            [{ name: 'get_dashboard_summary', status: 'success' }],
            [keysightFix],
            keysightFix
        );
        const doneAt = out.indexOf('### Done (panel fix)');
        expect(doneAt).toBeGreaterThan(-1);
        expect(out.slice(doneAt)).toContain('2505-200033 / Keysight');
        expect(out).not.toContain('Panel index');
    });

    it('shortens bulk machine-label panel fix (Keysight dashboard)', () => {
        const keysightFix =
            'Fix panels on 2505-200033 / Keysight that show errors or still use 2103-176030 instead of 2505-200033.';
        const modelText =
            '**Done.** All **34 panels** now reference **2505-200033** only. The transformation issue in the "Metal vs. Total Current" panel has been fixed.';
        const out = applyOperatorFriendlyPanelFixReply(
            modelText,
            [{ name: 'update_dashboard', status: 'success', summary: 'Saved dashboard uid=bfnxe8326lvcwb, version=2' }],
            [keysightFix],
            keysightFix
        );
        expect(out).toContain('### Done (panel fix)');
        expect(out).toContain('34 panels');
        expect(out).toContain('2103-176030');
        expect(out).toContain('Metal vs. Total Current');
        expect(out).not.toContain('Panel index');
    });

    it('shortens aggregateWindow / too many datapoints panel reports', () => {
        const verbose =
            `**Done!** Updated the **Total Current** panel query to include aggregateWindow(). ` +
            `Saved version 35.\n\n---\n**Panel index** — uid \`x\``;
        const out = applyOperatorFriendlyPanelFixReply(
            verbose,
            [{ name: 'update_dashboard', status: 'success', summary: 'Saved dashboard uid=dfnvxlfa1wflsb, version=35' }],
            [aggregateWindowUser],
            aggregateWindowUser
        );
        expect(out).toContain('### Done (panel fix)');
        expect(out).toContain('Total Current');
        expect(out).toContain('aggregateWindow');
        expect(out).toContain('version 35');
        expect(out).not.toContain('Panel index');
        // Concise panel-fix reply (note + status + refresh + token-saving hint),
        // matching the sibling concise-reply budget.
        expect(out.length).toBeLessThan(700);
    });

    const scopedFix =
        'Fix only panel id 35 on dashboard uid 6gawrgawrgragg. Do not change other panels: Flux query invalid (check group by / stdDev syntax).';

    beforeEach(() => {
        clearPanelFixScope();
        sessionStorage.clear();
    });

    it('scoped not-finished tells user to Continue without asking for uid again', () => {
        setPanelFixScope({ dashboardUid: '6gawrgawrgragg', panelId: 35 });
        setPanelFixResolvedPanel({
            panelId: 99,
            panelTitle: 'Module 5 Current — vs. Peer Band',
            panelArrayIndex: 12,
        });
        const out = applyOperatorFriendlyPanelFixReply(
            'I loaded the dashboard and inspected panel 35.',
            [{ name: 'get_dashboard_by_uid', status: 'success' }],
            [scopedFix],
            scopedFix
        );
        expect(out).toContain('### Not finished yet');
        expect(out).toContain('Module 5 Current');
        expect(out).toContain('panel id **99**');
        // The continue block now says "Use the **Continue** button below (or type `Continue`)".
        expect(out).toContain('**Continue** button');
        expect(out).not.toContain('Include dashboard uid');
        expect(out).not.toMatch(/\*\*\*\*/);
    });

    it('done refresh line does not double-bold dashboard title', () => {
        setPanelFixScope({ dashboardUid: '6gawrgawrgragg', panelId: 424, panelTitle: 'Module 5 peer band' });
        setPanelFixBaseline({ title: '2406-176021 / Exsolve', uid: '6gawrgawrgragg', version: 185 });
        const out = applyOperatorFriendlyPanelFixReply(
            'Saved.',
            [{ name: 'update_dashboard', status: 'success', summary: 'Saved version=185' }],
            [scopedFix],
            scopedFix
        );
        expect(out).toContain('Hard-refresh **2406-176021 / Exsolve** (uid `6gawrgawrgragg`)');
        expect(out).not.toMatch(/\*\*\*\*2406/);
    });

    it('scoped stuck after repeated no-save turns', () => {
        setPanelFixScope({ dashboardUid: '6gawrgawrgragg', panelId: 35 });
        const tools = [{ name: 'get_dashboard_by_uid', status: 'success' as const }];
        applyOperatorFriendlyPanelFixReply('lookup only', tools, [scopedFix], scopedFix, { finalize: true });
        const out = applyOperatorFriendlyPanelFixReply('still no save', tools, [scopedFix], scopedFix, {
            finalize: true,
        });
        expect(out).toContain('### Stuck — panel fix not saved');
        expect(out).toContain('Revert last changes');
    });
});
