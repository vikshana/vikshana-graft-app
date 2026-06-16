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
import type { ToolsConfig, AppPluginSettings } from '../../../types/settings.types';

export interface AgentConfigProps extends PluginConfigPageProps<AppPluginMeta<AppPluginSettings>> { }

// Show search input inside a category when it has more than this many tools
const SEARCH_THRESHOLD = 5;

const DEFAULT_MAX_ITERATIONS = 50;

const CATEGORY_LABELS: Record<keyof ToolsConfig, string> = {
  loki: 'Loki (log queries)',
  prometheus: 'Prometheus (metrics queries)',
  dashboards: 'Dashboards (create, edit, search)',
  datasources: 'Datasources (list and look up datasources)',
};

function mergeDiscoveredTools(
  names: string[]
): string[] {
  const known = new Set(Object.values(TOOL_CATEGORIES).flat());
  return names.filter(n => !known.has(n));
}

type State = {
  tools: ToolsConfig;
  maxToolIterations: number;
};

const AgentConfig = ({ plugin }: AgentConfigProps) => {
  const s = useStyles2(getStyles);
  const { enabled, pinned, jsonData } = plugin.meta;

  const [state, setState] = useState<State>({
    tools: jsonData?.tools || getDefaultToolsConfig(),
    maxToolIterations: jsonData?.maxToolIterations ?? DEFAULT_MAX_ITERATIONS,
  });

  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [saveMessage, setSaveMessage] = useState<string>('');

  // Per-category expand state
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Per-category search filter
  const [searchTerms, setSearchTerms] = useState<Record<string, string>>({});

  // Live-discovered tools from the /tools backend proxy
  const [otherTools, setOtherTools] = useState<string[]>([]);
  const [otherToolsEnabled, setOtherToolsEnabled] = useState<Record<string, boolean>>({});

  useEffect(() => {
    getBackendSrv()
      .get(`/api/plugins/${plugin.meta.id}/resources/tools`)
      .then((resp: any) => {
        const tools: Array<{ name: string }> = resp?.tools ?? [];
        const names = tools.map((t: { name: string }) => t.name);
        const discovered = mergeDiscoveredTools(names);
        setOtherTools(discovered);
        const defaults: Record<string, boolean> = {};
        for (const name of discovered) {
          defaults[name] = true;
        }
        setOtherToolsEnabled(defaults);
      })
      .catch(() => { /* MCP server unreachable — TOOL_CATEGORIES is the fallback */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Category toggle handlers ──────────────────────────────────────────────

  const toggleCategory = (category: keyof ToolsConfig, value: boolean) => {
    setState(prev => ({
      ...prev,
      tools: {
        ...prev.tools,
        [category]: {
          enabled: value,
          tools: Object.fromEntries(
            TOOL_CATEGORIES[category].map(t => [t, value])
          ),
        },
      },
    }));
  };

  const toggleTool = (category: keyof ToolsConfig, toolName: string, value: boolean) => {
    setState(prev => {
      const updatedTools = { ...prev.tools[category].tools, [toolName]: value };
      const anyEnabled = Object.values(updatedTools).some(Boolean);
      return {
        ...prev,
        tools: {
          ...prev.tools,
          [category]: { enabled: anyEnabled, tools: updatedTools },
        },
      };
    });
  };

  const toggleExpanded = (key: string) => {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // ── Save ──────────────────────────────────────────────────────────────────

  const onSubmit = async () => {
    setIsSaving(true);
    setSaveStatus(null);

    const iterationsValue = Math.min(100, Math.max(1, state.maxToolIterations));

    try {
      // Merge with existing jsonData to preserve promptLibrary from the Configuration tab
      await updatePlugin(plugin.meta.id, {
        enabled,
        pinned,
        jsonData: {
          ...jsonData,
          tools: state.tools,
          maxToolIterations: iterationsValue,
        },
      });
      setSaveStatus('success');
      setSaveMessage('Agent settings saved successfully.');
    } catch (error: any) {
      console.error('Error saving agent configuration', error);
      setSaveStatus('error');
      setSaveMessage(error?.data?.message || 'Failed to save configuration.');
    } finally {
      setIsSaving(false);
    }
  };

  // ── Render helpers ────────────────────────────────────────────────────────

  const renderToolList = (
    tools: string[],
    isChecked: (name: string) => boolean,
    isDisabled: boolean,
    onToggle: (name: string, value: boolean) => void,
    categoryKey: string
  ) => {
    const search = searchTerms[categoryKey] ?? '';
    const filtered = search
      ? tools.filter(t => t.toLowerCase().includes(search.toLowerCase()))
      : tools;

    return (
      <div className={s.toolBody}>
        {tools.length > SEARCH_THRESHOLD && (
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

  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit(); }}>

      {/* Tool Access */}
      <FieldSet label="Tool Access">
        <p className={s.sectionDescription}>
          Control which MCP tool categories are available to the AI agent. Disabled categories
          reduce token usage and prevent the agent from calling tools the user should not access.
        </p>

        {(Object.keys(TOOL_CATEGORIES) as Array<keyof ToolsConfig>).map(category => {
          const catConfig = state.tools[category];
          const isExpanded = expanded[category] ?? false;
          const toolCount = TOOL_CATEGORIES[category].length;

          return (
            <div key={category} className={s.categoryCard} data-testid={`tool-category-${category}`}>
              {/* Header row — click expands/collapses */}
              <div
                className={s.categoryHeader}
                onClick={() => toggleExpanded(category)}
                data-testid={`tool-category-header-${category}`}
              >
                <Icon
                  name={isExpanded ? 'angle-down' : 'angle-right'}
                  className={s.chevron}
                />
                {/* Checkbox stopPropagation so it doesn't also toggle expand */}
                <span onClick={e => e.stopPropagation()}>
                  <Checkbox
                    label={CATEGORY_LABELS[category]}
                    checked={catConfig.enabled}
                    onChange={e => toggleCategory(category, e.currentTarget.checked)}
                    data-testid={`tool-category-checkbox-${category}`}
                  />
                </span>
                <span className={s.toolCountBadge}>{toolCount} tools</span>
              </div>

              {/* Expandable body */}
              {isExpanded && renderToolList(
                TOOL_CATEGORIES[category],
                (name) => catConfig.tools[name] !== false,
                !catConfig.enabled,
                (name, value) => toggleTool(category, name, value),
                category
              )}
            </div>
          );
        })}

        {/* Other (discovered from MCP server) */}
        {otherTools.length > 0 && (
          <div className={s.categoryCard} data-testid="tool-category-other">
            <div
              className={s.categoryHeader}
              onClick={() => toggleExpanded('other')}
              data-testid="tool-category-header-other"
            >
              <Icon
                name={expanded['other'] ? 'angle-down' : 'angle-right'}
                className={s.chevron}
              />
              <span className={s.otherLabel}>Other (discovered from MCP server)</span>
              <span className={s.toolCountBadge}>{otherTools.length} tools</span>
            </div>

            {expanded['other'] && renderToolList(
              otherTools,
              (name) => otherToolsEnabled[name] !== false,
              false,
              (name, value) => setOtherToolsEnabled(prev => ({ ...prev, [name]: value })),
              'other'
            )}
          </div>
        )}
      </FieldSet>

      {/* Agent Behaviour */}
      <FieldSet label="Agent Behaviour" className={s.marginTop}>
        <Field
          label="Max tool call steps per message"
          description="Limits how many consecutive tool calls each agent step can make. The dashboard agent automatically gets twice this limit. Range: 1–100."
        >
          <Input
            type="number"
            min={1}
            max={100}
            value={state.maxToolIterations}
            onChange={e =>
              setState(prev => ({
                ...prev,
                maxToolIterations: parseInt(e.currentTarget.value, 10) || DEFAULT_MAX_ITERATIONS,
              }))
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

const getStyles = (theme: GrafanaTheme2) => ({
  marginTop: css`
    margin-top: ${theme.spacing(3)};
  `,
  sectionDescription: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    margin-bottom: ${theme.spacing(2)};
    margin-top: 0;
  `,

  // Category card
  categoryCard: css`
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    margin-bottom: ${theme.spacing(1.5)};
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
    &:hover {
      background: ${theme.colors.action.hover};
    }
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

  // Tool body (expanded content)
  toolBody: css`
    background: ${theme.colors.background.primary};
    border-top: 1px solid ${theme.colors.border.weak};
    padding: ${theme.spacing(1.5)};
  `,
  searchInput: css`
    margin-bottom: ${theme.spacing(1.5)};
  `,
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
    &:hover {
      background: ${theme.colors.action.hover};
    }
    /* Override Grafana Checkbox centering — force left-align */
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
});

const updatePlugin = async (pluginId: string, data: Partial<PluginMeta>) => {
  const response = await getBackendSrv().fetch({
    url: `/api/plugins/${pluginId}/settings`,
    method: 'POST',
    data,
  });
  return lastValueFrom(response);
};
