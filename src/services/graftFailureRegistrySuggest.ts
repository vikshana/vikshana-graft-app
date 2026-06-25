import type { GraftFailureEntry } from './graftOperatorFailureLog';
import { PROGRAMMATIC_FALLBACK_REGISTRY, type ProgrammaticFallbackKind } from './programmaticLlmFallback';
import { userWantsDashboardRebuild } from './dashboardRebuildParse';
import { userWantsDashboardMetricPanels } from './dashboardMetricPanelsParse';
import { userWantsDashboardTitleRow } from './dashboardTitleRowParse';
import { userWantsModulePanelReorder } from './modulePanelReorderParse';
import { userWantsBulkPeerBandFix } from './bulkPeerBandFixParse';
import { messageMentionsInfluxPanelRepair } from './influxPanelRepairParse';
import { userWantsDashboardClone } from './dashboardCloneProgress';
import { userWantsDashboardImproveApply } from './dashboardReviewParse';

export type RegistryWireStatus = 'wired_fast_path' | 'wired_fallback' | 'missing';

export interface SuggestedRegistryRow {
    kind: string;
    triggers: string;
    handler: string;
    implementIn: string[];
    status: RegistryWireStatus;
    matchedBecause: string;
}

const FAST_PATH_INTENTS = new Set([
    'dashboard_rebuild',
    'dashboard-metric-panels',
    'dashboard_metric_panels',
    'dashboard-title-row',
    'dashboard-title_row',
    'module_panel_reorder',
    'single_panel_copy',
    'bulk_peer_band_fix',
    'influx_panel_repair',
    'panel_json_duplicate',
]);

function registryRow(kind: ProgrammaticFallbackKind) {
    return PROGRAMMATIC_FALLBACK_REGISTRY.find((r) => r.kind === kind);
}

function wireStatus(kind: string, intent: string): RegistryWireStatus {
    const inRegistry = PROGRAMMATIC_FALLBACK_REGISTRY.some((r) => r.kind === kind);
    if (!inRegistry) {
        return 'missing';
    }
    if (FAST_PATH_INTENTS.has(intent) || intent === kind || intent.replace(/-/g, '_') === kind) {
        return 'wired_fast_path';
    }
    if (intent === 'full-llm' || intent.includes('llm')) {
        return 'wired_fallback';
    }
    return 'wired_fallback';
}

function suggestFromText(text: string, intent: string): SuggestedRegistryRow | null {
    const msg = text.trim();
    if (!msg) {
        return null;
    }

    if (userWantsDashboardTitleRow(msg)) {
        const row = registryRow('dashboard_title_row');
        return {
            kind: 'dashboard_title_row',
            triggers: row?.triggers ?? 'title row at top; markdown # Title at y=0 index 0',
            handler: row?.handler ?? 'applyDashboardTitleRow',
            implementIn: ['dashboardTitleRowParse.ts', 'programmaticDashboardTitleRow.ts', 'ChatInterface.tsx'],
            status: wireStatus('dashboard_title_row', intent),
            matchedBecause: 'Prompt mentions title row / heading at top',
        };
    }

    if (userWantsDashboardMetricPanels(msg)) {
        const row = registryRow('dashboard_metric_panels' as ProgrammaticFallbackKind);
        return {
            kind: 'dashboard_metric_panels',
            triggers: row?.triggers ?? 'create N panels / every available metric on instrumentation dashboard',
            handler: row?.handler ?? 'discoverPrometheusMetricsForMachine + stat panel grid',
            implementIn: [
                'dashboardMetricPanelsParse.ts',
                'instrumentationMetricDiscovery.ts',
                'programmaticDashboardMetricPanels.ts',
                'ChatInterface.tsx',
            ],
            status: wireStatus('dashboard_metric_panels', intent),
            matchedBecause: 'Prompt asks to create panels for every available metric',
        };
    }

    if (userWantsDashboardRebuild(msg)) {
        const row = registryRow('dashboard_rebuild');
        return {
            kind: 'dashboard_rebuild',
            triggers: row?.triggers ?? 'rebuild / best practices / PowerTech conventions',
            handler: row?.handler ?? 'applyBestPracticeDashboardLayout',
            implementIn: ['dashboardRebuildParse.ts', 'programmaticDashboardLayoutRebuild.ts', 'programmaticLlmFallback.ts'],
            status: wireStatus('dashboard_rebuild', intent),
            matchedBecause: 'Prompt mentions rebuild / reorganize / best practices',
        };
    }

    if (userWantsModulePanelReorder(msg)) {
        const row = registryRow('module_panel_reorder');
        return {
            kind: 'module_panel_reorder',
            triggers: row?.triggers ?? 'Module N Current reorder at dashboard bottom',
            handler: row?.handler ?? 'computeModulePanelSectionStartY + reorder',
            implementIn: ['modulePanelReorderParse.ts', 'programmaticModulePanelReorder.ts'],
            status: wireStatus('module_panel_reorder', intent),
            matchedBecause: 'Prompt mentions Module N Current reorder',
        };
    }

    if (userWantsBulkPeerBandFix(msg)) {
        return {
            kind: 'bulk_peer_band_fix',
            triggers: 'fix all vs. Peer Band panels; bulk legend/query repair',
            handler: 'runProgrammaticBulkPeerBandFix',
            implementIn: ['bulkPeerBandFixParse.ts', 'programmaticBulkPeerBandFix.ts'],
            status: wireStatus('bulk_peer_band_fix', intent),
            matchedBecause: 'Prompt mentions peer band bulk fix',
        };
    }

    if (messageMentionsInfluxPanelRepair(msg)) {
        return {
            kind: 'influx_panel_repair',
            triggers: 'Flux legend _value; sanitizeInfluxFluxPanel',
            handler: 'runProgrammaticInfluxPanelRepair',
            implementIn: ['influxPanelRepairParse.ts', 'programmaticInfluxPanelRepair.ts', 'sanitizeInfluxFluxPanel.ts'],
            status: wireStatus('influx_panel_repair', intent),
            matchedBecause: 'Prompt mentions Influx/Flux panel repair',
        };
    }

    // Looser than live routing on purpose: this only categorizes a logged
    // failure, so a machine-id-only "visual copy of 2103-176030" still maps to
    // the clone handler even without the literal word "dashboard".
    if (userWantsDashboardClone(msg) || /\b(visual copy|clone)\b/i.test(msg)) {
        return {
            kind: 'dashboard_clone',
            triggers: 'visual copy / clone dashboard for new machine',
            handler: 'runProgrammaticDashboardClone (pre-LLM intercept in ChatInterface)',
            implementIn: ['dashboardCloneParse.ts', 'programmaticDashboardClone.ts', 'ChatInterface.tsx'],
            status: 'wired_fast_path',
            matchedBecause: 'Prompt mentions dashboard clone — handled programmatically (all panels copied in one pass)',
        };
    }

    if (/\b(function_calls|<invoke\s+name=)/i.test(msg + intent)) {
        return {
            kind: 'leaked_tool_calls',
            triggers: 'LLM emits <function_calls> / <invoke> instead of native tool_calls',
            handler: 'executeLeakedToolCalls in llm.ts',
            implementIn: ['leakedToolCallRecovery.ts', 'llm.ts'],
            status: 'wired_fallback',
            matchedBecause: 'Leaked XML tool markup detected',
        };
    }

    if (userWantsDashboardImproveApply(msg)) {
        return {
            kind: 'dashboard_improve',
            triggers: 'suggest improvements AND apply (review + apply changes)',
            handler: 'runProgrammaticDashboardImprove (pre-LLM intercept in ChatInterface)',
            implementIn: ['dashboardReviewParse.ts', 'programmaticDashboardImprove.ts', 'ChatInterface.tsx'],
            status: 'wired_fast_path',
            matchedBecause:
                'Prompt asks to apply review improvements — title row, dedupe, overlap repair, bar chart→time series, units, and broken-Flux repair saved in one pass',
        };
    }

    if (/\b(grid|layout|overlap|gridPos|reorganiz)/i.test(msg)) {
        return {
            kind: 'dashboard_layout_validate',
            triggers: 'grid overlap / title row / module block after save',
            handler: 'validateDashboardLayout + programmaticLlmFallback',
            implementIn: ['dashboardLayoutValidate.ts', 'programmaticLlmFallback.ts'],
            status: 'wired_fallback',
            matchedBecause: 'Layout / gridPos keywords in prompt',
        };
    }

    return {
        kind: 'unknown',
        triggers: `(new) ${intent || 'operator-reported failure'}`,
        handler: 'Add parse + programmatic handler + registry row in programmaticLlmFallback.ts',
        implementIn: ['*Parse.ts', 'programmatic*.ts', 'programmaticLlmFallback.ts', 'ChatInterface.tsx'],
        status: 'missing',
        matchedBecause: 'No heuristic match — review user message manually',
    };
}

