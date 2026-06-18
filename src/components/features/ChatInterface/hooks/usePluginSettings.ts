// External libraries
import { useState, useEffect } from 'react';

// Grafana packages
import { llm } from '@grafana/llm';
import { getBackendSrv } from '@grafana/runtime';

import type { ToolsConfig, AppPluginSettings } from '../../../../types/settings.types';
import { getDefaultToolsConfig } from '../../../../services/toolFilter';

const PLUGIN_ID = 'vikshana-graft-app';
const DEFAULT_MAX_ITERATIONS = 50;

/**
 * Return type for the plugin settings hook
 */
interface UsePluginSettingsReturn {
    /** Whether the Grafana LLM plugin is configured */
    llmConfigured: boolean;
    /** Whether the LLM plugin is healthy and operational */
    llmHealthy: boolean;
    /** Whether the standard (BASE) model is available and healthy */
    standardAvailable: boolean;
    /** Whether the thinking (LARGE) model is available and healthy */
    thinkingAvailable: boolean;
    /** Tool access configuration from plugin jsonData */
    toolsConfig: ToolsConfig;
    /** Maximum tool call iterations from plugin jsonData */
    maxToolIterations: number;
    /** Whether the hook is still loading */
    isLoading: boolean;
    /** Error message if health check failed */
    error: string | null;
}

/**
 * Custom hook that checks Grafana LLM plugin health AND loads this plugin's
 * jsonData settings (tool access config, max iterations, prompt library).
 *
 * Both requests run concurrently on mount.
 */
export const usePluginSettings = (): UsePluginSettingsReturn => {
    const [llmConfigured, setLlmConfigured] = useState(false);
    const [llmHealthy, setLlmHealthy] = useState(false);
    const [standardAvailable, setStandardAvailable] = useState(false);
    const [thinkingAvailable, setThinkingAvailable] = useState(false);
    const [toolsConfig, setToolsConfig] = useState<ToolsConfig>(getDefaultToolsConfig());
    const [maxToolIterations, setMaxToolIterations] = useState(DEFAULT_MAX_ITERATIONS);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const checkLLMHealth = async () => {
            try {
                const health = await llm.health();

                setLlmConfigured(health.configured);
                setLlmHealthy(health.ok);

                if (health.configured && health.ok && health.models) {
                    setStandardAvailable(health.models['base']?.ok ?? false);
                    setThinkingAvailable(health.models['large']?.ok ?? false);
                } else {
                    setStandardAvailable(false);
                    setThinkingAvailable(false);
                }

                if (health.error) {
                    setError(health.error);
                }
            } catch (e: any) {
                setLlmConfigured(false);
                setLlmHealthy(false);
                setStandardAvailable(false);
                setThinkingAvailable(false);
                setError(e.message || 'Failed to check LLM plugin health');
            }
        };

        const loadPluginSettings = async () => {
            try {
                const resp: AppPluginSettings = await getBackendSrv().get(
                    `/api/plugins/${PLUGIN_ID}/resources/settings`
                );
                if (resp?.tools) {
                    setToolsConfig(resp.tools);
                }
                if (resp?.maxToolIterations != null) {
                    setMaxToolIterations(resp.maxToolIterations);
                }
            } catch {
                // Settings endpoint unavailable — use defaults (all tools enabled)
            }
        };

        Promise.all([checkLLMHealth(), loadPluginSettings()]).finally(() => {
            setIsLoading(false);
        });
    }, []);

    return {
        llmConfigured,
        llmHealthy,
        standardAvailable,
        thinkingAvailable,
        toolsConfig,
        maxToolIterations,
        isLoading,
        error,
    };
};
