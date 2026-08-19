import { appendDashboardReferencesToReply } from '../appendToolReferences';
import {
    formatAmbiguousGraphCreateClarification,
    messageDescribesAmbiguousGraphCreate,
} from '../ambiguousGraphCreateParse';
import {
    describesCapabilityLimitation,
    formatUnsupportedAdminReply,
    messageDescribesUnsupportedAdminRequest,
} from '../adminCapabilityParse';
import { asksUserToChooseWithoutSave } from '../appendToolReferences';
import { responseNeedsContinueAction } from '../continueAction';
import {
    parseDashboardMetricPanelsRequest,
    userWantsDashboardMetricPanels,
} from '../dashboardMetricPanelsParse';
import {
    messageDescribesDashboardRename,
    parseDashboardRenameRequest,
    userWantsDashboardRename,
} from '../dashboardRenameParse';
import {
    parseDashboardReviewRequest,
    userWantsDashboardReviewOnly,
} from '../dashboardReviewParse';
import { extractMetricsFromPanels } from '../instrumentationMetricDiscovery';
import {
    classifyLlmIntent,
    llmIntentAllowsUpdateDashboard,
} from '../llmIntentRouter';
import {
    messageDescribesBulkGaugePanelRename,
    parseBulkGaugePanelRenameRequest,
    userWantsBulkGaugePanelRenameProgrammatic,
} from '../bulkGaugePanelRenameParse';
import {
    messageDescribesDashboardRowWithPanels,
    parseDashboardRowWithPanelsRequest,
    userWantsDashboardRowWithPanelsProgrammatic,
} from '../dashboardRowWithPanelsParse';
import {
    messageDescribesMultiPanelCreate,
    messageDescribesPanelCreate,
    parseMultiPanelCreateRequest,
    parsePanelCreateRequest,
    userWantsMultiPanelCreateProgrammatic,
    userWantsPanelCreateProgrammatic,
} from '../panelCreateParse';
import {
    messageDescribesPanelRemove,
    parsePanelRemoveRequest,
    userWantsPanelRemove,
} from '../panelRemoveParse';
import {
    messageDescribesPanelRename,
    parsePanelRenameRequest,
    userWantsPanelRename,
} from '../panelRenameParse';
import { messageHasProgrammaticHandler } from '../programmaticChatIntents';
import { formatDashboardReviewReply } from '../programmaticDashboardReview';
import { formatMultiPanelCreateReply, formatPanelCreateReply } from '../programmaticPanelCreate';
import { formatPanelRemoveReply } from '../programmaticPanelRemove';
import { formatPanelRenameReply } from '../programmaticPanelRename';
import { formatClarificationIfNeeded } from '../requestClarity';
import { machineMetricsFieldSelectors } from '../prometheusDiscovery';
import type { ToolExecution } from '../../types/llm.types';
import {
    messageMentionsGrafanaAlertCreate,
    messageMentionsGrafanaAlertUpdate,
    parseGrafanaAlertCreateRequest,
    parseGrafanaAlertUpdateRequest,
} from '../grafanaAlertParse';
import {
    formatHistoryComparisonSignalClarification,
    messageMentionsPredictiveAnalyticsPanel,
    messageNeedsHistoryComparisonSignalClarification,
    parseAddHistoryComparisonPanelRequest,
} from '../historyComparisonPanelAddParse';
import {
    messageMentionsPeerBandPanelCreate,
    parseAddPeerBandPanelRequest,
} from '../peerBandPanelAddParse';
import {
    messageMentionsAddPeerRfPanel,
    parseAddPeerRfPanelRequest,
} from '../peerRfPanelAddParse';
import {
    KEYSIGHT_DASHBOARD_UID,
    REGRESSION_CASES,
    type RegressionCase,
    type RegressionHandlerId,
} from './graftRegressionFixtures';

const BUILD = 87;