export function suggestRegistryRowForFailure(entry: GraftFailureEntry): SuggestedRegistryRow {
    const blob = `${entry.error}\n${entry.userMessagePreview}`;
    if (/\b(function_calls|<invoke\s+name=)/i.test(blob)) {
        return {
            kind: 'leaked_tool_calls',
            triggers: 'LLM emits <function_calls> / <invoke> instead of native tool_calls',
            handler: 'executeLeakedToolCalls in llm.ts',
            implementIn: ['leakedToolCallRecovery.ts', 'llm.ts'],
            status: 'wired_fallback',
            matchedBecause: 'Leaked XML tool markup in error or assistant output',
        };
    }

    const fromMessage = suggestFromText(entry.userMessagePreview, entry.intent);
    if (fromMessage) {
        return fromMessage;
    }
    return suggestFromText(entry.error, entry.intent) ?? {
        kind: 'unknown',
        triggers: entry.intent,
        handler: 'Investigate error text',
        implementIn: ['graftOperatorFailureLog export'],
        status: 'missing',
        matchedBecause: entry.error.slice(0, 120),
    };
}

export function collectUniqueRegistrySuggestions(entries: GraftFailureEntry[]): SuggestedRegistryRow[] {
    const byKind = new Map<string, SuggestedRegistryRow>();
    for (const entry of entries) {
        const row = suggestRegistryRowForFailure(entry);
        if (!byKind.has(row.kind)) {
            byKind.set(row.kind, row);
        }
    }
    return [...byKind.values()];
}

export function formatRegistrySuggestionMarkdown(row: SuggestedRegistryRow): string[] {
    const statusLabel =
        row.status === 'wired_fast_path'
            ? 'wired (fast path)'
            : row.status === 'wired_fallback'
              ? 'wired (LLM fallback)'
              : '**missing — add handler**';
    return [
        `### ${row.kind} — ${statusLabel}`,
        '',
        `- **Triggers:** ${row.triggers}`,
        `- **Handler:** \`${row.handler}\``,
        `- **Files:** ${row.implementIn.map((f) => `\`${f}\``).join(', ')}`,
        `- **Matched because:** ${row.matchedBecause}`,
        '',
        '**Registry stub (programmaticLlmFallback.ts):**',
        '',
        '```typescript',
        `{ kind: '${row.kind}', triggers: '${row.triggers.replace(/'/g, "\\'")}', handler: '${row.handler}' },`,
        '```',
        '',
    ];
}
