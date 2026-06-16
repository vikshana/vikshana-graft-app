// External libraries
import React, { useState, useEffect } from 'react';
import { lastValueFrom } from 'rxjs';

// Grafana packages
import { AppPluginMeta, GrafanaTheme2, PluginConfigPageProps, PluginMeta } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import {
  Alert,
  Button,
  Checkbox,
  Field,
  FieldSet,
  Icon,
  Input,
  useStyles2,
} from '@grafana/ui';
import { css } from '@emotion/css';

import { TOOL_CATEGORIES, getDefaultToolsConfig } from '../../../services/toolFilter';
import type { ToolCategoryConfig, ToolsConfig, AppPluginSettings } from '../../../types/settings.types';

export interface AgentConfigProps extends PluginConfigPageProps<AppPluginMeta<AppPluginSettings>> { }

// ─── Constants ────────────────────────────────────────────────────────────────

const SEARCH_THRESHOLD = 5;
const DEFAULT_MAX_ITERATIONS = 50;

const FIXED_CATEGORY_LABELS: Record<string, string> = {
  loki: 'Loki (log queries)',
  prometheus: 'Prometheus (metrics queries)',
  dashboards: 'Dashboards (create, edit, search)',
  datasources: 'Datasources (list and look up datasources)',
};

type ToolTier = 'oss' | 'cloud';

interface DiscoveredCategory {
  key: string;
  label: string;
  tier: ToolTier;
  tools: string[];
}

/**
 * Hardcoded categorisation of tools discovered from the MCP server.
 * OSS = works on any Grafana install (some require datasource or plugin to be configured).
 * Cloud = requires Grafana Cloud subscription or Enterprise licence / IRM plugin.
 */
const DISCOVERED_CATEGORIES: DiscoveredCategory[] = [
  // ── OSS ──────────────────────────────────────────────────────────────────
  {
    key: 'alerting',
    label: 'Alerting',
    tier: 'oss',
    tools: ['alerting_manage_routing', 'alerting_manage_rules', 'get_alert_group', 'list_alert_groups'],
  },
  {
    key: 'annotations',
    label: 'Annotations',
    tier: 'oss',
    tools: ['create_annotation', 'get_annotation_tags', 'get_annotations', 'update_annotation'],
  },
  {
    key: 'clickhouse',
    label: 'ClickHouse',
    tier: 'oss',
    tools: ['describe_clickhouse_table', 'list_clickhouse_tables', 'query_clickhouse'],
  },
  {
    key: 'cloudwatch',
    label: 'CloudWatch',
    tier: 'oss',
    tools: ['list_cloudwatch_dimensions', 'list_cloudwatch_metrics', 'list_cloudwatch_namespaces', 'query_cloudwatch'],
  },
  {
    key: 'elasticsearch',
    label: 'Elasticsearch',
    tier: 'oss',
    tools: ['query_elasticsearch', 'search_logs'],
  },
  {
    key: 'pyroscope',
    label: 'Pyroscope (profiling)',
    tier: 'oss',
    tools: ['fetch_pyroscope_profile', 'list_pyroscope_label_names', 'list_pyroscope_label_values', 'list_pyroscope_profile_types'],
  },
  {
    key: 'roles',
    label: 'Roles & Permissions',
    tier: 'oss',
    tools: ['get_resource_permissions', 'get_role_assignments', 'get_role_details', 'list_all_roles', 'list_team_roles', 'list_user_roles'],
  },
  {
    key: 'teams',
    label: 'Teams & Users',
    tier: 'oss',
    tools: ['list_teams', 'list_users_by_org'],
  },
  {
    key: 'utility',
    label: 'Utility',
    tier: 'oss',
    tools: ['generate_deeplink', 'get_datasource', 'get_panel_image', 'get_query_examples', 'get_resource_description'],
  },
  // ── Cloud / Enterprise ────────────────────────────────────────────────────
  {
    key: 'oncall',
    label: 'OnCall',
    tier: 'cloud',
    tools: ['get_current_oncall_users', 'get_oncall_shift', 'list_oncall_schedules', 'list_oncall_teams', 'list_oncall_users'],
  },
];

