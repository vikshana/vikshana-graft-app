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
  Collapse,
  Field,
  FieldSet,
  FileUpload,
  Input,
  useStyles2,
} from '@grafana/ui';
import { css } from '@emotion/css';
import { validatePromptYaml, dumpPromptYaml } from '../../../utils/promptValidation';
import { CategoryDef } from '../../../types/prompt.types';
import { PRE_CONFIGURED_PROMPTS } from '../../../data/prompts';
import { promptLibraryService } from '../../../services/promptLibrary';
import { TOOL_CATEGORIES, getDefaultToolsConfig } from '../../../services/toolFilter';
import type { ToolsConfig, AppPluginSettings } from '../../../types/settings.types';

export interface AppConfigProps extends PluginConfigPageProps<AppPluginMeta<AppPluginSettings>> { }

const CATEGORY_LABELS: Record<keyof ToolsConfig, string> = {
  loki: 'Loki (log queries)',
  prometheus: 'Prometheus (metrics queries)',
  dashboards: 'Dashboards (create, edit, search)',
  datasources: 'Datasources (list and look up datasources)',
};

const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Merges live-discovered tool names (from the /tools backend route) into the
 * ToolsConfig. Any tool not in TOOL_CATEGORIES is placed in an "other" bucket
 * that is handled by the UI separately.
 */
function mergeDiscoveredTools(
  config: ToolsConfig,
  discovered: string[]
): { config: ToolsConfig; otherTools: string[] } {
  const knownTools = new Set(Object.values(TOOL_CATEGORIES).flat());
  const otherTools = discovered.filter(name => !knownTools.has(name));
  return { config, otherTools };
}

type State = {
  promptLibrary: CategoryDef[];
  tools: ToolsConfig;
  maxToolIterations: number;
};

