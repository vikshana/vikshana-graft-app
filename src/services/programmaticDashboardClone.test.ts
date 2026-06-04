import { splitPanelsIntoChunks } from './dashboardCloneChunks';
import {
    countPanelsInDashboard,
    prepareClonedDashboard,
    replaceMachineLabelsInValue,
} from './programmaticDashboardClone';

describe('chunked clone sizing', () => {
    it('uses 6 chunks for 34 top-level panel slots', () => {
        const panels = Array.from({ length: 34 }, () => ({ type: 'timeseries' }));
        expect(splitPanelsIntoChunks(panels)).toHaveLength(6);
    });
});

describe('replaceMachineLabelsInValue', () => {
    it('replaces machine id in nested query strings', () => {
        const input = {
            panels: [
                {
                    targets: [{ expr: 'machine_metrics{machine="2103-176030"}' }],
                },
            ],
        };
        const out = replaceMachineLabelsInValue(input, '2103-176030', '2505-200033') as typeof input;
        expect(out.panels[0].targets[0].expr).toContain('2505-200033');
        expect(out.panels[0].targets[0].expr).not.toContain('2103-176030');
    });
});

describe('prepareClonedDashboard', () => {
    it('sets title and clears uid for new dashboards', () => {
        const source = { uid: 'abc', id: 1, title: '2103-176030 / Skywater-MN', panels: [] };
        const out = prepareClonedDashboard(source, {
            targetTitle: '2505-200033 / GlenTest',
            sourceMachine: '2103-176030',
            targetMachine: '2505-200033',
        });
        expect(out.title).toBe('2505-200033 / GlenTest');
        expect(out.uid).toBeUndefined();
        expect(out.id).toBeUndefined();
    });

    it('keeps uid and id when updating existing target', () => {
        const source = { uid: 'src', title: 'Old', panels: [] };
        const out = prepareClonedDashboard(source, {
            targetTitle: '2505-200033 / GlenTest',
            sourceMachine: '2103-176030',
            targetMachine: '2505-200033',
            targetUid: 'tgt',
            targetNumericId: 99,
        });
        expect(out.uid).toBe('tgt');
        expect(out.id).toBe(99);
    });
});

describe('countPanelsInDashboard', () => {
    it('counts non-row panels and nested row panels', () => {
        const n = countPanelsInDashboard({
            panels: [
                { type: 'timeseries' },
                { type: 'row', panels: [{ type: 'stat' }, { type: 'gauge' }] },
            ],
        });
        expect(n).toBe(3);
    });
});
