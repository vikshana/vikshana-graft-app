import { REGRESSION_CASES } from './regression/graftRegressionFixtures';
import {
    detectIntentAmbiguity,
    formatHistoryComparisonOutcomeMismatch,
    formatSoftIntentConfidenceNote,
    messageNeedsIntentRouteClarification,
    preferredIntentHandler,
    resolveIntentRouteAmbiguity,
    scoreIntentCandidates,
} from './programmaticIntentRouter';
import { classifyLlmIntent, llmIntentAllowsUpdateDashboard } from './llmIntentRouter';
import { messageHasProgrammaticHandler } from './programmaticChatIntents';

function casePrompt(id: string): string {
    const found = REGRESSION_CASES.find((c) => c.id === id);
    if (!found) {
        throw new Error(`missing regression case ${id}`);
    }
    return found.prompt;
}

describe('programmaticIntentRouter', () => {
    it('ranks alert create above panel steal on peer-band alert prompt', () => {
        const prompt = casePrompt('alert-create-not-panel-create');
        const scores = scoreIntentCandidates(prompt);
        expect(scores[0]?.id).toBe('grafana-alert-create');
        expect(scores.some((s) => s.id === 'panel-create')).toBe(false);
        expect(resolveIntentRouteAmbiguity(prompt, 216)).toBeNull();
        expect(preferredIntentHandler(prompt)).toBe('grafana-alert-create');
    });

    it('ranks peer-band above history comparison on peer-band pressure prompt', () => {
        const prompt = casePrompt('peer-band-pressure-create');
        const scores = scoreIntentCandidates(prompt);
        expect(scores[0]?.id).toBe('peer-band-create');
        expect(scores.some((s) => s.id === 'history-comparison')).toBe(false);
        expect(resolveIntentRouteAmbiguity(prompt, 216)).toBeNull();
    });

    it('ranks sensing-voltage history comparison with high confidence', () => {
        const prompt = casePrompt('rf-sensing-voltage-not-module5');
        const scores = scoreIntentCandidates(prompt);
        expect(scores[0]?.id).toBe('history-comparison');
        expect(scores[0]?.score).toBeGreaterThan(80);
        expect(resolveIntentRouteAmbiguity(prompt, 216)).toBeNull();
    });

    it('detects tied peer-band vs history-comparison and returns did-you-mean reply', () => {
        const ambiguous =
            'Create a machine learning panel for Module 2 Pressure on the dashboard with UID = grafte2ekeysht. ' +
            'Compare Module 2 Pressure against peer mean and Random Forest predictive analytics bands.';
        const scores = scoreIntentCandidates(ambiguous);
        expect(scores.some((s) => s.id === 'peer-band-create')).toBe(true);
        expect(scores.some((s) => s.id === 'history-comparison')).toBe(true);
        const ambiguity = detectIntentAmbiguity(scores);
        expect(ambiguity?.pair).toBe('peer-band-vs-history-comparison');
        const reply = resolveIntentRouteAmbiguity(ambiguous, 216);
        expect(reply).toMatch(/Need clarification — which action/i);
        expect(reply).toMatch(/Did you mean/i);
        expect(reply).toMatch(/Peer Band/i);
        expect(reply).toMatch(/History Comparison/i);
        expect(messageNeedsIntentRouteClarification(ambiguous)).toBe(true);
        expect(messageHasProgrammaticHandler(ambiguous)).toBe(true);
        expect(classifyLlmIntent(ambiguous)).toBe('read_only');
        expect(llmIntentAllowsUpdateDashboard(classifyLlmIntent(ambiguous))).toBe(false);
    });

    it('does not clarify clear peer-band or alert creates after soft-confidence tighten', () => {
        expect(resolveIntentRouteAmbiguity(casePrompt('peer-band-pressure-create'), 216)).toBeNull();
        expect(resolveIntentRouteAmbiguity(casePrompt('alert-create-not-panel-create'), 216)).toBeNull();
        expect(resolveIntentRouteAmbiguity(casePrompt('rf-sensing-voltage-not-module5'), 216)).toBeNull();
    });

    it('formats soft confidence footer for operator-visible soft wins', () => {
        expect(formatSoftIntentConfidenceNote(58)).toMatch(/Routing confidence: \*\*58\*\*/);
    });

    it('flags history comparison outcome mismatch for sensing voltage vs module panel', () => {
        const reply = formatHistoryComparisonOutcomeMismatch(
            casePrompt('rf-sensing-voltage-not-module5'),
            'Module 5 Current — History Comparison',
            216
        );
        expect(reply).toMatch(/did you mean Sensing Voltage/i);
        expect(reply).toMatch(/Module 5 Current/i);
    });

    it('flags peer-band wording saved as history comparison', () => {
        const reply = formatHistoryComparisonOutcomeMismatch(
            casePrompt('peer-band-pressure-create'),
            'Module 2 Pressure — History Comparison',
            216
        );
        expect(reply).toMatch(/did you mean Peer Band/i);
    });

    it('does not flag mismatch when saved panel matches parsed history comparison signal', () => {
        const prompt =
            'Create a Random Forest machine learning panel for Module 2 Current on the dashboard with UID = grafte2ekeysht.';
        expect(
            formatHistoryComparisonOutcomeMismatch(
                prompt,
                'Module 2 Current — History Comparison',
                216
            )
        ).toBeNull();
    });

    it('does not flag mismatch when operator negates sensing voltage but asks for module current', () => {
        const prompt =
            'Create a Random Forest machine learning panel for Module 2 Current, not sensing voltage, on the dashboard with UID = grafte2ekeysht.';
        expect(
            formatHistoryComparisonOutcomeMismatch(
                prompt,
                'Module 2 Current — History Comparison',
                216
            )
        ).toBeNull();
    });
});
