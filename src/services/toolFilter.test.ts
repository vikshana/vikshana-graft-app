import { filterTools, getDefaultToolsConfig, TOOL_CATEGORIES } from './toolFilter';
import type { ToolsConfig } from '../types/settings.types';

// Helper: build an OpenAI-format tool object
const tool = (name: string) => ({ type: 'function', function: { name } });

describe('filterTools', () => {
    describe('when config is undefined', () => {
        it('returns all tools unfiltered', () => {
            const tools = [tool('query_loki_logs'), tool('query_prometheus'), tool('some_unknown_tool')];
            expect(filterTools(tools, undefined)).toEqual(tools);
        });

        it('returns empty array for empty input', () => {
            expect(filterTools([], undefined)).toEqual([]);
        });
    });

    describe('when config is provided', () => {
        it('returns only tools in enabled categories', () => {
            const config: ToolsConfig = {
                ...getDefaultToolsConfig(),
                prometheus: { enabled: false, tools: Object.fromEntries(TOOL_CATEGORIES.prometheus.map(t => [t, false])) },
            };
            const tools = [
                tool('query_prometheus'),
                tool('query_loki_logs'),
                tool('get_dashboard_by_uid'),
            ];
            const result = filterTools(tools, config);
            expect(result.map(t => t.function.name)).toEqual(['query_loki_logs', 'get_dashboard_by_uid']);
        });

        it('excludes all tools in a disabled category regardless of per-tool setting', () => {
            const config: ToolsConfig = {
                ...getDefaultToolsConfig(),
                loki: { enabled: false, tools: { query_loki_logs: true } }, // per-tool says enabled, category says disabled
            };
            const tools = [tool('query_loki_logs'), tool('query_prometheus')];
            const result = filterTools(tools, config);
            expect(result.map(t => t.function.name)).toEqual(['query_prometheus']);
        });

        it('excludes an individually disabled tool within an enabled category', () => {
            const config: ToolsConfig = {
                ...getDefaultToolsConfig(),
                prometheus: {
                    enabled: true,
                    tools: {
                        ...Object.fromEntries(TOOL_CATEGORIES.prometheus.map(t => [t, true])),
                        query_prometheus: false,
                    },
                },
            };
            const tools = TOOL_CATEGORIES.prometheus.map(tool);
            const result = filterTools(tools, config);
            expect(result.map(t => t.function.name)).not.toContain('query_prometheus');
            expect(result.map(t => t.function.name)).toContain('query_prometheus_histogram');
        });

        it('passes through tools not in any config category (unrecognised tools)', () => {
            const config = getDefaultToolsConfig();
            const tools = [
                tool('query_loki_logs'),
                tool('some_future_tool_not_in_categories'),
            ];
            const result = filterTools(tools, config);
            expect(result.map(t => t.function.name)).toContain('some_future_tool_not_in_categories');
        });

        it('filters tools in dynamic discovered categories (e.g. alerting)', () => {
            const config: ToolsConfig = {
                ...getDefaultToolsConfig(),
                alerting: {
                    enabled: false,
                    tools: { alerting_manage_routing: false, alerting_manage_rules: false },
                },
            };
            const tools = [
                tool('alerting_manage_routing'),
                tool('query_loki_logs'),
            ];
            const result = filterTools(tools, config);
            expect(result.map(t => t.function.name)).not.toContain('alerting_manage_routing');
            expect(result.map(t => t.function.name)).toContain('query_loki_logs');
        });

        it('honours per-tool disable within a dynamic category', () => {
            const config: ToolsConfig = {
                ...getDefaultToolsConfig(),
                cloudwatch: {
                    enabled: true,
                    tools: {
                        query_cloudwatch: false,
                        list_cloudwatch_metrics: true,
                        list_cloudwatch_namespaces: true,
                    },
                },
            };
            const tools = [
                tool('query_cloudwatch'),
                tool('list_cloudwatch_metrics'),
            ];
            const result = filterTools(tools, config);
            expect(result.map(t => t.function.name)).not.toContain('query_cloudwatch');
            expect(result.map(t => t.function.name)).toContain('list_cloudwatch_metrics');
        });

        it('tool not in any config category passes through even with dynamic categories present', () => {
            const config: ToolsConfig = {
                ...getDefaultToolsConfig(),
                alerting: { enabled: true, tools: { alerting_manage_routing: true } },
            };
            const tools = [tool('some_brand_new_tool')];
            const result = filterTools(tools, config);
            expect(result).toHaveLength(1);
        });

        it('handles tools with no function.name gracefully', () => {
            const config = getDefaultToolsConfig();
            const malformed = [{ type: 'function', function: {} }, tool('query_loki_logs')];
            const result = filterTools(malformed, config);
            expect(result).toHaveLength(1);
            expect(result[0].function.name).toBe('query_loki_logs');
        });
    });
});

describe('getDefaultToolsConfig', () => {
    it('enables all known categories', () => {
        const config = getDefaultToolsConfig();
        for (const cat of Object.keys(TOOL_CATEGORIES) as Array<keyof ToolsConfig>) {
            expect(config[cat].enabled).toBe(true);
        }
    });

    it('enables all tools within each category', () => {
        const config = getDefaultToolsConfig();
        for (const [cat, tools] of Object.entries(TOOL_CATEGORIES) as [keyof ToolsConfig, string[]][]) {
            for (const toolName of tools) {
                expect(config[cat].tools[toolName]).toBe(true);
            }
        }
    });

    it('returns independent copies on each call', () => {
        const a = getDefaultToolsConfig();
        const b = getDefaultToolsConfig();
        a.loki.enabled = false;
        expect(b.loki.enabled).toBe(true);
    });
});

describe('TOOL_CATEGORIES', () => {
    it('contains loki, prometheus, dashboards, datasources', () => {
        expect(Object.keys(TOOL_CATEGORIES)).toEqual(
            expect.arrayContaining(['loki', 'prometheus', 'dashboards', 'datasources'])
        );
    });

    it('each category has at least one tool', () => {
        for (const tools of Object.values(TOOL_CATEGORIES)) {
            expect(tools.length).toBeGreaterThan(0);
        }
    });
});