/** All tools covered by DISCOVERED_CATEGORIES — used to identify truly unrecognised tools */
const ALL_CATEGORISED_TOOLS = new Set([
  ...Object.values(TOOL_CATEGORIES).flat(),
  ...DISCOVERED_CATEGORIES.flatMap(c => c.tools),
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildDiscoveredConfig(
  savedTools: ToolsConfig | undefined,
  presentToolNames: Set<string>
): Record<string, ToolCategoryConfig> {
  const result: Record<string, ToolCategoryConfig> = {};
  for (const cat of DISCOVERED_CATEGORIES) {
    const presentInCat = cat.tools.filter(t => presentToolNames.has(t));
    if (presentInCat.length === 0) { continue; }
    const saved = savedTools?.[cat.key];
    result[cat.key] = saved ?? {
      enabled: true,
      tools: Object.fromEntries(cat.tools.map(t => [t, true])),
    };
  }
  return result;
}

// ─── Component ────────────────────────────────────────────────────────────────

const AgentConfig = ({ plugin }: AgentConfigProps) => {
  const s = useStyles2(getStyles);
  const { enabled, pinned, jsonData } = plugin.meta;

  const [tools, setTools] = useState<ToolsConfig>(jsonData?.tools || getDefaultToolsConfig());
  const [discoveredTools, setDiscoveredTools] = useState<Record<string, ToolCategoryConfig>>({});
  const [unknownTools, setUnknownTools] = useState<string[]>([]);
  const [unknownEnabled, setUnknownEnabled] = useState<Record<string, boolean>>({});
  const [maxToolIterations, setMaxToolIterations] = useState(
    jsonData?.maxToolIterations ?? DEFAULT_MAX_ITERATIONS
  );

  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [saveMessage, setSaveMessage] = useState('');

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [searchTerms, setSearchTerms] = useState<Record<string, string>>({});

  // Fetch live tool list from backend proxy on mount
  useEffect(() => {
    getBackendSrv()
      .get(`/api/plugins/${plugin.meta.id}/resources/tools`)
      .then((resp: any) => {
        const presentNames = new Set<string>(
          (resp?.tools ?? []).map((t: { name: string }) => t.name)
        );
        setDiscoveredTools(buildDiscoveredConfig(jsonData?.tools, presentNames));

        const unknown = [...presentNames].filter(n => !ALL_CATEGORISED_TOOLS.has(n));
        setUnknownTools(unknown);
        setUnknownEnabled(Object.fromEntries(unknown.map(n => [n, true])));
      })
      .catch(() => { /* MCP unreachable — known categories still shown */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const toggleFixed = (category: string, value: boolean) => {
    setTools(prev => ({
      ...prev,
      [category]: {
        enabled: value,
        tools: Object.fromEntries(
          (TOOL_CATEGORIES[category as keyof typeof TOOL_CATEGORIES] ?? []).map(t => [t, value])
        ),
      },
    }));
  };

  const toggleFixedTool = (category: string, toolName: string, value: boolean) => {
    setTools(prev => {
      const updated = { ...prev[category].tools, [toolName]: value };
      return {
        ...prev,
        [category]: { enabled: Object.values(updated).some(Boolean), tools: updated },
      };
    });
  };

  const toggleDiscovered = (catKey: string, value: boolean) => {
    setDiscoveredTools(prev => {
      const cat = DISCOVERED_CATEGORIES.find(c => c.key === catKey)!;
      return {
        ...prev,
        [catKey]: {
          enabled: value,
          tools: Object.fromEntries(cat.tools.map(t => [t, value])),
        },
      };
    });
  };

  const toggleDiscoveredTool = (catKey: string, toolName: string, value: boolean) => {
    setDiscoveredTools(prev => {
      const updated = { ...prev[catKey].tools, [toolName]: value };
      return {
        ...prev,
        [catKey]: { enabled: Object.values(updated).some(Boolean), tools: updated },
      };
    });
  };

  const toggleExpanded = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  const onSubmit = async () => {
    setIsSaving(true);
    setSaveStatus(null);
    try {
      await updatePlugin(plugin.meta.id, {
        enabled,
        pinned,
        jsonData: {
          ...jsonData,
          tools: { ...tools, ...discoveredTools },
          maxToolIterations: Math.min(100, Math.max(1, maxToolIterations)),
        },
      });
      setSaveStatus('success');
      setSaveMessage('Agent settings saved successfully.');
    } catch (err: any) {
      setSaveStatus('error');
      setSaveMessage(err?.data?.message || 'Failed to save configuration.');
    } finally {
      setIsSaving(false);
    }
  };

  // ── Render helpers ───────────────────────────────────────────────────────────

  const renderToolList = (
    toolNames: string[],
    isChecked: (n: string) => boolean,
    isDisabled: boolean,
    onToggle: (n: string, v: boolean) => void,
    categoryKey: string
  ) => {
    const search = searchTerms[categoryKey] ?? '';
    const filtered = search
      ? toolNames.filter(t => t.toLowerCase().includes(search.toLowerCase()))
      : toolNames;

    return (
      <div className={s.toolBody}>
        {toolNames.length > SEARCH_THRESHOLD && (
          <Input
            placeholder="Filter tools…"
            value={search}
            onChange={e => setSearchTerms(prev => ({ ...prev, [categoryKey]: (e.target as HTMLInputElement).value }))}
            prefix={<Icon name="search" />}
            className={s.searchInput}
            data-testid={`tool-search-${categoryKey}`}
          />
        )}
        <div className={s.toolList} data-testid={`tool-list-${categoryKey}`}>
          {filtered.length === 0 && (
            <span className={s.noResults}>No tools match "{search}"</span>
          )}
          {filtered.map(toolName => (
            <div key={toolName} className={s.toolRow}>
              <Checkbox
                label={toolName}
                checked={isChecked(toolName)}
                disabled={isDisabled}
                onChange={e => onToggle(toolName, e.currentTarget.checked)}
                data-testid={`tool-checkbox-${toolName}`}
              />
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderCategoryCard = (
    key: string,
    label: string,
    toolNames: string[],
    isChecked: (n: string) => boolean,
    isCatEnabled: boolean,
    onCatToggle: (v: boolean) => void,
    onToolToggle: (name: string, v: boolean) => void,
    testId: string
  ) => {
    const isExp = expanded[key] ?? false;
    return (
      <div key={key} className={s.categoryCard} data-testid={testId}>
        <div
          className={s.categoryHeader}
          onClick={() => toggleExpanded(key)}
          data-testid={`tool-category-header-${key}`}
        >
          <Icon name={isExp ? 'angle-down' : 'angle-right'} className={s.chevron} />
          <span onClick={e => e.stopPropagation()}>
            <Checkbox
              label={label}
              checked={isCatEnabled}
              onChange={e => onCatToggle(e.currentTarget.checked)}
              data-testid={`tool-category-checkbox-${key}`}
            />
          </span>
          <span className={s.toolCountBadge}>{toolNames.length} tools</span>
        </div>
        {isExp && renderToolList(toolNames, isChecked, !isCatEnabled, onToolToggle, key)}
      </div>
    );
  };

  const ossDiscovered = DISCOVERED_CATEGORIES.filter(
    c => c.tier === 'oss' && discoveredTools[c.key]
  );
  const cloudDiscovered = DISCOVERED_CATEGORIES.filter(
    c => c.tier === 'cloud' && discoveredTools[c.key]
  );

  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit(); }}>

      <FieldSet label="Tool Access">
        <p className={s.sectionDescription}>
          Control which MCP tool categories are available to the AI agent.
          Disabled categories reduce token usage and prevent the agent from calling
          tools the user should not access.
        </p>

        {/* ── Grafana OSS ───────────────────────────────────────────────── */}
        <div className={s.tierHeader} data-testid="tier-header-oss">
          <span className={s.tierLabel}>Grafana OSS</span>
          <span className={s.tierRule} />
        </div>

        {/* Fixed 4 categories */}
        {(Object.keys(TOOL_CATEGORIES) as string[]).map(category =>
          renderCategoryCard(
            category,
            FIXED_CATEGORY_LABELS[category] ?? category,
            TOOL_CATEGORIES[category as keyof typeof TOOL_CATEGORIES],
            (n) => tools[category]?.tools[n] !== false,
            tools[category]?.enabled ?? true,
            (v) => toggleFixed(category, v),
            (n, v) => toggleFixedTool(category, n, v),
            `tool-category-${category}`
          )
        )}

        {/* Discovered OSS categories */}
        {ossDiscovered.map(cat =>
          renderCategoryCard(
            cat.key,
            cat.label,
            cat.tools.filter(t => discoveredTools[cat.key]?.tools[t] !== undefined || true),
            (n) => discoveredTools[cat.key]?.tools[n] !== false,
            discoveredTools[cat.key]?.enabled ?? true,
            (v) => toggleDiscovered(cat.key, v),
            (n, v) => toggleDiscoveredTool(cat.key, n, v),
            `tool-category-${cat.key}`
          )
        )}

        {/* ── Grafana Cloud / Enterprise ────────────────────────────────── */}
        {cloudDiscovered.length > 0 && (
          <>
            <div className={s.tierHeader} data-testid="tier-header-cloud">
              <span className={s.tierLabel}>Grafana Cloud / Enterprise</span>
              <span className={s.tierRule} />
            </div>
            {cloudDiscovered.map(cat =>
              renderCategoryCard(
                cat.key,
                cat.label,
                cat.tools,
                (n) => discoveredTools[cat.key]?.tools[n] !== false,
                discoveredTools[cat.key]?.enabled ?? true,
                (v) => toggleDiscovered(cat.key, v),
                (n, v) => toggleDiscoveredTool(cat.key, n, v),
                `tool-category-${cat.key}`
              )
            )}
          </>
        )}

        {/* ── Unrecognised tools ────────────────────────────────────────── */}
        {unknownTools.length > 0 && (
          <>
            <div className={s.tierHeader} data-testid="tier-header-unknown">
              <span className={`${s.tierLabel} ${s.tierLabelMuted}`}>Unrecognised tools</span>
              <span className={s.tierRule} />
            </div>
            <div className={s.categoryCard} data-testid="tool-category-other">
              <div
                className={s.categoryHeader}
                onClick={() => toggleExpanded('other')}
                data-testid="tool-category-header-other"
              >
                <Icon name={expanded['other'] ? 'angle-down' : 'angle-right'} className={s.chevron} />
                <span className={s.otherLabel}>Other</span>
                <span className={s.toolCountBadge}>{unknownTools.length} tools</span>
              </div>
              {expanded['other'] && (
                <div className={s.toolBody}>
                  <p className={s.unknownNote}>
                    These tools were returned by the MCP server but are not yet categorised.
                    They are enabled by default.
                  </p>
                  {renderToolList(
                    unknownTools,
                    (n) => unknownEnabled[n] !== false,
                    false,
                    (n, v) => setUnknownEnabled(prev => ({ ...prev, [n]: v })),
                    'other'
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </FieldSet>

      {/* ── Agent Behaviour ─────────────────────────────────────────────── */}
      <FieldSet label="Agent Behaviour" className={s.marginTop}>
        <Field
          label="Max tool call steps per message"
          description="Limits how many consecutive tool calls each agent step can make. The dashboard agent automatically gets twice this limit. Range: 1–100."
        >
          <Input
            type="number"
            min={1}
            max={100}
            value={maxToolIterations}
            onChange={e =>
              setMaxToolIterations(parseInt((e.target as HTMLInputElement).value, 10) || DEFAULT_MAX_ITERATIONS)
            }
            width={8}
            data-testid="max-tool-iterations-input"
          />
        </Field>
      </FieldSet>

      <div className={s.marginTop}>
        {saveStatus && (
          <div style={{ marginBottom: '16px' }}>
            <Alert severity={saveStatus} title={saveStatus === 'success' ? 'Success' : 'Error'}>
              {saveMessage}
            </Alert>
          </div>
        )}
        <Button type="submit" disabled={isSaving}>
          {isSaving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </form>
  );
};

export default AgentConfig;

// ─── Styles ───────────────────────────────────────────────────────────────────

const getStyles = (theme: GrafanaTheme2) => ({
  marginTop: css`margin-top: ${theme.spacing(3)};`,

  sectionDescription: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    margin-bottom: ${theme.spacing(2)};
    margin-top: 0;
  `,

  // Tier section divider
  tierHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    margin: ${theme.spacing(2)} 0 ${theme.spacing(1)} 0;
    &:first-of-type { margin-top: 0; }
  `,
  tierLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  `,
  tierLabelMuted: css`
    color: ${theme.colors.text.disabled};
  `,
  tierRule: css`
    flex: 1;
    height: 1px;
    background: ${theme.colors.border.weak};
  `,

  // Category card
  categoryCard: css`
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    margin-bottom: ${theme.spacing(1)};
    overflow: hidden;
  `,
  categoryHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1.25)} ${theme.spacing(1.5)};
    cursor: pointer;
    user-select: none;
    background: ${theme.colors.background.secondary};
    &:hover { background: ${theme.colors.action.hover}; }
  `,
  chevron: css`
    color: ${theme.colors.text.secondary};
    flex-shrink: 0;
  `,
  toolCountBadge: css`
    margin-left: auto;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    flex-shrink: 0;
  `,
  otherLabel: css`
    font-size: ${theme.typography.body.fontSize};
    color: ${theme.colors.text.primary};
  `,

  // Tool body (expanded)
  toolBody: css`
    background: ${theme.colors.background.primary};
    border-top: 1px solid ${theme.colors.border.weak};
    padding: ${theme.spacing(1.5)};
  `,
  searchInput: css`margin-bottom: ${theme.spacing(1.5)};`,
  toolList: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.75)};
  `,
  toolRow: css`
    display: flex;
    align-items: center;
    padding: ${theme.spacing(0.25)} ${theme.spacing(0.5)};
    border-radius: 4px;
    &:hover { background: ${theme.colors.action.hover}; }
    label {
      font-family: ${theme.typography.fontFamilyMonospace};
      font-size: ${theme.typography.bodySmall.fontSize};
      color: ${theme.colors.text.primary};
      align-items: flex-start !important;
    }
  `,
  noResults: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-style: italic;
    padding: ${theme.spacing(0.5)} 0;
  `,
  unknownNote: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    margin: 0 0 ${theme.spacing(1)} 0;
    font-style: italic;
  `,
});

const updatePlugin = async (pluginId: string, data: Partial<PluginMeta>) => {
  const response = await getBackendSrv().fetch({
    url: `/api/plugins/${pluginId}/settings`,
    method: 'POST',
    data,
  });
  return lastValueFrom(response);
};
