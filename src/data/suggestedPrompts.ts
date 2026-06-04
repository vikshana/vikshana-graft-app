import { BULK_PEER_BAND_FIX_EXAMPLE_PROMPT } from '../services/bulkPeerBandFixParse';
import { formatDashboardRenameExamplePrompt } from '../services/dashboardRenameParse';
import {
    formatPeerBandPanelCopyExamplePrompt,
    PEER_BAND_PANEL_COPY_EXAMPLE_PROMPT,
} from '../services/peerBandPanelCopyParse';
import {
    formatSinglePanelCopyExamplePrompt,
    SINGLE_PANEL_COPY_EXAMPLE_PROMPT,
} from '../services/singlePanelCopyParse';

export interface SuggestedPrompt {
    id: string;
    title: string;
    description: string;
    category: string;
    content: string;
}

/** Graft-ready prompts tied to programmatic handlers (rename, clone, peer-band fix/copy). */
export const SUGGESTED_PROMPTS: SuggestedPrompt[] = [
    {
        id: 'rename-machine-dashboard',
        title: 'Rename machine dashboard',
        description: 'Change the label after the machine id (e.g. Keysight → NewMachine).',
        category: 'Machine dashboards',
        content: formatDashboardRenameExamplePrompt(),
    },
    {
        id: 'rename-dashboard-by-uid',
        title: 'Rename dashboard by uid',
        description: 'Use when search by machine id does not find the dashboard.',
        category: 'Machine dashboards',
        content:
            'Rename dashboard uid="YOUR_DASHBOARD_UID" to be NewMachine instead of Keysight.',
    },
    {
        id: 'clone-machine-dashboard',
        title: 'Clone dashboard for a new machine',
        description: 'Copy layout from a template machine to a new machine id.',
        category: 'Machine dashboards',
        content:
            'I have a machine from Keysight for 2505-200033. Create a dashboard for it that is a copy of 2103-176030, with data for 2505-200033.',
    },
    {
        id: 'clone-named-dashboard',
        title: 'Clone with explicit target title',
        description: 'Create a named copy from a template machine dashboard.',
        category: 'Machine dashboards',
        content:
            'Create a new dashboard named "2505-200033 / GlenTest" that is a visual copy of 2103-176030, with source field data from machine 2505-200033.',
    },
    {
        id: 'single-panel-copy',
        title: 'Copy one panel to another machine dashboard',
        description: 'Duplicate a named panel (e.g. Pressure) and remap machine ids in queries.',
        category: 'Machine dashboards',
        content: SINGLE_PANEL_COPY_EXAMPLE_PROMPT,
    },
    {
        id: 'bulk-peer-band-fix',
        title: 'Fix all vs. Peer Band panels',
        description: 'Bulk Flux fix on one dashboard (replace uid as needed).',
        category: 'Peer band panels',
        content: BULK_PEER_BAND_FIX_EXAMPLE_PROMPT,
    },
    {
        id: 'peer-band-panel-copy',
        title: 'Copy peer-band panels to another dashboard',
        description: 'Cross-dashboard copy with machine remap and verification.',
        category: 'Peer band panels',
        content: formatPeerBandPanelCopyExamplePrompt('6gawrgawrgragg', ['bfo0v59rxtou8e']),
    },
    {
        id: 'peer-band-panel-copy-generic',
        title: 'Copy peer-band panels (template)',
        description: 'Generic wording — replace source/target uids and machine id.',
        category: 'Peer band panels',
        content: PEER_BAND_PANEL_COPY_EXAMPLE_PROMPT,
    },
    {
        id: 'scoped-panel-fix',
        title: 'Fix one panel on a dashboard',
        description: 'Scoped panel fix by dashboard uid and panel id.',
        category: 'Panel fixes',
        content:
            'On dashboard uid 6gawrgawrgragg, fix only panel id 424 — the vs. Peer Band query still uses the wrong machine id.',
    },
    {
        id: 'panel-fix-by-title',
        title: 'Fix panels by machine dashboard title',
        description: 'When you know the dashboard title but not the uid.',
        category: 'Panel fixes',
        content:
            'Fix panels on 2505-200033 / Keysight that still use 2103-176030.',
    },
    {
        id: 'verify-panel-fix',
        title: 'Verify a panel fix',
        description: 'Re-check a panel after Graft fixed it in this chat session.',
        category: 'Panel fixes',
        content: 'Verify the last panel fix on this dashboard.',
    },
];

export function getSuggestedPromptCategories(): string[] {
    return [...new Set(SUGGESTED_PROMPTS.map((p) => p.category))].sort((a, b) => a.localeCompare(b));
}

export function filterSuggestedPrompts(query: string): SuggestedPrompt[] {
    const q = query.trim().toLowerCase();
    if (!q) {
        return SUGGESTED_PROMPTS;
    }
    return SUGGESTED_PROMPTS.filter(
        (p) =>
            p.title.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.content.toLowerCase().includes(q) ||
            p.category.toLowerCase().includes(q)
    );
}

export function groupSuggestedPrompts(prompts: SuggestedPrompt[]): Record<string, SuggestedPrompt[]> {
    return prompts.reduce(
        (acc, prompt) => {
            if (!acc[prompt.category]) {
                acc[prompt.category] = [];
            }
            acc[prompt.category].push(prompt);
            return acc;
        },
        {} as Record<string, SuggestedPrompt[]>
    );
}
