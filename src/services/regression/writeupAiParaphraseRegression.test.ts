/**
 * Separate quality-loop test: AI-written paraphrases of the write-up PDF,
 * a new random subset every run (GRAFT_PARAPHRASE_SEED).
 */
import { userWantsDashboardClone } from '../dashboardCloneProgress';
import { messageMentionsOwnHistoryPanel } from '../ownHistoryPanelParse';
import { messageMentionsAddPeerRfPanel } from '../peerRfPanelAddParse';
import { messageMentionsGrafanaAlertCreate } from '../grafanaAlertParse';
import { messageHasProgrammaticHandler } from '../programmaticChatIntents';
import { formatClarificationIfNeeded } from '../requestClarity';
import { classifyLlmIntent } from '../llmIntentRouter';
import {
    PARAPHRASE_COUNT,
    PARAPHRASE_SEED,
    makeParaphraseRng,
} from './operatorParaphraseGenerator';
import {
    WRITEUP_PARAPHRASE_BANK,
    sampleParaphrases,
    type WriteupParaphraseKind,
} from './writeupParaphraseBank';

const rng = makeParaphraseRng();

function sample(kind: WriteupParaphraseKind): string[] {
    return sampleParaphrases(rng, WRITEUP_PARAPHRASE_BANK[kind], PARAPHRASE_COUNT);
}

function handleOrAsk(prompt: string): boolean {
    return messageHasProgrammaticHandler(prompt) || Boolean(formatClarificationIfNeeded(prompt));
}

describe(`AI write-up paraphrases (seed ${PARAPHRASE_SEED})`, () => {
    it.each(sample('clone'))('clone: %s', (prompt) => {
        expect(handleOrAsk(prompt)).toBe(true);
        expect(userWantsDashboardClone(prompt) || Boolean(formatClarificationIfNeeded(prompt))).toBe(
            true
        );
    });

    it.each(sample('renameDashboard'))('rename dashboard: %s', (prompt) => {
        expect(handleOrAsk(prompt)).toBe(true);
    });

    it.each(sample('addPanel'))('add panel: %s', (prompt) => {
        expect(handleOrAsk(prompt)).toBe(true);
    });

    it.each(sample('copyPanel'))('copy panel: %s', (prompt) => {
        expect(handleOrAsk(prompt)).toBe(true);
    });

    it.each(sample('renamePanel'))('rename panel: %s', (prompt) => {
        expect(handleOrAsk(prompt)).toBe(true);
    });

    it.each(sample('ownHistory'))('own-history: %s', (prompt) => {
        expect(handleOrAsk(prompt)).toBe(true);
        expect(messageMentionsOwnHistoryPanel(prompt) || Boolean(formatClarificationIfNeeded(prompt))).toBe(
            true
        );
    });

    it.each(sample('peerCompare'))('peer compare: %s', (prompt) => {
        expect(handleOrAsk(prompt)).toBe(true);
    });

    it.each(sample('randomForest'))('random forest: %s', (prompt) => {
        expect(handleOrAsk(prompt)).toBe(true);
        expect(messageMentionsAddPeerRfPanel(prompt) || Boolean(formatClarificationIfNeeded(prompt))).toBe(
            true
        );
    });

    it.each(sample('alert'))('alert: %s', (prompt) => {
        expect(messageMentionsGrafanaAlertCreate(prompt)).toBe(true);
        expect(handleOrAsk(prompt)).toBe(true);
    });

    it.each(sample('readOnly'))('read-only is not an unmatched job: %s', (prompt) => {
        expect(formatClarificationIfNeeded(prompt)).toBeNull();
        expect(classifyLlmIntent(prompt)).not.toBe('conversational');
    });

    it.each(sample('unmatched'))('unmatched asks: %s', (prompt) => {
        expect(formatClarificationIfNeeded(prompt)).toMatch(/Need clarification/i);
    });
});
