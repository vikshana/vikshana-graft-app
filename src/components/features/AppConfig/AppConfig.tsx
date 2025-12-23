// External libraries
import React, { useState } from 'react';
import { lastValueFrom } from 'rxjs';

// Grafana packages
import { AppPluginMeta, GrafanaTheme2, PluginConfigPageProps, PluginMeta } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import {
  Alert,
  Button,
  Field,
  FieldSet,
  FileUpload,
  useStyles2,
} from '@grafana/ui';
import { css } from '@emotion/css';
import { validatePromptYaml, dumpPromptYaml } from '../../../utils/promptValidation';
import { CategoryDef } from '../../../types/prompt.types';
import { PRE_CONFIGURED_PROMPTS } from '../../../data/prompts';
import { promptLibraryService } from '../../../services/promptLibrary';

/**
 * Plugin settings stored in Grafana
 * Model configuration has been moved to Grafana LLM plugin - only prompt library remains
 */
type AppPluginSettings = {
  promptLibrary?: CategoryDef[];
};

/**
 * Component state
 */
type State = {
  promptLibrary: CategoryDef[];
};

export interface AppConfigProps extends PluginConfigPageProps<AppPluginMeta<AppPluginSettings>> { }

const AppConfig = ({ plugin }: AppConfigProps) => {
  const s = useStyles2(getStyles);
  const { enabled, pinned, jsonData } = plugin.meta;
  const [state, setState] = useState<State>({
    promptLibrary: jsonData?.promptLibrary || [],
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [saveMessage, setSaveMessage] = useState<string>('');
  const [promptUploadError, setPromptUploadError] = useState<string | null>(null);
  const [promptUploadSuccess, setPromptUploadSuccess] = useState<string | null>(null);

  const onPromptFileLoad = (event: React.FormEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const parsed = validatePromptYaml(content);
        setState({
          ...state,
          promptLibrary: parsed,
        });
        setPromptUploadError(null);
        setPromptUploadSuccess(`Successfully loaded ${parsed.length} categories with ${parsed.reduce((acc: number, cat: CategoryDef) => acc + cat.subCategories.reduce((sAcc: number, sub: any) => sAcc + sub.prompts.length, 0), 0)} prompts.`);
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
      // Use uploaded prompts
      promptsToExport = state.promptLibrary;
    } else {
      // Convert default prompts to CategoryDef format
      promptsToExport = Object.entries(PRE_CONFIGURED_PROMPTS).map(([categoryName, subCats]) => ({
        id: categoryName.toLowerCase().replace(/\s+/g, '_'),
        name: categoryName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        subCategories: Object.entries(subCats).map(([subCatName, prompts]) => ({
          id: subCatName.toLowerCase().replace(/\s+/g, '_'),
          name: subCatName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
          prompts: prompts.map((content, idx) => ({
            name: `Prompt ${idx + 1}`,
            content
          }))
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

  const onSubmit = async () => {
    setIsSaving(true);
    setSaveStatus(null);

    try {
      await updatePlugin(plugin.meta.id, {
        enabled,
        pinned,
        jsonData: {
          promptLibrary: state.promptLibrary,
        },
      });

      // Update the promptLibraryService with the new prompts
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
        . This page only configures the Prompt Library.
      </Alert>

      {/* Prompt Library Configuration */}
      <FieldSet label="Prompt Library Configuration" className={s.marginTop}>
        <Field label="Upload Prompt Library" description="Upload a YAML file containing prompt categories and prompts">
          <div data-testid="prompt-library-upload-container">
            <FileUpload
              onFileUpload={onPromptFileLoad}
              accept=".yaml,.yml"
            />
            <div style={{ marginTop: '16px' }}>
              <Button variant="secondary" onClick={onDownloadPrompts} type="button">
                Download Current Config
              </Button>
            </div>
          </div>
        </Field>
        {promptUploadError && (
          <Alert severity="error" title="Upload Failed">
            {promptUploadError}
          </Alert>
        )}
        {promptUploadSuccess && (
          <Alert severity="success" title="Upload Successful">
            {promptUploadSuccess}
          </Alert>
        )}
        {state.promptLibrary && state.promptLibrary.length > 0 && !promptUploadSuccess && (
          <div style={{ marginBottom: '16px' }}>
            Currently loaded: {state.promptLibrary.length} categories with {state.promptLibrary.reduce((acc: number, cat: CategoryDef) => acc + cat.subCategories.reduce((sAcc: number, sub: any) => sAcc + sub.prompts.length, 0), 0)} prompts.
          </div>
        )}
      </FieldSet>

      <div className={s.marginTop}>
        {saveStatus && (
          <div style={{ marginBottom: '16px' }}>
            <Alert
              severity={saveStatus}
              title={saveStatus === 'success' ? 'Success' : 'Error'}
            >
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
});


const updatePlugin = async (pluginId: string, data: Partial<PluginMeta>) => {
  const response = await getBackendSrv().fetch({
    url: `/api/plugins/${pluginId}/settings`,
    method: 'POST',
    data,
  });

  return lastValueFrom(response);
};
