import { formatClarificationIfNeeded, hasDashboardIdentityForPanelFix } from './requestClarity';
import { userWantsDashboardPanelFix } from './dashboardCloneProgress';

const scopedFix =
    'on dashboard "6gawrgawrgragg" panel id#35 named "Module 5 Current" — still get Status: 400 parse error unexpected identifier "v"';

describe('hasDashboardIdentityForPanelFix', () => {
    it('accepts dashboard uid and panel id', () => {
        expect(hasDashboardIdentityForPanelFix(scopedFix)).toBe(true);
    });
});

describe('formatClarificationIfNeeded', () => {
    it('does not ask clarification when uid and panel id are present', () => {
        expect(userWantsDashboardPanelFix(scopedFix)).toBe(true);
        expect(formatClarificationIfNeeded(scopedFix)).toBeNull();
    });

    it('suggests plain-English bulk prompt when vs. Peer Band fix is vague', () => {
        const vague = 'Fix the other vs. Peer Band panels the same as Module 5';
        const clarification = formatClarificationIfNeeded(vague);
        expect(clarification).toContain('fix all panels whose title contains');
        expect(clarification).toContain('vs. Peer Band');
    });

    it('asks instead of guessing on unmatched operator English', () => {
        const vague = 'Add the usual ML stuff to the Keysight dashboard.';
        const clarification = formatClarificationIfNeeded(vague);
        expect(clarification).toContain('Need clarification');
        expect(clarification).toMatch(/did not match|known action/i);
    });

    it('does not treat Copy Skywater-FL for a machine as unmatched English', () => {
        expect(formatClarificationIfNeeded('Copy Skywater-FL for 2505-200033.')).toBeNull();
    });

    it('does not block Grafana how-to copy questions as unmatched jobs', () => {
        expect(formatClarificationIfNeeded('How do I copy a dashboard in Grafana?')).toBeNull();
        expect(formatClarificationIfNeeded('What is the process to copy dashboards?')).toBeNull();
    });

    it('does not block read-only questions that mention ML or analytics', () => {
        expect(
            formatClarificationIfNeeded(
                'What does ML temperature mean on the dashboard with UID = idHkqdqnk?'
            )
        ).toBeNull();
        expect(
            formatClarificationIfNeeded(
                'Explain the History Comparison panel on uid=idHkqdqnk.'
            )
        ).toBeNull();
        expect(formatClarificationIfNeeded('List the peer band panels on this dashboard.')).toBeNull();
        expect(
            formatClarificationIfNeeded(
                'What other panels might we still need on uid=idHkqdqnk?'
            )
        ).toBeNull();
    });

    it('asks when a vendor name is used as a Grafana uid', () => {
        expect(formatClarificationIfNeeded('Rename dashboard uid=Keysight to NewSkywater-FL.')).toMatch(
            /Need clarification/i
        );
        expect(
            formatClarificationIfNeeded('Put a new gauge panel called Pressure Monitoring on uid=Keysight.')
        ).toMatch(/Need clarification/i);
        expect(
            formatClarificationIfNeeded('Rename dashboard uid=Keysight to NewSkywater-FL.')
        ).not.toMatch(/### Done/);
    });

    it('asks when peer compare has no create verb', () => {
        expect(
            formatClarificationIfNeeded(
                'Module 2 Current against its peer band on dashboard uid=idHkqdqnk.'
            )
        ).toMatch(/Need clarification/i);
        expect(
            formatClarificationIfNeeded(
                'Module 1 Current compared with the mean of the other modules on uid=idHkqdqnk.'
            )
        ).toMatch(/Need clarification/i);
    });
});
