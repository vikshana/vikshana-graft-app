import { extractAllDashboardUids } from './dashboardMentionParse';
import { findMachineIdsInText, isMachineId, MACHINE_ID_PATTERN } from './dashboardCloneParse';
import { userWantsDashboardMetricPanels } from './dashboardMetricPanelsParse';

export type PanelCreateType = 'barchart' | 'gauge' | 'stat' | 'timeseries' | 'table';

export interface PanelCreateRequest {
    panelTitle: string;
    panelType: PanelCreateType;
    dashboardUid?: string;
    titleLabel?: string;
    machineId?: string;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function extractPanelTitle(text: string): string | undefined {
    const patterns = [
        /\b(?:create|add|make)\s+(?:a\s+)?(?:new\s+)?(?:(?:[\w-]+\s+)+)?panel\s+(?:called|named|titled)\s+"([^"]+)"/i,
        /\b(?:create|add|make)\s+(?:a\s+)?(?:new\s+)?(?:(?:[\w-]+\s+)+)?panel\s+(?:called|named|titled)\s+'([^']+)'/i,
        /\b(?:create|add|make)\s+(?:a\s+)?(?:new\s+)?(?:bar\s*chart|gauge|stat|time\s*series|timeseries|table|chart)\s+panel\s+(?:called|named|titled)\s+"([^"]+)"/i,
        /\b(?:create|add|make)\s+(?:a\s+)?(?:new\s+)?(?:bar\s*chart|gauge|stat|time\s*series|timeseries|table|chart)\s+(?:called|named|titled)\s+"([^"]+)"/i,
        /\b(?:create|add|make)\s+(?:a\s+)?(?:new\s+)?panel\s+(?:called|named|titled)\s+"([^"]+)"/i,
        /\b(?:create|add|make)\s+(?:a\s+)?(?:new\s+)?(?:bar\s*chart|gauge|stat|time\s*series|timeseries|table|chart)\s+panel\s+(?:called|named|titled)\s+'([^']+)'/i,
        /\b(?:create|add|make)\s+(?:a\s+)?(?:new\s+)?panel\s+(?:called|named|titled)\s+'([^']+)'/i,
    ];
    for (const re of patterns) {
        const match = text.match(re);
        if (match?.[1]?.trim()) {
            return match[1].trim();
        }
    }
    return undefined;
}

function inferPanelType(text: string): PanelCreateType {
    if (/\btable\b/i.test(text)) {
        return 'table';
    }
    if (/\bbar\s*chart\b/i.test(text) || (/\bchart\b/i.test(text) && !/\btime\s*series\b/i.test(text))) {
        return 'barchart';
    }
    if (/\bgauge\b/i.test(text)) {
        return 'gauge';
    }
    if (/\btime\s*series\b|\btimeseries\b/i.test(text)) {
        return 'timeseries';
    }
    if (/\bstat\b/i.test(text)) {
        return 'stat';
    }
    return 'barchart';
}

function extractTitleLabel(text: string): string | undefined {
    if (/\bkeysight\b/i.test(text)) {
        return 'keysight';
    }
    const onDash = text.match(/\bon\s+(?:the\s+)?([A-Za-z][A-Za-z0-9 _-]{2,40})\s+dashboard\b/i);
    if (onDash?.[1] && !/\buid\b/i.test(onDash[1])) {
        return onDash[1].trim().toLowerCase();
    }
    const forLabel = text.match(/\bfor\s+(?:the\s+)?([A-Za-z][A-Za-z0-9 _-]{2,40})\.?$/i);
    if (forLabel?.[1] && !isMachineId(forLabel[1])) {
        return forLabel[1].trim().toLowerCase();
    }
    return undefined;
}

function extractMachineId(text: string): string | undefined {
    const forMachine = text.match(
        new RegExp(`\\bfor\\s+(?:the\\s+)?(?:machine\\s+)?(${MACHINE_ID_PATTERN.source})\\b`, 'i')
    );
    if (forMachine?.[1] && isMachineId(forMachine[1])) {
        return forMachine[1];
    }
    return findMachineIdsInText(text).find((id) => isMachineId(id));
}

export function messageDescribesPanelCreate(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text || userWantsDashboardMetricPanels(text)) {
        return false;
    }
    if (!/\b(create|add|make)\b/i.test(text)) {
        return false;
    }
    const hasTypedPanel =
        /\b(bar\s*chart|gauge|stat|time\s*series|timeseries|table|chart)\b/i.test(text) &&
        /\bpanel\b/i.test(text);
    const hasNamedPanel =
        /\b(create|add|make)\b/i.test(text) &&
        /\bpanel\b/i.test(text) &&
        /\b(called|named|titled)\b/i.test(text);
  return Boolean(extractPanelTitle(text) && (hasTypedPanel || hasNamedPanel || /\bchart\b/i.test(text)));
}

export function userWantsPanelCreateProgrammatic(message: string, contextDashboardUid?: string): boolean {
    return parsePanelCreateRequest(message, { contextDashboardUid }) != null;
}

export function parsePanelCreateRequest(
    message: string,
    opts?: { contextDashboardUid?: string }
): PanelCreateRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageDescribesPanelCreate(text)) {
        return null;
    }

    const panelTitle = extractPanelTitle(text);
    if (!panelTitle) {
        return null;
    }

    const dashboardUid = extractAllDashboardUids(text)[0] ?? opts?.contextDashboardUid;
    const titleLabel = extractTitleLabel(text);
    const machineId = extractMachineId(text);

    if (!dashboardUid && !titleLabel && !machineId) {
        return null;
    }

    return {
        panelTitle,
        panelType: inferPanelType(text),
        dashboardUid,
        titleLabel,
        machineId,
    };
}

export function formatPanelCreateClarification(message: string): string {
    return (
        `### Need clarification\n\n` +
        `Graft understood a panel-create request but needs the dashboard.\n\n` +
        `**Example:** \`Create a bar chart panel called "Cartridge Comparison" for Keysight.\`\n` +
        `Or include dashboard uid: \`... on dashboard uid=cfo0wckufbdhce\``
    );
}
