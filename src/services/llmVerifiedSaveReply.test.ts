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
            'remove panel X',
            158
        );
        expect(out).toContain('Save not verified');
        expect(out).toContain('Panel still present');
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
