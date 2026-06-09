import type { DashboardContext, DataSourceContext } from '../types/context.types';
import { buildPowerTechOperatorGuide } from './graftPowerTechGuide';
import { classifyLlmIntent, type LlmIntentKind } from './llmIntentRouter';
import { inferMachineIdFromDashboardTitle } from './programmaticDashboardResolve';

const PROMQL_ANOMALY_SECTION = [
    'PromQL anomaly detection panels:',
    '- Metrics must be tagged with anomaly_name (required) and optionally anomaly_strategy (adaptive or robust).',
    '- Recording rules produce anomaly:lower_band, anomaly:upper_band, and anomaly:level series.',
    '- Bands need ~24h of data before they are reliable.',
].join('\n');

function isInstrumentationDashboard(title?: string): boolean {
    if (!title) {
        return false;
    }
    return /keysight|instrumentation/i.test(title) || Boolean(inferMachineIdFromDashboardTitle(title));
}

function isModuleDashboard(title?: string): boolean {
    return Boolean(title && /exsolve|module/i.test(title));
}

/** Trim and specialize the LLM system context by intent. */
export function buildIntentAwareLlmContext(
    baseContext: string,
    userMessage: string,
    dashboard: DashboardContext,
    dataSources: DataSourceContext[]
): string {
    const intent = classifyLlmIntent(userMessage, dashboard.uid);
    const lines: string[] = [baseContext];

    lines.push('');
    lines.push(`## LLM routing (intent: **${intent}**)`);

    if (intent === 'read_only') {
        lines.push(
            '- **Read-only turn**: answer or suggest in markdown. Do **not** call update_dashboard. Do not ask to apply unless the user explicitly requests changes.'
        );
        lines.push(
            '- One get_dashboard_by_uid is enough for analysis; avoid tool loops.'
        );
        return lines.join('\n');
    }

    if (intent === 'mutating') {
        lines.push(
            '- **Mutating turn**: get_dashboard_by_uid immediately before update_dashboard; save in the same turn when possible.'
        );
        lines.push(
            '- Never claim success without a successful update_dashboard tool result in this turn.'
        );
    }

    const title = dashboard.title;
    if (intent === 'mutating' && isInstrumentationDashboard(title)) {
        lines.push('');
        lines.push('### Keysight / instrumentation (this dashboard)');
        lines.push(buildPowerTechOperatorGuide().split('\n').slice(8, 12).join('\n'));
    } else if (intent === 'mutating' && isModuleDashboard(title)) {
        lines.push('');
        lines.push('### Module dashboard (this dashboard)');
        lines.push(
            '- Flux peer-band / own-history / History Comparison rules apply. Module N Current blocks belong at the bottom (w=24, h=12).'
        );
    }

    if (/\banomaly\b/i.test(userMessage)) {
        lines.push('');
        lines.push(PROMQL_ANOMALY_SECTION);
    }

    const hasPrometheus = dataSources.some((d) => d.type === 'prometheus');
    const hasInflux = dataSources.some((d) => d.type === 'influxdb' || d.type === 'influx');
    if (intent === 'mutating' && hasPrometheus && !hasInflux) {
        lines.push('- Datasource: Prometheus only on this stack — do not invent Influx fields.');
    }

    return lines.join('\n');
}

export function getLlmIntentForMessage(userMessage: string, contextDashboardUid?: string): LlmIntentKind {
    return classifyLlmIntent(userMessage, contextDashboardUid);
}
