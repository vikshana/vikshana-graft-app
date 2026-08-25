/**
 * Seeded random paraphrases of common operator jobs.
 * Set GRAFT_PARAPHRASE_SEED to replay a failing run.
 * Set GRAFT_PARAPHRASE_COUNT to change how many random prompts each intent emits.
 */
import { WRITEUP_PARAPHRASE_BANK, sampleParaphrases, type WriteupParaphraseKind } from './writeupParaphraseBank';

function mulberry32(seed: number): () => number {
    return () => {
        let t = (seed += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick<T>(rng: () => number, items: T[]): T {
    return items[Math.floor(rng() * items.length)];
}

function joinParts(parts: string[]): string {
    return parts
        .filter((p) => p.length > 0)
        .join(' ')
        .replace(/\s+/g, ' ')
        .replace(/\s+\./g, '.')
        .trim();
}

export const PARAPHRASE_SEED = Number(process.env.GRAFT_PARAPHRASE_SEED) || Date.now();
export const PARAPHRASE_COUNT = Math.max(4, Number(process.env.GRAFT_PARAPHRASE_COUNT) || 8);

const LEADINS = ['', 'Please', 'Can you', 'I need you to'];
const UID = 'idHkqdqnk';
const UID_PHRASES = [
    `on the dashboard with UID = ${UID}`,
    `on dashboard UID = ${UID}`,
    `on uid=${UID}`,
    `on dashboard ${UID}`,
    `for the dashboard with UID = ${UID}`,
];

export function makeParaphraseRng(seed = PARAPHRASE_SEED): () => number {
    return mulberry32(seed >>> 0);
}

export function randomClonePrompts(rng: () => number, count = PARAPHRASE_COUNT): string[] {
    const verbs = [
        'copy',
        'clone',
        'duplicate',
        'create a copy of',
        'make a copy of',
        'create a dashboard that is a copy of',
    ];
    const titles = ['Skywater-FL', 'Skywater FL'];
    const targets = [
        'for 2505-200033',
        'with data for 2505-200033',
        'for machine 2505-200033',
        'for our 2505-200033 unit',
    ];
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        out.push(
            joinParts([pick(rng, LEADINS), pick(rng, verbs), pick(rng, titles), pick(rng, targets)]) + '.'
        );
    }
    return out;
}

export function randomDashboardRenamePrompts(rng: () => number, count = PARAPHRASE_COUNT): string[] {
    const templates = [
        () =>
            joinParts([
                pick(rng, LEADINS),
                'rename the dashboard with UID = 6sFerv44k to be NewSkywater-FL',
            ]),
        () => joinParts([pick(rng, LEADINS), 'rename dashboard uid=6sFerv44k to NewSkywater-FL']),
        () =>
            joinParts([
                pick(rng, LEADINS),
                'rename the dashboard for the 6sFerv44k machine to be NewSkywater-FL instead of the current name',
            ]),
        () => joinParts([pick(rng, LEADINS), 'rename 6sFerv44k dashboard to NewSkywater-FL']),
        () => joinParts(['For uid 6sFerv44k,', pick(rng, ['rename', 'please rename']), 'the dashboard to NewSkywater-FL']),
    ];
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        out.push(pick(rng, templates)() + '.');
    }
    return out;
}

export function randomPanelRenamePrompts(rng: () => number, count = PARAPHRASE_COUNT): string[] {
    const templates = [
        () =>
            joinParts([
                pick(rng, LEADINS),
                `rename the "Current" panel ${pick(rng, UID_PHRASES)} to be "NewCurrent"`,
            ]),
        () =>
            joinParts([
                pick(rng, LEADINS),
                `rename panel "Current" to "NewCurrent" ${pick(rng, UID_PHRASES)}`,
            ]),
        () =>
            joinParts([
                pick(rng, LEADINS),
                `rename the Current panel to NewCurrent (dashboard uid ${UID})`,
            ]),
    ];
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        out.push(pick(rng, templates)() + '.');
    }
    return out;
}

export function randomOwnHistoryPrompts(rng: () => number, count = PARAPHRASE_COUNT): string[] {
    const verbs = ['Create', 'Add', 'Make'];
    const bodies = [
        'an own history ±2σ panel for Sensing Voltage',
        'a machine learning panel that compares Sensing Voltage against its own history',
        'a vs own history panel for Sensing Voltage',
        'a historical mean ± 2 standard deviation panel for Sensing Voltage',
        'an own history ±2σ panel for Average Sensing Voltage',
        'a vs own history panel for plant temperature',
        'a machine learning panel that compares Temperature against its own history',
    ];
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        out.push(joinParts([pick(rng, LEADINS), pick(rng, verbs), pick(rng, bodies), pick(rng, UID_PHRASES)]) + '.');
    }
    return out;
}

export function randomPeerRfPrompts(rng: () => number, count = PARAPHRASE_COUNT): string[] {
    const verbs = ['Create', 'Add', 'Please add', 'I need'];
    const bodies = [
        'a RandomForest vs Peers (Influx) machine learning panel for Module 3 Current',
        'RandomForest vs Peers for Module 3 Current',
        'a peer RF Influx panel for Module 3 Current',
        'RF vs Peers (Influx) for module 3 current',
        'a Random Forest vs peers panel for Module 3 Current',
    ];
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        out.push(joinParts([pick(rng, LEADINS), pick(rng, verbs), pick(rng, bodies), pick(rng, UID_PHRASES)]) + '.');
    }
    return out;
}

export function randomTemperaturePrompts(rng: () => number, count = PARAPHRASE_COUNT): string[] {
    const verbs = ['Create', 'Add', 'Please add'];
    const bodies = [
        'a RandomForest vs Peers machine learning panel for the Temperature parameter',
        'a history comparison for Temperature',
        'a predictive analytics panel for Temperature',
        'a plant temperature ML panel',
        'a Temperature Random Forest panel',
    ];
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        out.push(joinParts([pick(rng, LEADINS), pick(rng, verbs), pick(rng, bodies), pick(rng, UID_PHRASES)]) + '.');
    }
    return out;
}

/** AI-written write-up paraphrases (mutating jobs only). Different subset each seed. */
export function randomWriteupPrompts(rng: () => number, count = PARAPHRASE_COUNT): string[] {
    const mutating: WriteupParaphraseKind[] = [
        'clone',
        'renameDashboard',
        'addPanel',
        'copyPanel',
        'renamePanel',
        'ownHistory',
        'peerCompare',
        'randomForest',
        'alert',
    ];
    const pool = mutating.flatMap((kind) => WRITEUP_PARAPHRASE_BANK[kind]);
    return sampleParaphrases(rng, pool, count);
}

export function randomUnmatchedPrompts(rng: () => number, count = PARAPHRASE_COUNT): string[] {
    return sampleParaphrases(rng, WRITEUP_PARAPHRASE_BANK.unmatched, count);
}