const AppConfig = ({ plugin }: AppConfigProps) => {
  const s = useStyles2(getStyles);
  const { enabled, pinned, jsonData } = plugin.meta;

  const [state, setState] = useState<State>({
    promptLibrary: jsonData?.promptLibrary || [],
    tools: jsonData?.tools || getDefaultToolsConfig(),
    maxToolIterations: jsonData?.maxToolIterations ?? DEFAULT_MAX_ITERATIONS,
  });

  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [saveMessage, setSaveMessage] = useState<string>('');
  const [promptUploadError, setPromptUploadError] = useState<string | null>(null);
  const [promptUploadSuccess, setPromptUploadSuccess] = useState<string | null>(null);

  // Live-discovered tools from the /tools proxy (may include unknown tools)
  const [discoveredOtherTools, setDiscoveredOtherTools] = useState<string[]>([]);
  const [otherToolsEnabled, setOtherToolsEnabled] = useState<Record<string, boolean>>({});

  // Category collapse state
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});

  // Fetch live tool list from backend proxy on mount
  useEffect(() => {
    getBackendSrv()
      .get(`/api/plugins/${plugin.meta.id}/resources/tools`)
      .then((resp: any) => {
        const tools: Array<{ name: string }> = resp?.tools ?? [];
        const names = tools.map(t => t.name);
        const { otherTools } = mergeDiscoveredTools(state.tools, names);
        setDiscoveredOtherTools(otherTools);
        // Default: all discovered-other tools enabled unless already in saved config
        const defaults: Record<string, boolean> = {};
        for (const name of otherTools) {
          defaults[name] = true;
        }
        setOtherToolsEnabled(defaults);
      })
      .catch(() => {
        // MCP server unreachable — config page works fine with TOOL_CATEGORIES alone
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Prompt Library handlers ----

  const onPromptFileLoad = (event: React.FormEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) { return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const parsed = validatePromptYaml(content);
        setState(prev => ({ ...prev, promptLibrary: parsed }));
        setPromptUploadError(null);
        const totalPrompts = parsed.reduce(
          (acc: number, cat: CategoryDef) =>
            acc + cat.subCategories.reduce((sAcc: number, sub: any) => sAcc + sub.prompts.length, 0),
          0
        );
        setPromptUploadSuccess(`Successfully loaded ${parsed.length} categories with ${totalPrompts} prompts.`);
      } catch (err: any) {
        setPromptUploadError(err.message || 'Failed to parse YAML file');
        setPromptUploadSuccess(null);
      }
    };
    reader.readAsText(file);
  };

  const onDownloadPrompts = () => {
    let promptsToExport: CategoryDef[];
    if (state.promptLibrary && state.promptLibrary.length > 0) {
      promptsToExport = state.promptLibrary;
    } else {
      promptsToExport = Object.entries(PRE_CONFIGURED_PROMPTS).map(([categoryName, subCats]) => ({
        id: categoryName.toLowerCase().replace(/\s+/g, '_'),
        name: categoryName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        subCategories: Object.entries(subCats).map(([subCatName, prompts]) => ({
          id: subCatName.toLowerCase().replace(/\s+/g, '_'),
          name: subCatName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
          prompts: prompts.map((content, idx) => ({ name: `Prompt ${idx + 1}`, content }))
        }))
      }));
    }
    try {
      const yamlContent = dumpPromptYaml(promptsToExport);
      const blob = new Blob([yamlContent], { type: 'application/x-yaml' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'prompt-library.yaml';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to generate YAML', error);
      setPromptUploadError('Failed to generate YAML for download');
    }
  };

  // ---- Tool Access handlers ----

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
          [category]: {
            enabled: anyEnabled,
            tools: updatedTools,
          },
        },
      };
    });
  };

  const toggleExpanded = (category: string) => {
    setExpandedCategories(prev => ({ ...prev, [category]: !prev[category] }));
  };

  // ---- Save ----

  const onSubmit = async () => {
    setIsSaving(true);
    setSaveStatus(null);

    const iterationsValue = Math.min(25, Math.max(1, state.maxToolIterations));

    try {
      await updatePlugin(plugin.meta.id, {
        enabled,
        pinned,
        jsonData: {
          promptLibrary: state.promptLibrary,
          tools: state.tools,
          maxToolIterations: iterationsValue,
        },
      });

      if (state.promptLibrary && state.promptLibrary.length > 0) {
        promptLibraryService.setConfiguredPrompts(state.promptLibrary);
      }

      setSaveStatus('success');
      setSaveMessage('Configuration saved successfully.');
    } catch (error: any) {
      console.error('Error saving configuration', error);
      setSaveStatus('error');
      setSaveMessage(error?.data?.message || 'Failed to save configuration.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      {/* LLM Plugin Information Banner */}
      <Alert severity="info" title="Model Configuration">
        Model configuration (Standard and Deep Research) is managed through the{' '}
        <a href="/plugins/grafana-llm-app" style={{ textDecoration: 'underline' }}>
          Grafana LLM Plugin
        </a>
        . This page only configures the Prompt Library, Tool Access, and Agent Behaviour.
      </Alert>

      {/* Prompt Library Configuration */}
      <FieldSet label="Prompt Library Configuration" className={s.marginTop}>
        <Field label="Upload Prompt Library" description="Upload a YAML file containing prompt categories and prompts">
          <div data-testid="prompt-library-upload-container">
            <FileUpload onFileUpload={onPromptFileLoad} accept=".yaml,.yml" />
            <div style={{ marginTop: '16px' }}>
              <Button variant="secondary" onClick={onDownloadPrompts} type="button">
                Download Current Config
              </Button>
            </div>
          </div>
        </Field>
        {promptUploadError && (
          <Alert severity="error" title="Upload Failed">{promptUploadError}</Alert>
        )}
        {promptUploadSuccess && (
          <Alert severity="success" title="Upload Successful">{promptUploadSuccess}</Alert>
        )}
        {state.promptLibrary && state.promptLibrary.length > 0 && !promptUploadSuccess && (
          <div style={{ marginBottom: '16px' }}>
            Currently loaded: {state.promptLibrary.length} categories with{' '}
            {state.promptLibrary.reduce(
              (acc: number, cat: CategoryDef) =>
                acc + cat.subCategories.reduce((sAcc: number, sub: any) => sAcc + sub.prompts.length, 0),
              0
            )} prompts.
          </div>
        )}
      </FieldSet>

      {/* Tool Access Configuration */}
      <FieldSet label="Tool Access" className={s.marginTop}>
        <p className={s.description}>
          Control which MCP tool categories are available to the AI agent. Disabled categories reduce
          token usage and prevent the agent from calling tools the user should not access.
        </p>

        {(Object.keys(TOOL_CATEGORIES) as Array<keyof ToolsConfig>).map(category => {
          const catConfig = state.tools[category];
          const allEnabled = TOOL_CATEGORIES[category].every(t => catConfig.tools[t] !== false);
          const isExpanded = expandedCategories[category] ?? false;

          return (
            <div key={category} className={s.categoryRow} data-testid={`tool-category-${category}`}>
              <div className={s.categoryHeader}>
                <Checkbox
                  label={CATEGORY_LABELS[category]}
                  checked={catConfig.enabled}
                  onChange={e => toggleCategory(category, e.currentTarget.checked)}
                  data-testid={`tool-category-checkbox-${category}`}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => toggleExpanded(category)}
                  type="button"
                  className={s.expandButton}
                  data-testid={`tool-category-expand-${category}`}
                >
                  {isExpanded ? 'Hide tools' : 'Show tools'}
                </Button>
              </div>

              <Collapse isOpen={isExpanded} label="">
                <div className={s.toolList} data-testid={`tool-list-${category}`}>
                  {TOOL_CATEGORIES[category].map(toolName => (
                    <Checkbox
                      key={toolName}
                      label={toolName}
                      checked={catConfig.tools[toolName] !== false}
                      disabled={!catConfig.enabled}
                      onChange={e => toggleTool(category, toolName, e.currentTarget.checked)}
                      data-testid={`tool-checkbox-${toolName}`}
                    />
                  ))}
                </div>
              </Collapse>

              {!allEnabled && catConfig.enabled && (
                <p className={s.partialHint}>
                  Some tools in this category are disabled individually.
                </p>
              )}
            </div>
          );
        })}

        {discoveredOtherTools.length > 0 && (
          <div className={s.categoryRow} data-testid="tool-category-other">
            <div className={s.categoryHeader}>
              <span className={s.otherLabel}>Other (discovered from MCP server)</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => toggleExpanded('other')}
                type="button"
                className={s.expandButton}
                data-testid="tool-category-expand-other"
              >
                {expandedCategories['other'] ? 'Hide tools' : 'Show tools'}
              </Button>
            </div>
            <Collapse isOpen={expandedCategories['other'] ?? false} label="">
              <div className={s.toolList} data-testid="tool-list-other">
                {discoveredOtherTools.map(toolName => (
                  <Checkbox
                    key={toolName}
                    label={toolName}
                    checked={otherToolsEnabled[toolName] !== false}
                    onChange={e =>
                      setOtherToolsEnabled(prev => ({ ...prev, [toolName]: e.currentTarget.checked }))
                    }
                    data-testid={`tool-checkbox-${toolName}`}
                  />
                ))}
              </div>
            </Collapse>
          </div>
        )}
      </FieldSet>

      {/* Agent Behaviour */}
      <FieldSet label="Agent Behaviour" className={s.marginTop}>
        <Field
          label="Max tool call steps per message"
          description="Limits how many consecutive tool calls the agent can make before stopping. Higher values allow more complex tasks but increase response time. Range: 1–25."
        >
          <Input
            type="number"
            min={1}
            max={25}
            value={state.maxToolIterations}
            onChange={e =>
              setState(prev => ({ ...prev, maxToolIterations: parseInt(e.currentTarget.value, 10) || DEFAULT_MAX_ITERATIONS }))
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

export default AppConfig;

const getStyles = (theme: GrafanaTheme2) => ({
  colorWeak: css`
    color: ${theme.colors.text.secondary};
  `,
  marginTop: css`
    margin-top: ${theme.spacing(3)};
  `,
  description: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    margin-bottom: ${theme.spacing(2)};
  `,
  categoryRow: css`
    margin-bottom: ${theme.spacing(2)};
    padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
  `,
  categoryHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
  `,
  expandButton: css`
    margin-left: ${theme.spacing(2)};
  `,
  toolList: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1)} ${theme.spacing(2)};
  `,
  partialHint: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    margin-top: ${theme.spacing(0.5)};
    margin-bottom: 0;
  `,
  otherLabel: css`
    font-weight: ${theme.typography.fontWeightMedium};
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
