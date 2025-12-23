// External libraries
import { useState, useEffect } from 'react';

// Grafana packages
import { llm } from '@grafana/llm';

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
    /** Whether the hook is still loading */
    isLoading: boolean;
    /** Error message if health check failed */
    error: string | null;
}

/**
 * Custom hook to check Grafana LLM plugin health and model availability
 *
 * Uses the @grafana/llm health API to determine which models are available.
 * This replaces the previous approach of checking Graft plugin backend endpoints.
 *
 * @returns LLM plugin status and model availability
 */
export const usePluginSettings = (): UsePluginSettingsReturn => {
    const [llmConfigured, setLlmConfigured] = useState(false);
    const [llmHealthy, setLlmHealthy] = useState(false);
    const [standardAvailable, setStandardAvailable] = useState(false);
    const [thinkingAvailable, setThinkingAvailable] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const checkLLMHealth = async () => {
            try {
                const health = await llm.health();

                setLlmConfigured(health.configured);
                setLlmHealthy(health.ok);

                if (health.configured && health.ok && health.models) {
                    // Check if base model (standard) is available
                    setStandardAvailable(health.models['base']?.ok ?? false);
                    // Check if large model (thinking/deep research) is available
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
            } finally {
                setIsLoading(false);
            }
        };

        checkLLMHealth();
    }, []);

    return {
        llmConfigured,
        llmHealthy,
        standardAvailable,
        thinkingAvailable,
        isLoading,
        error,
    };
};
