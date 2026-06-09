import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import {
    findPanelByStrictTitle,
    listDashboardPanels,
    type DashboardPanelEntry,
} from './panelDiscovery';
import { findPrometheusTemplatePanel } from './instrumentationMetricDiscovery';
import {
    discoverPrometheusFieldNamesForMachine,
    resolvePrometheusDatasourceUid,
} from './prometheusDiscovery';
import { inferMachineIdFromDashboardTitle, resolveDashboardUid } from './programmaticDashboardResolve';
import type { PanelCreateRequest } from './panelCreateParse';

type PanelRecord = Record<string, unknown>;

export interface ProgrammaticPanelCreateResult {
    ok: boolean;
    error?: string;
    clarification?: boolean;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    panelTitle?: string;
    panelType?: string;
    panelId?: number;
    version?: number;
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(step: ToolExecution, outcome: { ok: boolean; error?: string; summary?: string }): ToolExecution {
    return { ...step, status: outcome.ok ? 'success' : 'error', error: outcome.error, summary: outcome.summary };
}

function maxPanelId(entries: DashboardPanelEntry[]): number {
    let max = 0;
    for (const e of entries) {
        if (e.panelId != null && e.panelId > max) {
            max = e.panelId;
        }
    }
    return max;
}

function computeAppendGridPos(entries: DashboardPanelEntry[], panel: PanelRecord): { x: number; y: number; w: number; h: number } {
    const defaultW = 12;
    const defaultH = 8;
    let maxY = 0;
    for (const e of entries) {
        const gp = e.panel.gridPos as { y?: number; h?: number } | undefined;
        if (gp && typeof gp.y === 'number' && typeof gp.h === 'number') {
            maxY = Math.max(maxY, gp.y + gp.h);
        }
    }
    const srcGp = panel.gridPos as { w?: number; h?: number } | undefined;
    return {
        x: 0,
        y: maxY,
        w: typeof srcGp?.w === 'number' ? srcGp.w : defaultW,
        h: typeof srcGp?.h === 'number' ? srcGp.h : defaultH,
    };
}

function humanizeField(field: string): string {
    return field.replace(/_/g, ' ').trim();
}

function findTemplatePanel(entries: DashboardPanelEntry[], panelType: string): PanelRecord | undefined {
    const typed = entries.find((e) => String(e.panel.type ?? '').toLowerCase() === panelType);
    if (typed) {
        return JSON.parse(JSON.stringify(typed.panel)) as PanelRecord;
    }
    const prom = findPrometheusTemplatePanel(entries);
    if (prom) {
        return JSON.parse(JSON.stringify(prom.panel)) as PanelRecord;
    }
    return entries.find((e) => String(e.panel.type ?? '') !== 'row')
        ? (JSON.parse(JSON.stringify(entries.find((e) => String(e.panel.type ?? '') !== 'row')!.panel)) as PanelRecord)
        : undefined;
}

function targetsFromCartridgePanels(entries: DashboardPanelEntry[], machineId: string, dsUid?: string) {
    const datasource = dsUid ? { type: 'prometheus', uid: dsUid } : { type: 'prometheus' };
    const cartridgePanels = entries.filter((e) => /cartridge/i.test(e.title));
    const targets: PanelRecord[] = [];
    let ref = 65;
    for (const entry of cartridgePanels.slice(0, 8)) {
        const panelTargets = entry.panel.targets;
        if (!Array.isArray(panelTargets)) {
            continue;
        }
        for (const t of panelTargets) {
            if (!t || typeof t !== 'object') {
                continue;
            }
            const target = t as Record<string, unknown>;
            if (typeof target.expr !== 'string' || !target.expr.trim()) {
                continue;
            }
            targets.push({
                refId: String.fromCharCode(ref++),
                datasource: target.datasource ?? datasource,
                expr: `last_over_time(${target.expr.replace(/^last_over_time\((.+)\)\[.+\]$/i, '$1')}[15m])`,
                legendFormat: entry.title,
            });
            break;
        }
    }
    if (targets.length > 0) {
        return targets;
    }
    const defaultFields = ['Cartridge_Happiness_Score', 'Cartridge_Sensing_Voltage', 'Average_Sensing_Voltage'];
    return defaultFields.map((field, i) => ({
        refId: String.fromCharCode(65 + i),
        datasource,
        expr: `last_over_time(machine_metrics{machine="${machineId}", field="${field}"}[15m])`,
        legendFormat: humanizeField(field),
    }));
}

async function buildPanelTargets(
    request: PanelCreateRequest,
    entries: DashboardPanelEntry[],
    machineId: string | undefined,
    dashboardPanels: unknown[] | undefined,
    mcpClient: McpClient,
    toolExecutions: ToolExecution[]
): Promise<PanelRecord[]> {
    const dsUid = await resolvePrometheusDatasourceUid(mcpClient, dashboardPanels ?? [], toolExecutions);
    const datasource = dsUid ? { type: 'prometheus', uid: dsUid } : { type: 'prometheus' };

    if (/cartridge/i.test(request.panelTitle) && machineId && dsUid) {
        const fields = await discoverPrometheusFieldNamesForMachine(mcpClient, machineId, dsUid);
        const cartridgeFields = fields.filter((f: string) => /cartridge/i.test(f)).slice(0, 8);
        if (cartridgeFields.length > 0) {
            return cartridgeFields.map((field: string, i: number) => ({
                refId: String.fromCharCode(65 + i),
                datasource,
                expr: `last_over_time(machine_metrics{machine="${machineId}", field="${field}"}[15m])`,
                legendFormat: humanizeField(field),
            }));
        }
        return targetsFromCartridgePanels(entries, machineId, dsUid);
    }

    const template = findTemplatePanel(entries, request.panelType);
    const templateTargets = template?.targets;
    if (Array.isArray(templateTargets) && templateTargets.length > 0) {
        return templateTargets.map((t, i) => {
            const target = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
            return {
                ...target,
                refId: String.fromCharCode(65 + i),
                datasource: target.datasource ?? datasource,
            };
        });
    }

    if (machineId) {
        return [
            {
                refId: 'A',
                datasource,
                expr: `machine_metrics{machine="${machineId}"}`,
                legendFormat: '{{field}}',
            },
        ];
    }

    return [
        {
            refId: 'A',
            datasource,
            expr: 'vector(0)',
            legendFormat: request.panelTitle,
        },
    ];
}

function buildNewPanel(
    request: PanelCreateRequest,
    panelId: number,
    gridPos: { x: number; y: number; w: number; h: number },
    targets: PanelRecord[],
    template?: PanelRecord
): PanelRecord {
    const base = template ? (JSON.parse(JSON.stringify(template)) as PanelRecord) : {};
    delete base.id;
    delete base.timeFrom;
    delete base.timeTo;

    const panel: PanelRecord = {
        ...base,
        id: panelId,
        type: request.panelType,
        title: request.panelTitle,
        gridPos,
        targets,
        fieldConfig: {
            defaults: {
                ...(base.fieldConfig as { defaults?: Record<string, unknown> } | undefined)?.defaults,
                color: { mode: 'palette-classic' },
            },
            overrides: [],
        },
    };

    if (request.panelType === 'barchart') {
        panel.options = {
            ...(base.options as Record<string, unknown> | undefined),
            orientation: 'auto',
            showValue: 'auto',
            stacking: 'none',
            legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
        };
    } else if (request.panelType === 'gauge') {
        panel.options = {
            reduceOptions: { values: false, calcs: ['lastNotNull'] },
            ...(base.options as Record<string, unknown> | undefined),
        };
    }

    return panel;
}

export async function runProgrammaticPanelCreate(
    mcpClient: McpClient,
    request: PanelCreateRequest,
    opts?: { contextDashboardUid?: string }
): Promise<ProgrammaticPanelCreateResult> {
    const toolExecutions: ToolExecution[] = [];
    const resolved = await resolveDashboardUid(
        mcpClient,
        {
            dashboardUid: request.dashboardUid ?? opts?.contextDashboardUid,
            titleLabel: request.titleLabel,
            machineId: request.machineId,
        },
        toolExecutions
    );
    if (!resolved.uid) {
        return { ok: false, error: resolved.error ?? 'Could not resolve dashboard uid.', toolExecutions };
    }

    const getStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getStep);
    const fetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: resolved.uid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getStep, fetch);
    if (!fetch.ok) {
        return { ok: false, error: fetch.error ?? 'Could not load dashboard', toolExecutions, dashboardUid: resolved.uid };
    }

    const extracted = extractDashboardFromGetByUid(fetch.text);
    if (!extracted?.dashboard) {
        return { ok: false, error: 'Could not parse dashboard JSON', toolExecutions, dashboardUid: resolved.uid };
    }

    const baseline = extracted.dashboard as Record<string, unknown>;
    const dashboardTitle = typeof baseline.title === 'string' ? baseline.title : resolved.title;
    const entries = listDashboardPanels(baseline.panels);
    const existing = findPanelByStrictTitle(entries, request.panelTitle);
    if (existing) {
        return {
            ok: false,
            error: `Panel **${existing.title}** already exists (id ${existing.panelId ?? '?'}).`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            panelTitle: request.panelTitle,
        };
    }

    const machineId = request.machineId ?? inferMachineIdFromDashboardTitle(dashboardTitle);
    const template = findTemplatePanel(entries, request.panelType);
    const targets = await buildPanelTargets(
        request,
        entries,
        machineId,
        Array.isArray(baseline.panels) ? baseline.panels : [],
        mcpClient,
        toolExecutions
    );
    const nextId = maxPanelId(entries) + 1;
    const draftPanel = buildNewPanel(
        request,
        nextId,
        computeAppendGridPos(entries, template ?? { gridPos: { w: 12, h: 8 } }),
        targets,
        template
    );

    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    const panels = Array.isArray(proposed.panels) ? [...(proposed.panels as PanelRecord[])] : [];
    panels.push(draftPanel);
    proposed.panels = panels;

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(baseline, proposed),
        overwrite: true,
        message: `Graft: create panel "${request.panelTitle}" (${request.panelType})`,
    });
    const saveResult = await callMcpTool(mcpClient, 'update_dashboard', savePayload);
    toolExecutions[toolExecutions.length - 1] = finishTool(saveStep, saveResult);
    if (!saveResult.ok) {
        return {
            ok: false,
            error: saveResult.error ?? 'update_dashboard failed',
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            panelTitle: request.panelTitle,
            panelType: request.panelType,
        };
    }

    const verifyStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(verifyStep);
    const verify = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: resolved.uid });
    toolExecutions[toolExecutions.length - 1] = finishTool(verifyStep, verify);
    if (!verify.ok) {
        return {
            ok: false,
            error: 'Save reported success but dashboard could not be re-fetched for verification.',
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            panelTitle: request.panelTitle,
            panelType: request.panelType,
        };
    }

    const verified = extractDashboardFromGetByUid(verify.text);
    const version = typeof verified?.dashboard?.version === 'number' ? verified.dashboard.version : undefined;
    const verifiedEntries = listDashboardPanels(verified?.dashboard?.panels);
    const created = findPanelByStrictTitle(verifiedEntries, request.panelTitle);
    if (!created) {
        return {
            ok: false,
            error: `Save reported success but panel **${request.panelTitle}** was not found on the dashboard.`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            panelTitle: request.panelTitle,
            panelType: request.panelType,
            version,
        };
    }

    return {
        ok: true,
        toolExecutions,
        dashboardUid: resolved.uid,
        dashboardTitle,
        panelTitle: request.panelTitle,
        panelType: request.panelType,
        panelId: created.panelId,
        version,
    };
}

export function formatPanelCreateReply(result: ProgrammaticPanelCreateResult, buildNumber: number): string {
    if (result.ok) {
        return (
            `### Panel created (Graft build ${buildNumber})\n\n` +
            `- **Panel:** **${result.panelTitle ?? '?'}** (${result.panelType ?? 'panel'}` +
            (result.panelId != null ? `, id ${result.panelId}` : '') +
            `)\n- **Dashboard:** ${result.dashboardTitle ?? '(untitled)'} — uid \`${result.dashboardUid ?? '?'}\`` +
            (result.version != null ? `\n- **Version:** ${result.version}` : '') +
            `\n\nHard-refresh the dashboard (**Cmd+Shift+R**) to see the new panel.`
        );
    }
    if (result.clarification) {
        return result.error ?? '### Need clarification';
    }
    return `### Could not create panel\n\n${result.error ?? 'Unknown error.'}`;
}
