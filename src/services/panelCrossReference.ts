import {
    extractPanelArrayIndexFromMessage,
    extractPanelIdFromMessage,
    extractPanelTitleFromMessage,
} from './dashboardMentionParse';
import type { ScopedPanelFixTarget } from './panelFixScope';

export interface PanelFixResolvedPanel {
    panelId?: number;
    panelTitle?: string;
    panelArrayIndex?: number;
}

/** How the user identified the panel in their message. */
export function howUserIdentifiedPanel(userMessage: string): {
    byName: boolean;
    byPanelId: boolean;
    byArrayIndex: boolean;
} {
    return {
        byName: Boolean(extractPanelTitleFromMessage(userMessage)),
        byPanelId: extractPanelIdFromMessage(userMessage) != null,
        byArrayIndex: extractPanelArrayIndexFromMessage(userMessage) != null,
    };
}

/**
 * Reply label: if user asked by name → include ids; if by id/index → lead with title.
 */
export function formatScopedPanelCrossReference(
    userMessage: string,
    scope: ScopedPanelFixTarget | null | undefined,
    resolved: PanelFixResolvedPanel | null | undefined
): string {
    const title = resolved?.panelTitle ?? scope?.panelTitle;
    const panelId = resolved?.panelId ?? scope?.panelId;
    const arrayIndex = resolved?.panelArrayIndex ?? scope?.panelArrayIndex;

    const { byName, byPanelId, byArrayIndex } = howUserIdentifiedPanel(userMessage);

    const idBit = panelId != null ? `panel id **${panelId}**` : '';
    const indexBit = arrayIndex != null ? `array index **${arrayIndex}**` : '';

    if (byName && title) {
        const ids = [idBit, indexBit].filter(Boolean).join(', ');
        return ids ? `**${title}** (${ids})` : `**${title}**`;
    }

    if ((byPanelId || byArrayIndex) && title) {
        const asked =
            byPanelId && scope?.panelId != null && panelId != null && scope.panelId !== panelId
                ? `You asked for panel id **${scope.panelId}**; fixed `
                : '';
        const loc = [idBit, indexBit].filter(Boolean).join(', ');
        return loc ? `${asked}**${title}** (${loc})` : `${asked}**${title}**`;
    }

    if ((byPanelId || byArrayIndex) && !title && panelId != null) {
        return `panel id **${panelId}** (open panel in Grafana to confirm title)`;
    }

    if (title && panelId != null) {
        return `**${title}** (${idBit}${indexBit ? `, ${indexBit}` : ''})`;
    }
    if (panelId != null) {
        return `panel id **${panelId}**`;
    }
    if (title) {
        return `**${title}**`;
    }
    if (arrayIndex != null) {
        return `array index **${arrayIndex}**`;
    }
    return '**the panel**';
}
