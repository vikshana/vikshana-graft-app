import {
    describesCapabilityLimitation,
    formatUnsupportedAdminReply,
    messageDescribesUnsupportedAdminRequest,
} from './adminCapabilityParse';
import { responseNeedsContinueAction } from './continueAction';
import { asksUserToChooseWithoutSave } from './appendToolReferences';
import { buildConfirmedIntent, type PendingDashboardTask } from './dashboardPendingTask';

describe('adminCapabilityParse', () => {
    it('detects create-organization requests', () => {
        const req = messageDescribesUnsupportedAdminRequest(
            'Create a new organization with the dashboard of an existing system.'
        );
        expect(req?.kind).toBe('create_organization');
        expect(req?.mentionsDashboard).toBe(true);
    });

    it('detects add-user requests', () => {
        const req = messageDescribesUnsupportedAdminRequest('Add a new user to access Grafana.');
        expect(req?.kind).toBe('manage_users');
    });

    it('detects org-scoped user access requests as user management', () => {
        const req = messageDescribesUnsupportedAdminRequest(
            'Add a new user that only has access to Skywater-MN Organization.'
        );
        expect(req?.kind).toBe('manage_users');
    });

    it('detects role/permission management', () => {
        const req = messageDescribesUnsupportedAdminRequest(
            'Change the permissions so editors can manage teams.'
        );
        expect(req?.kind).toBe('manage_access');
    });

    it('does NOT match dashboard create/edit prompts that worked', () => {
        expect(
            messageDescribesUnsupportedAdminRequest(
                'Update the *Summary Dashboard to include a section from Keysight. Keep it the same as the other sections on the *Summary currently.'
            )
        ).toBeNull();
        expect(
            messageDescribesUnsupportedAdminRequest(
                'Create a new dashboard for a new system that has the same data as another system that already has a dashboard.'
            )
        ).toBeNull();
        expect(
            messageDescribesUnsupportedAdminRequest(
                'Create a gauge panel, time series panel, table panel, and stat panel for dashboard with UID = cfo0wckufbdhce.'
            )
        ).toBeNull();
    });

    it('reply does not trigger the Continue auto-loop or pending-question machinery', () => {
        const cases: string[] = [
            'Add a new user to access Grafana.',
            'Create a new organization with the dashboard of an existing system.',
            'Add a new user that only has access to Skywater-MN Organization.',
        ];
        for (const prompt of cases) {
            const req = messageDescribesUnsupportedAdminRequest(prompt)!;
            const reply = formatUnsupportedAdminReply(req, prompt);
            expect(reply).toContain('Outside Graft');
            expect(responseNeedsContinueAction(reply)).toBe(false);
            expect(asksUserToChooseWithoutSave(reply, [])).toBe(false);
            expect(describesCapabilityLimitation(reply)).toBe(true);
        }
    });

    it('describesCapabilityLimitation matches the production "I cannot" replies', () => {
        expect(
            describesCapabilityLimitation(
                "I cannot create organizations — that requires admin access outside of Grafana's dashboard API."
            )
        ).toBe(true);
        expect(
            describesCapabilityLimitation(
                'I don’t have tools available to create users in Grafana. User management requires admin access.'
            )
        ).toBe(true);
        // Normal dashboard replies are NOT capability limitations.
        expect(describesCapabilityLimitation('Done — added the panel and saved the dashboard.')).toBe(false);
        expect(
            describesCapabilityLimitation('Would you like me to also reorder the panels?')
        ).toBe(false);
    });

    it('offers a dashboard clone alternative', () => {
        const req = messageDescribesUnsupportedAdminRequest(
            'Create a new organization with the dashboard of an existing system.'
        )!;
        const reply = formatUnsupportedAdminReply(req, 'Create a new organization with the dashboard of an existing system.');
        expect(reply.toLowerCase()).toContain('clone');
        expect(reply.toLowerCase()).toContain('what graft can do');
    });

    it('does NOT lead with a clone pitch on pure user/access requests (no dashboard mentioned)', () => {
        for (const prompt of [
            'Add a new user to access Grafana.',
            'Add a new user that only has access to Skywater-MN Organization.',
            'Change the permissions so editors can manage teams.',
        ]) {
            const req = messageDescribesUnsupportedAdminRequest(prompt)!;
            const reply = formatUnsupportedAdminReply(req, prompt);
            // The off-topic clone PITCH (bulleted "what graft can do" + clone example) is dropped...
            expect(reply.toLowerCase()).not.toContain('what graft can do');
            expect(reply.toLowerCase()).not.toContain('create a new dashboard for');
            // ...replaced by a concise on-point scope note (the word "clone" as a capability is fine).
            expect(reply.toLowerCase()).toContain('graft can take over the dashboards');
        }
    });

    it('raw "Continue" is never an admin request (clone-resume must NOT hit user-mgmt reply)', () => {
        // ChatInterface must classify the RAW user message, not the resolved one.
        expect(messageDescribesUnsupportedAdminRequest('Continue')).toBeNull();
        expect(messageDescribesUnsupportedAdminRequest('Continue.')).toBeNull();
    });

    it('documents why the synthesized continuation must NOT be classified', () => {
        // resolveEffectiveUserMessage rewrites "Continue" into this verbose intent.
        // It contains "User replied:" (user) + "update_dashboard"/"Create" (mutate verb),
        // so classifying IT (instead of the raw "Continue") wrongly yields manage_users —
        // the exact "cannot create users" mid-clone regression. Lock the trap in place.
        const cloneTask: PendingDashboardTask = {
            kind: 'clone',
            intentMessage:
                'Create dashboard "2505-200033 / Keysight" — copy of 2103-176030, with data for machine 2505-200033.',
            dashboardUid: '2103-176030',
            dashboardTitle: '2505-200033 / Keysight',
            updatedAt: Date.now(),
        };
        const synthesized = buildConfirmedIntent(cloneTask, 'Continue');
        expect(synthesized).toMatch(/User replied/);
        // The synthesized text DOES false-positive — which is precisely why we classify raw.
        expect(messageDescribesUnsupportedAdminRequest(synthesized)?.kind).toBe('manage_users');
    });

    it('still offers the clone block on a user request that DOES mention a dashboard', () => {
        const prompt = 'Add a new user and give them the dashboard for Skywater.';
        const req = messageDescribesUnsupportedAdminRequest(prompt)!;
        const reply = formatUnsupportedAdminReply(req, prompt);
        expect(reply.toLowerCase()).toContain('clone');
        expect(reply.toLowerCase()).toContain('what graft can do');
    });
});
