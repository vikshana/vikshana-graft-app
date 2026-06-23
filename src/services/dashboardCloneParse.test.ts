import {
    defaultDashboardTitleForMachine,
    extractSourceMachineId,
    extractTargetMachineId,
    findMachineIdsInText,
    inferDefaultDashboardTitle,
    isMachineId,
    parseCloneIntentMessage,
} from './dashboardCloneParse';

const keysightUser =
    'I have a machine from Keysight for 2505-200033. Create a dashboard for it that is a copy of 2103-176030, but with data for 2505-200033';

const namedUser =
    'Create a new dashboard named "2505-200033 / GlenTest" that is a visual copy of 2103-176030, with source field data from machine 2505-200033.';

describe('isMachineId', () => {
    it('accepts PowerTech machine ids and rejects ISO date prefixes', () => {
        expect(isMachineId('2406-176021')).toBe(true);
        expect(isMachineId('2026-05')).toBe(false);
        expect(findMachineIdsInText('timeFrom": "2026-06-15" machine 2406-176021')).toEqual(['2406-176021']);
    });
});

describe('extractTargetMachineId', () => {
    it('does not treat the word "from" in "machine from Keysight" as a machine id', () => {
        expect(extractTargetMachineId(keysightUser)).toBe('2505-200033');
    });

    it('reads explicit machine phrase', () => {
        expect(extractTargetMachineId(namedUser)).toBe('2505-200033');
    });
});

describe('extractSourceMachineId', () => {
    it('reads "copy of" template id', () => {
        expect(extractSourceMachineId(keysightUser)).toBe('2103-176030');
    });
});

describe('parseCloneIntentMessage', () => {
    it('parses Keysight-style clone wording', () => {
        const p = parseCloneIntentMessage(keysightUser);
        expect(p.valid).toBe(true);
        expect(p.sourceMachineId).toBe('2103-176030');
        expect(p.targetMachineId).toBe('2505-200033');
        expect(p.requestedTitle).toBe('2505-200033 / Keysight');
    });

    it('parses shorter Keysight prompt without redundant "data for" clause', () => {
        const employee =
            'I have a machine from Keysight for 2505-200033. Create a dashboard for it that is a copy of 2103-176030';
        const p = parseCloneIntentMessage(employee);
        expect(p.valid).toBe(true);
        expect(p.sourceMachineId).toBe('2103-176030');
        expect(p.targetMachineId).toBe('2505-200033');
        expect(p.requestedTitle).toBe('2505-200033 / Keysight');
    });

    // Regression (build 174): unnamed new dashboards were titled "<machine> / GlenTest"
    // (a developer placeholder). The default must be the neutral bare machine id.
    describe('default dashboard title', () => {
        it('uses the bare machine id, never the "GlenTest" placeholder', () => {
            expect(defaultDashboardTitleForMachine('2505-200033')).toBe('2505-200033');
            expect(defaultDashboardTitleForMachine('2505-200033')).not.toMatch(/GlenTest/i);
        });

        it('falls back to the machine id when no vendor/name is given', () => {
            const noVendor =
                'Create a dashboard for 2505-200033 that is a copy of 2103-176030, with data for 2505-200033';
            expect(inferDefaultDashboardTitle(noVendor, '2505-200033')).toBe('2505-200033');
        });

        it('still prefers an explicit vendor when present', () => {
            const withVendor = 'machine from Keysight for 2505-200033';
            expect(inferDefaultDashboardTitle(withVendor, '2505-200033')).toBe(
                '2505-200033 / Keysight'
            );
        });
    });
});