function assertHandlerRouting(c: RegressionCase): void {
    const { prompt, contextDashboardUid } = c;

    switch (c.expectHandler) {
        case 'dashboard-metric-panels':
            expect(userWantsDashboardMetricPanels(prompt)).toBe(true);
            expect(parseDashboardMetricPanelsRequest(prompt)?.dashboardUid).toBe(KEYSIGHT_DASHBOARD_UID);
            expect(parseDashboardMetricPanelsRequest(prompt)?.maxPanels).toBe(50);
            break;
        case 'panel-rename':
            expect(userWantsPanelRename(prompt)).toBe(true);
            expect(messageDescribesPanelRename(prompt)).toBe(true);
            expect(parsePanelRenameRequest(prompt)?.currentPanelTitle).toBe('Pressure Gauge');
            expect(parsePanelRenameRequest(prompt)?.newPanelTitle).toBe('System Pressure');
            expect(userWantsDashboardRename(prompt)).toBe(false);
            expect(messageDescribesDashboardRename(prompt)).toBe(false);
            expect(parseDashboardRenameRequest(prompt)).toBeNull();
            break;
        case 'dashboard-review':
        case 'llm-save-guard':
            expect(userWantsDashboardReviewOnly(prompt)).toBe(true);
            expect(parseDashboardReviewRequest(prompt)).toEqual({
                dashboardUid: KEYSIGHT_DASHBOARD_UID,
                suggestionCount: 3,
            });
            break;
        case 'panel-remove':
            expect(messageDescribesPanelRemove(prompt)).toBe(true);
            expect(
                userWantsPanelRemove(prompt, contextDashboardUid ?? KEYSIGHT_DASHBOARD_UID)
            ).toBe(true);
            expect(
                parsePanelRemoveRequest(prompt, {
                    contextDashboardUid: contextDashboardUid ?? KEYSIGHT_DASHBOARD_UID,
                })?.panelTitle
            ).toBe('Cartridge Happiness');
            break;
        case 'panel-create':
            expect(messageDescribesPanelCreate(prompt)).toBe(true);
            expect(messageDescribesMultiPanelCreate(prompt)).toBe(false);
            expect(userWantsPanelCreateProgrammatic(prompt)).toBe(true);
            expect(parsePanelCreateRequest(prompt)).toMatchObject({
                panelTitle: 'Cartridge Comparison',
                panelType: 'barchart',
                titleLabel: 'keysight',
            });
            break;
        case 'panel-create-multi':
            expect(messageDescribesMultiPanelCreate(prompt)).toBe(true);
            expect(messageDescribesPanelCreate(prompt)).toBe(false);
            expect(userWantsMultiPanelCreateProgrammatic(prompt)).toBe(true);
            expect(parseMultiPanelCreateRequest(prompt)).toMatchObject({
                dashboardUid: KEYSIGHT_DASHBOARD_UID,
                panels: [
                    { panelType: 'gauge', panelTitle: 'Gauge Panel' },
                    { panelType: 'timeseries', panelTitle: 'Time Series Panel' },
                    { panelType: 'table', panelTitle: 'Table Panel' },
                    { panelType: 'stat', panelTitle: 'Stat Panel' },
                ],
            });
            break;
        case 'dashboard-row-with-panels':
            expect(messageDescribesDashboardRowWithPanels(prompt)).toBe(true);
            expect(userWantsDashboardRowWithPanelsProgrammatic(prompt)).toBe(true);
            expect(parseDashboardRowWithPanelsRequest(prompt)).toMatchObject({
                rowTitle: 'Machine Health',
                panelCount: 2,
                dashboardUid: KEYSIGHT_DASHBOARD_UID,
            });
            break;
        case 'bulk-gauge-panel-rename':
            expect(messageDescribesBulkGaugePanelRename(prompt)).toBe(true);
            expect(userWantsBulkGaugePanelRenameProgrammatic(prompt)).toBe(true);
            expect(parseBulkGaugePanelRenameRequest(prompt)).toMatchObject({
                titlePrefix: 'System',
                dashboardUid: KEYSIGHT_DASHBOARD_UID,
            });
            expect(userWantsDashboardRename(prompt)).toBe(false);
            expect(messageDescribesDashboardRename(prompt)).toBe(false);
            break;
        case 'ambiguous-graph-clarify':
            expect(messageDescribesAmbiguousGraphCreate(prompt)).toBe(true);
            expect(userWantsDashboardMetricPanels(prompt)).toBe(false);
            expect(messageDescribesMultiPanelCreate(prompt)).toBe(false);
            expect(messageDescribesPanelCreate(prompt)).toBe(false);
            expect(formatClarificationIfNeeded(prompt)).toContain('Need clarification');
            break;
        case 'unsupported-admin': {
            const adminReq = messageDescribesUnsupportedAdminRequest(prompt);
            expect(adminReq).not.toBeNull();
            expect(messageDescribesAmbiguousGraphCreate(prompt)).toBe(false);
            expect(messageDescribesPanelCreate(prompt)).toBe(false);
            expect(userWantsDashboardMetricPanels(prompt)).toBe(false);
            const reply = formatUnsupportedAdminReply(adminReq!, prompt);
            expect(responseNeedsContinueAction(reply)).toBe(false);
            expect(asksUserToChooseWithoutSave(reply, [])).toBe(false);
            expect(describesCapabilityLimitation(reply)).toBe(true);
            break;
        }
        case 'grafana-alert-create':
            expect(messageMentionsGrafanaAlertCreate(prompt)).toBe(true);
            expect(parseGrafanaAlertCreateRequest(prompt)?.panelTitle).toBeTruthy();
            expect(messageMentionsGrafanaAlertUpdate(prompt)).toBe(false);
            expect(messageMentionsPeerBandPanelCreate(prompt)).toBe(false);
            expect(messageMentionsAddPeerRfPanel(prompt)).toBe(false);
            expect(messageDescribesPanelCreate(prompt)).toBe(false);
            break;
        case 'grafana-alert-update':
            expect(messageMentionsGrafanaAlertUpdate(prompt)).toBe(true);
            expect(parseGrafanaAlertUpdateRequest(prompt)).not.toBeNull();
            expect(parseGrafanaAlertCreateRequest(prompt)).toBeNull();
            expect(messageMentionsPeerBandPanelCreate(prompt)).toBe(false);
            expect(messageDescribesPanelCreate(prompt)).toBe(false);
            break;
        case 'peer-band-create':
            expect(messageMentionsPeerBandPanelCreate(prompt)).toBe(true);
            expect(parseAddPeerBandPanelRequest(prompt)?.metricKind).toBe('pressure');
            expect(messageMentionsPredictiveAnalyticsPanel(prompt)).toBe(false);
            expect(messageDescribesPanelCreate(prompt)).toBe(false);
            break;
        case 'history-comparison':
            expect(messageMentionsPredictiveAnalyticsPanel(prompt)).toBe(true);
            expect(parseAddHistoryComparisonPanelRequest(prompt)?.signal?.field).toBe(
                'Cartridge_Sensing_Voltage'
            );
            expect(messageMentionsPeerBandPanelCreate(prompt)).toBe(false);
            expect(messageMentionsAddPeerRfPanel(prompt)).toBe(false);
            break;
        case 'peer-rf-create': {
            expect(messageMentionsAddPeerRfPanel(prompt)).toBe(true);
            const peerReq = parseAddPeerRfPanelRequest(prompt);
            expect(peerReq?.moduleNumber).toBeGreaterThanOrEqual(1);
            expect(peerReq?.moduleNumber).toBeLessThanOrEqual(8);
            expect(peerReq?.dashboardUid).toBe('afq7tc6hl1m9sb');
            expect(messageMentionsPredictiveAnalyticsPanel(prompt)).toBe(false);
            expect(messageMentionsPeerBandPanelCreate(prompt)).toBe(false);
            break;
        }
        case 'history-comparison-clarify': {
            expect(messageNeedsHistoryComparisonSignalClarification(prompt)).toBe(true);
            expect(parseAddHistoryComparisonPanelRequest(prompt)).toBeNull();
            const reply = formatHistoryComparisonSignalClarification(prompt);
            for (const needle of c.expectReplyContains ?? []) {
                expect(reply).toContain(needle);
            }
            for (const needle of c.expectReplyNotContains ?? []) {
                expect(reply).not.toContain(needle);
            }
            break;
        }
        default:
            throw new Error(`Unhandled handler ${c.expectHandler as string}`);
    }
}

