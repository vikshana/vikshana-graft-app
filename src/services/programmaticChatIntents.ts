import { userWantsBulkPeerBandFix, messageMentionsPeerBandPanelsButNotBulkFix } from './bulkPeerBandFixParse';
import { messageDescribesUnsupportedAdminRequest } from './adminCapabilityParse';
import { messageMentionsAddPeerRfPanel, parseAddPeerRfPanelRequest } from './peerRfPanelAddParse';
import { userWantsDashboardClone, userWantsDashboardPanelFix } from './dashboardCloneProgress';
import {
    messageDescribesDashboardRename,
    userWantsDashboardRename,
} from './dashboardRenameParse';
import {
    messageDescribesPanelRename,
    parsePanelRenameRequest,
    userWantsPanelRename,
} from './panelRenameParse';
import {
    messageDescribesPanelRemove,
    parsePanelRemoveRequest,
    userWantsPanelRemove,
} from './panelRemoveParse';
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
import { userWantsDashboardReviewOnly } from './dashboardReviewParse';
import { messageMentionsGrafanaAlertCreate } from './grafanaAlertParse';
import { messageMentionsGrafanaAlertCreate } from './grafanaAlertParse';
import {
    messageDescribesBulkGaugePanelRename,
    parseBulkGaugePanelRenameRequest,
    userWantsBulkGaugePanelRenameProgrammatic,
} from './bulkGaugePanelRenameParse';
import {
    messageDescribesDashboardRowWithPanels,
    parseDashboardRowWithPanelsRequest,
    userWantsDashboardRowWithPanelsProgrammatic,
} from './dashboardRowWithPanelsParse';
import {
    messageDescribesMultiPanelCreate,
    messageDescribesPanelCreate,
    parseMultiPanelCreateRequest,
    parsePanelCreateRequest,
    userWantsMultiPanelCreateProgrammatic,
    userWantsPanelCreateProgrammatic,
} from './panelCreateParse';

/** True when Graft can handle the message via MCP without calling the LLM. */
export function messageHasProgrammaticHandler(message: string, contextDashboardUid?: string): boolean {
    const text = message.trim();
    if (!text) {
        return false;
    }

    return (
        messageDescribesUnsupportedAdminRequest(text) != null ||
        userWantsBulkGaugePanelRenameProgrammatic(text, contextDashboardUid) ||
        messageDescribesBulkGaugePanelRename(text) ||
        parseBulkGaugePanelRenameRequest(text, { contextDashboardUid }) != null ||
        userWantsDashboardRowWithPanelsProgrammatic(text, contextDashboardUid) ||
        messageDescribesDashboardRowWithPanels(text, contextDashboardUid) ||
        parseDashboardRowWithPanelsRequest(text, { contextDashboardUid }) != null ||
        userWantsMultiPanelCreateProgrammatic(text, contextDashboardUid) ||
        messageDescribesMultiPanelCreate(text, contextDashboardUid) ||
        parseMultiPanelCreateRequest(text, { contextDashboardUid }) != null ||
        userWantsPanelCreateProgrammatic(text) ||
        messageDescribesPanelCreate(text) ||
        parsePanelCreateRequest(text) != null ||
        userWantsPanelRename(text) ||
        messageDescribesPanelRename(text) ||
        parsePanelRenameRequest(text) != null ||
        userWantsPanelRemove(text) ||
        messageDescribesPanelRemove(text) ||
        parsePanelRemoveRequest(text) != null ||
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
        userWantsDashboardReviewOnly(text) ||
        messageMentionsGrafanaAlertCreate(text) ||
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
    // Any Grafana/observability noun routes to the tool-enabled path. Match singular
    // AND plural forms — a prior bug let "dashboards"/"uids"/"metrics" slip through
    // (\bdashboard\b never matches "dashboards"), misrouting real tool queries like
    // "list the dashboards in this org" to the tool-less conversational path.
    if (
        /\b(dashboards?|dash\s*boards?|panels?|grafana|prometheus|loki|clone|copy of|fix|repair|machines?|uids?|metrics?|logql|promql|folders?|datasources?|data\s*sources?|alerts?)\b/i.test(
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
