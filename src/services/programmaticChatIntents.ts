import { userWantsBulkPeerBandFix, messageMentionsPeerBandPanelsButNotBulkFix } from './bulkPeerBandFixParse';
import { messageMentionsAddPeerRfPanel, parseAddPeerRfPanelRequest } from './peerRfPanelAddParse';
import { userWantsDashboardClone, userWantsDashboardPanelFix } from './dashboardCloneProgress';
import {
    messageDescribesDashboardRename,
    userWantsDashboardRename,
} from './dashboardRenameParse';
import {
    messageMentionsPeerBandPanelCopyIntent,
    userWantsPeerBandPanelCopy,
} from './peerBandPanelCopyParse';
import {
    isExplicitSinglePanelCopyRequest,
    messageMentionsSinglePanelCopyIntent,
    userWantsSinglePanelCopy,
} from './singlePanelCopyParse';
import { isPanelFixVerificationRequest } from './panelFixVerification';
import {
    isModuleReorderConfirmation,
    parseModulePanelReorderRequest,
    userWantsModulePanelReorder,
} from './modulePanelReorderParse';
import {
    parseDashboardTitleRowRequest,
    userWantsDashboardTitleRow,
} from './dashboardTitleRowParse';
import {
    parseDashboardRebuildRequest,
    userWantsDashboardRebuild,
} from './dashboardRebuildParse';
import {
    parseDashboardMetricPanelsRequest,
    userWantsDashboardMetricPanels,
} from './dashboardMetricPanelsParse';

/** True when Graft can handle the message via MCP without calling the LLM. */
export function messageHasProgrammaticHandler(message: string): boolean {
    const text = message.trim();
    if (!text) {
        return false;
    }

    return (
        userWantsDashboardRename(text) ||
        messageDescribesDashboardRename(text) ||
        userWantsPeerBandPanelCopy(text) ||
        messageMentionsPeerBandPanelCopyIntent(text) ||
        isExplicitSinglePanelCopyRequest(text) ||
        userWantsSinglePanelCopy(text) ||
        messageMentionsSinglePanelCopyIntent(text) ||
        userWantsBulkPeerBandFix(text) ||
        userWantsModulePanelReorder(text) ||
        isModuleReorderConfirmation(text) ||
        parseModulePanelReorderRequest(text) != null ||
        userWantsDashboardTitleRow(text) ||
        parseDashboardTitleRowRequest(text) != null ||
        userWantsDashboardMetricPanels(text) ||
        parseDashboardMetricPanelsRequest(text) != null ||
        userWantsDashboardRebuild(text) ||
        parseDashboardRebuildRequest(text) != null ||
        parseAddPeerRfPanelRequest(text) != null ||
        messageMentionsAddPeerRfPanel(text) ||
        messageMentionsPeerBandPanelsButNotBulkFix(text) ||
        userWantsDashboardClone(text) ||
        userWantsDashboardPanelFix(text) ||
        isPanelFixVerificationRequest(text)
    );
}

/** Casual chat (e.g. "test", "hello") — skip MCP tools and auto-continue loops. */
export function isSimpleConversationalMessage(message: string): boolean {
    const text = message.trim();
    if (!text || text.length > 240) {
        return false;
    }
    if (messageHasProgrammaticHandler(text)) {
        return false;
    }
    if (
        /\b(dashboard|dash\s*board|panels?|grafana|prometheus|loki|clone|copy of|fix|repair|machine|uid|metric|logql|promql)\b/i.test(
            text
        )
    ) {
        return false;
    }
    return true;
}

export function canSendWithoutLlm(message: string, mcpConnected: boolean): boolean {
    return mcpConnected && messageHasProgrammaticHandler(message);
}

export function chatInputEnabled(llmReady: boolean, mcpConnected: boolean): boolean {
    return llmReady || mcpConnected;
}

export function canSendChatMessage(opts: {
    input: string;
    isLoading: boolean;
    llmReady: boolean;
    mcpConnected: boolean;
}): boolean {
    const text = opts.input.trim();
    if (!text || opts.isLoading) {
        return false;
    }
    return opts.llmReady || canSendWithoutLlm(text, opts.mcpConnected);
}

export function chatInputPlaceholder(opts: {
    llmReady: boolean;
    mcpConnected: boolean;
    rollingPlaceholder: string;
}): string {
    if (opts.llmReady) {
        return opts.rollingPlaceholder;
    }
    if (opts.mcpConnected) {
        return 'Programmatic dashboard tasks work via MCP (rename, clone, peer-band fix). Press Send.';
    }
    return 'Configure Grafana LLM plugin to start chatting...';
}
