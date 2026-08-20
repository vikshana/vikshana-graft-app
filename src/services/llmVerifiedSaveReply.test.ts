import { applyLlmVerifiedSaveReply } from './llmVerifiedSaveReply';
import type { ToolExecution } from '../types/llm.types';

describe('applyLlmVerifiedSaveReply', () => {
    const tools: ToolExecution[] = [{ name: 'update_dashboard', status: 'success' }];

    it('formats verified LLM save', () => {
        const out = applyLlmVerifiedSaveReply(
            'Done.',
            { verified: true, skipped: false, version: 80, detail: 'ok' },
            tools,
            [],
            'update dashboard panels',
            158
        );
        expect(out).toContain('Dashboard saved (LLM verified');
        expect(out).toContain('version **80**');
    });

    it('formats unverified save', () => {
        const out = applyLlmVerifiedSaveReply(
            'Done.',
            { verified: false, skipped: false, detail: 'Panel still present.' },
            tools,
            [],
            'reorganize dashboard panels on uid abc123',
            158
        );
        expect(out).toContain('Save not verified');
        expect(out).toContain('Panel still present');
    });

    it('shows clarification when vague graph save is unverified', () => {
        const prompt =
            'Create graphs that would be useful for the Keysight machine on the dashboard with UID = cfo0wckufbdhce.';
        const out = applyLlmVerifiedSaveReply(
            '### Keysight Machine Monitoring Graphs Created\n\n8 panels added.',
            {
                verified: false,
                skipped: false,
                detail: 'No new panels were added after a vague graph/chart create request.',
            },
            tools,
            [prompt],
            prompt,
            166
        );
        expect(out).toContain('Need clarification');
        expect(out).toContain('machine_metrics');
        expect(out).not.toContain('8 panels added');
    });

    it('returns routing mismatch reply when LLM saved wrong history comparison panel', () => {
        const prompt =
            'Create a Random Forest machine learning panel for sensing voltage on the dashboard with UID = afq7tc6hl1m9sb.';
        const mismatch =
            '### Routing mismatch — did you mean Sensing Voltage? (Graft build 216)\n\nYou asked for **sensing voltage**, but the saved panel is **Module 5 Current — History Comparison**.';
        const out = applyLlmVerifiedSaveReply(
            '### Done\n\nPanel saved.',
            {
                verified: false,
                skipped: false,
                routingMismatchReply: mismatch,
                detail: 'Expected panel **Sensing Voltage — History Comparison** but observed **Module 5 Current — History Comparison**.',
            },
            tools,
            [prompt],
            prompt,
            216
        );
        expect(out).toBe(mismatch);
        expect(out).not.toContain('Save not verified');
    });

    it('skips rename prompts', () => {
        const msg = 'Rename the "A" panel to "B" on dashboard uid abc';
        const out = applyLlmVerifiedSaveReply(
            'Saved.',
            { verified: true, skipped: false },
            tools,
            [msg],
            msg,
            158
        );
        expect(out).toBe('Saved.');
    });
});