describe('graft historical failure regression', () => {
    describe('fixture catalog', () => {
        it('documents known failure patterns', () => {
            expect(REGRESSION_CASES).toHaveLength(22);
            const ids = REGRESSION_CASES.map((c) => c.id);
            expect(new Set(ids).size).toBe(ids.length);
        });
    });

    describe.each(REGRESSION_CASES)('$id — routing', (c: RegressionCase) => {
        it(`detects programmatic handler (${c.failure})`, () => {
            expect(messageHasProgrammaticHandler(c.prompt)).toBe(c.expectProgrammatic);
            assertHandlerRouting(c);
        });

        it(`classifies LLM intent as ${c.expectLlmIntent}`, () => {
            expect(classifyLlmIntent(c.prompt, c.contextDashboardUid)).toBe(c.expectLlmIntent);
        });
    });

    describe('bulk metric panels — machine_metrics field expr', () => {
        const c = REGRESSION_CASES.find((r) => r.id === 'bulk-metric-panels')!;

        it('discovers Keysight metrics via machine_metrics field label, not standalone names', () => {
            expect(machineMetricsFieldSelectors('2505-200033')[0].filters).toEqual(
                expect.arrayContaining([
                    { name: '__name__', value: 'machine_metrics', type: '=' },
                    { name: 'machine', value: '2505-200033', type: '=' },
                ])
            );
            const fromPanel = extractMetricsFromPanels(
                [
                    {
                        id: 1,
                        type: 'stat',
                        title: 'Pressure 1',
                        targets: [
                            {
                                expr: 'machine_metrics{machine="2505-200033", field="Pressure1_psi"}',
                            },
                        ],
                    },
                ],
                '2505-200033'
            );
            expect(fromPanel[0].expr).toBe(
                'machine_metrics{machine="2505-200033",field="Pressure1_psi"}'
            );
            expect(fromPanel[0].key).toBe('field:Pressure1_psi');
        });

        it('routes bulk prompt away from single panel create', () => {
            expect(messageDescribesPanelCreate(c.prompt)).toBe(false);
        });
    });

    describe('panel rename — reply formatting', () => {
        const c = REGRESSION_CASES.find((r) => r.id === 'panel-rename-not-dashboard')!;

        it('formats Panel renamed, not dashboard saved', () => {
            const reply = formatPanelRenameReply(
                {
                    ok: true,
                    toolExecutions: [],
                    dashboardUid: KEYSIGHT_DASHBOARD_UID,
                    dashboardTitle: '2505-200033 / Keysight',
                    previousPanelTitle: 'Pressure Gauge',
                    newPanelTitle: 'System Pressure',
                    panelId: 10,
                    version: 70,
                },
                BUILD
            );
            for (const fragment of c.expectReplyContains ?? []) {
                expect(reply).toContain(fragment);
            }
            for (const fragment of c.expectReplyNotContains ?? []) {
                expect(reply).not.toContain(fragment);
            }
        });

        it('blocks misleading LLM Done (dashboard saved) on panel rename prompts', () => {
            const tools: ToolExecution[] = [
                {
                    name: 'update_dashboard',
                    status: 'success',
                    summary: `Saved dashboard uid=${KEYSIGHT_DASHBOARD_UID}, version=76`,
                },
            ];
            const out = appendDashboardReferencesToReply('Done.', tools, [c.prompt], c.prompt);
            expect(out).toContain('Panel rename should be programmatic');
            expect(out).not.toContain('### Done (dashboard saved)');
        });
    });

    describe('dashboard review — suggest-only reply', () => {
        const c = REGRESSION_CASES.find((r) => r.id === 'dashboard-review-suggest-only')!;

        it('returns numbered suggestions without apply/continue nudge', () => {
            const reply = formatDashboardReviewReply(
                {
                    ok: true,
                    toolExecutions: [],
                    dashboardUid: KEYSIGHT_DASHBOARD_UID,
                    dashboardTitle: '2505-200033 / Keysight',
                    panelCount: 40,
                    suggestions: [
                        { title: 'Remove duplicate Level panels', detail: '3 duplicates.', priority: 90 },
                        { title: 'Consolidate sensing voltage', detail: 'Merge 4 panels.', priority: 80 },
                        { title: 'Add row headers', detail: 'Separate sections.', priority: 70 },
                    ],
                },
                BUILD
            );
            expect(reply).toContain('readability suggestions');
            expect(reply).toMatch(/^\s*1\./m);
            for (const fragment of c.expectReplyNotContains ?? []) {
                expect(reply.toLowerCase()).not.toMatch(new RegExp(fragment, 'i'));
            }
            expect(responseNeedsContinueAction(reply)).toBe(false);
        });
    });

    describe('panel remove — reply formatting', () => {
        const c = REGRESSION_CASES.find((r) => r.id === 'panel-remove-verify')!;

        it('formats Panel removed with verification hint', () => {
            const reply = formatPanelRemoveReply(
                {
                    ok: true,
                    toolExecutions: [],
                    dashboardUid: KEYSIGHT_DASHBOARD_UID,
                    dashboardTitle: '2505-200033 / Keysight',
                    removedPanelTitle: 'Cartridge Happiness Score',
                    panelId: 1,
                    version: 79,
                },
                BUILD
            );
            for (const fragment of c.expectReplyContains ?? []) {
                expect(reply).toContain(fragment);
            }
            expect(reply).toContain('Hard-refresh');
        });
    });

    describe('multi panel create — reply formatting', () => {
        const c = REGRESSION_CASES.find((r) => r.id === 'multi-panel-create-types')!;

        it('formats Panels created for all four panel types', () => {
            const reply = formatMultiPanelCreateReply(
                {
                    ok: true,
                    toolExecutions: [],
                    dashboardUid: KEYSIGHT_DASHBOARD_UID,
                    dashboardTitle: '2505-200033 / Keysight',
                    version: 130,
                    createdPanels: [
                        { panelTitle: 'Gauge Panel', panelType: 'gauge', panelId: 201 },
                        { panelTitle: 'Time Series Panel', panelType: 'timeseries', panelId: 202 },
                        { panelTitle: 'Table Panel', panelType: 'table', panelId: 203 },
                        { panelTitle: 'Stat Panel', panelType: 'stat', panelId: 204 },
                    ],
                },
                BUILD
            );
            for (const fragment of c.expectReplyContains ?? []) {
                expect(reply).toContain(fragment);
            }
            for (const fragment of c.expectReplyNotContains ?? []) {
                expect(reply).not.toContain(fragment);
            }
        });

        it('routes multi-type prompt programmatically, not LLM fake Done', () => {
            expect(messageHasProgrammaticHandler(c.prompt)).toBe(true);
            expect(messageDescribesMultiPanelCreate(c.prompt)).toBe(true);
            expect(messageDescribesPanelCreate(c.prompt)).toBe(false);
            expect(classifyLlmIntent(c.prompt)).toBe('programmatic');
        });
    });

    describe('panel create bar chart — reply formatting', () => {
        const c = REGRESSION_CASES.find((r) => r.id === 'panel-create-bar-chart')!;

        it('formats Panel created, not panel fix', () => {
            const reply = formatPanelCreateReply(
                {
                    ok: true,
                    toolExecutions: [],
                    dashboardUid: KEYSIGHT_DASHBOARD_UID,
                    dashboardTitle: '2505-200033 / Keysight',
                    panelTitle: 'Cartridge Comparison',
                    panelType: 'barchart',
                    panelId: 205,
                    version: 90,
                },
                BUILD
            );
            for (const fragment of c.expectReplyContains ?? []) {
                expect(reply).toContain(fragment);
            }
            for (const fragment of c.expectReplyNotContains ?? []) {
                expect(reply).not.toContain(fragment);
            }
        });

        it('table panel prompts route programmatically, not LLM-only', () => {
            const prompt = 'Create a table panel called "Machine Data" for Keysight.';
            expect(messageHasProgrammaticHandler(prompt)).toBe(true);
            expect(messageDescribesPanelCreate(prompt)).toBe(true);
            expect(parsePanelCreateRequest(prompt)?.panelType).toBe('table');
        });

        it('uses panel added reply when LLM path saves a create prompt', () => {
            const tools: ToolExecution[] = [
                { name: 'get_dashboard_by_uid', status: 'success' },
                {
                    name: 'update_dashboard',
                    status: 'success',
                    summary: `Saved dashboard uid=${KEYSIGHT_DASHBOARD_UID}, version=90`,
                },
            ];
            const modelText =
                '**Cartridge Comparison** bar chart panel created.\n\n**Panel index** — uid `cfo0wckufbdhce`';
            const out = appendDashboardReferencesToReply(modelText, tools, [c.prompt], c.prompt);
            expect(out).toContain('### Done (panel added)');
            expect(out).not.toContain('### Done (panel fix)');
        });
    });

    describe('LLM save guard — review must not allow update_dashboard', () => {
        const c = REGRESSION_CASES.find((r) => r.id === 'llm-save-read-only-guard')!;

        it('blocks update_dashboard for review intent on LLM path', () => {
            const intent = classifyLlmIntent(c.prompt);
            expect(llmIntentAllowsUpdateDashboard(intent)).toBe(false);
        });
    });

    describe('auto-continue nudge — review suggestions', () => {
        const c = REGRESSION_CASES.find((r) => r.id === 'review-no-auto-continue')!;

        it('marks review prompts as review-only so continue loop is skipped', () => {
            expect(userWantsDashboardReviewOnly(c.prompt)).toBe(true);
            expect(messageHasProgrammaticHandler(c.prompt)).toBe(true);
        });

        it('does not show Continue button on formatted review reply', () => {
            const reply = formatDashboardReviewReply(
                {
                    ok: true,
                    toolExecutions: [{ name: 'get_dashboard_by_uid', status: 'success' }],
                    dashboardUid: KEYSIGHT_DASHBOARD_UID,
                    dashboardTitle: 'Keysight',
                    panelCount: 10,
                    suggestions: [
                        { title: 'Fix duplicates', detail: 'detail', priority: 90 },
                        { title: 'Add headers', detail: 'detail', priority: 80 },
                        { title: 'Tighten layout', detail: 'detail', priority: 70 },
                    ],
                },
                BUILD
            );
            expect(responseNeedsContinueAction(reply)).toBe(false);
        });
    });

    describe('handler exclusivity', () => {
        const handlers: RegressionHandlerId[] = [
            'dashboard-metric-panels',
            'panel-rename',
            'dashboard-review',
            'panel-remove',
            'panel-create',
            'panel-create-multi',
            'dashboard-row-with-panels',
            'bulk-gauge-panel-rename',
            'ambiguous-graph-clarify',
            'unsupported-admin',
            'grafana-alert-create',
            'grafana-alert-update',
            'peer-band-create',
            'history-comparison',
            'peer-rf-create',
            'history-comparison-clarify',
        ];

        it.each(handlers)('%s prompt does not collide with unrelated handlers', (handlerId) => {
            const c = REGRESSION_CASES.find(
                (r) => r.expectHandler === handlerId && r.id !== 'review-no-auto-continue'
            )!;
            expect(c).toBeDefined();
            if (handlerId !== 'dashboard-metric-panels') {
                expect(userWantsDashboardMetricPanels(c.prompt)).toBe(false);
            }
            if (handlerId !== 'panel-rename') {
                expect(userWantsPanelRename(c.prompt)).toBe(false);
            }
            if (handlerId !== 'dashboard-review') {
                expect(userWantsDashboardReviewOnly(c.prompt)).toBe(false);
            }
            if (handlerId !== 'panel-remove') {
                expect(messageDescribesPanelRemove(c.prompt)).toBe(false);
            }
            if (handlerId !== 'panel-create') {
                expect(messageDescribesPanelCreate(c.prompt)).toBe(false);
            }
            if (handlerId !== 'panel-create-multi') {
                expect(messageDescribesMultiPanelCreate(c.prompt)).toBe(false);
            }
            if (handlerId !== 'dashboard-row-with-panels') {
                expect(messageDescribesDashboardRowWithPanels(c.prompt)).toBe(false);
            }
            if (handlerId !== 'bulk-gauge-panel-rename') {
                expect(messageDescribesBulkGaugePanelRename(c.prompt)).toBe(false);
            }
            if (handlerId !== 'ambiguous-graph-clarify') {
                expect(messageDescribesAmbiguousGraphCreate(c.prompt)).toBe(false);
            }
            if (handlerId !== 'unsupported-admin') {
                expect(messageDescribesUnsupportedAdminRequest(c.prompt)).toBeNull();
            }
            if (handlerId !== 'grafana-alert-create') {
                expect(messageMentionsGrafanaAlertCreate(c.prompt)).toBe(false);
            }
            if (handlerId !== 'grafana-alert-update') {
                expect(messageMentionsGrafanaAlertUpdate(c.prompt)).toBe(false);
            }
            if (handlerId !== 'peer-band-create') {
                expect(messageMentionsPeerBandPanelCreate(c.prompt)).toBe(false);
            }
            if (
                handlerId !== 'history-comparison' &&
                handlerId !== 'history-comparison-clarify'
            ) {
                expect(messageMentionsPredictiveAnalyticsPanel(c.prompt)).toBe(false);
            }
            if (handlerId !== 'peer-rf-create') {
                expect(messageMentionsAddPeerRfPanel(c.prompt)).toBe(false);
            }
        });
    });

    describe('ambiguous graphs — clarification', () => {
        const c = REGRESSION_CASES.find((r) => r.id === 'ambiguous-graphs-keysight')!;

        it('returns clarification instead of LLM save reply', () => {
            const reply = formatAmbiguousGraphCreateClarification(c.prompt);
            for (const needle of c.expectReplyContains ?? []) {
                expect(reply).toContain(needle);
            }
            for (const needle of c.expectReplyNotContains ?? []) {
                expect(reply).not.toContain(needle);
            }
        });
    });
});
