import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { listDashboardPanels } from './panelDiscovery';

export interface DashboardTurnSnapshot {
    uid: string;
    title?: string;
    version?: number;
    panelCount: number;
    panelTitles: string[];
}

let turnBaseline: DashboardTurnSnapshot | null = null;

export function resetTurnDashboardBaseline(): void {
    turnBaseline = null;
}

export function recordDashboardFetchFromMcpText(uid: string, text: string): void {
    const extracted = extractDashboardFromGetByUid(text);
    if (!extracted?.dashboard) {
        return;
    }
    const dash = extracted.dashboard;
    const entries = listDashboardPanels(dash.panels);
    turnBaseline = {
        uid,
        title: typeof dash.title === 'string' ? dash.title : undefined,
        version: typeof dash.version === 'number' ? dash.version : undefined,
        panelCount: entries.length,
        panelTitles: entries.map((e) => e.title).filter(Boolean),
    };
}

export function getTurnDashboardBaseline(): DashboardTurnSnapshot | null {
    return turnBaseline;
}
