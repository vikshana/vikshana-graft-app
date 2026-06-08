import { tryInterceptRenameBeforeLlm } from './renameLlmGuard';
import type { Message } from '../types/llm.types';

describe('renameLlmGuard', () => {
    const prompt =
        'Rename the dashboard for the 2505-200033 machine to be NewMachine instead of Keysight';

    it('returns clarification when rename is too vague', async () => {
        let reply = '';
        const result = await tryInterceptRenameBeforeLlm(
            [{ role: 'user', content: 'Rename the dashboard to be NewMachine' }],
            undefined,
            (content) => {
                reply = content;
            }
        );
        expect(result).toContain('Need clarification');
        expect(reply).toContain('Need clarification');
    });

    it('returns MCP error when client is missing', async () => {
        let reply = '';
        const result = await tryInterceptRenameBeforeLlm(
            [{ role: 'user', content: prompt }],
            undefined,
            (content) => {
                reply = content;
            }
        );
        expect(result).toContain('Could not rename dashboard');
        expect(reply).toContain('MCP tools are not connected');
    });

    it('runs programmatic rename when MCP client is available', async () => {
        const messages: Message[] = [{ role: 'user', content: prompt }];
        const mcpClient = {
            callTool: jest.fn(async ({ name, arguments: args }: { name: string; arguments: unknown }) => {
                if (name === 'search_dashboards') {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: '| # | Title | uid |\n| 1 | 2505-200033 / Keysight | `abc123` |',
                            },
                        ],
                    };
                }
                if (name === 'get_dashboard_by_uid') {
                    const uid = (args as { uid?: string }).uid ?? 'abc123';
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    dashboard: {
                                        uid,
                                        title:
                                            uid === 'abc123'
                                                ? '2505-200033 / Keysight'
                                                : '2505-200033 / NewMachine',
                                        version: 3,
                                        panels: [],
                                    },
                                }),
                            },
                        ],
                    };
                }
                if (name === 'update_dashboard') {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ uid: 'abc123', version: 4 }) }],
                    };
                }
                throw new Error(`unexpected tool ${name}: ${JSON.stringify(args)}`);
            }),
        };

        let reply = '';
        let tools: unknown;
        const result = await tryInterceptRenameBeforeLlm(messages, mcpClient, (content, toolExecutions) => {
            reply = content;
            tools = toolExecutions;
        });

        expect(result).toContain('Dashboard renamed');
        expect(reply).toContain('2505-200033 / NewMachine');
        expect(tools).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'search_dashboards', status: 'success' }),
                expect.objectContaining({ name: 'update_dashboard', status: 'success' }),
            ])
        );
    });

    it('returns null for non-rename messages', async () => {
        const onUpdate = jest.fn();
        const result = await tryInterceptRenameBeforeLlm(
            [{ role: 'user', content: 'Fix panels on 2505-200033 / Keysight' }],
            {},
            onUpdate
        );
        expect(result).toBeNull();
        expect(onUpdate).not.toHaveBeenCalled();
    });

    it('runs programmatic panel rename for panel title prompts', async () => {
        const panelPrompt =
            'Rename the "Pressure Gauge" panel to "System Pressure" on dashboard UID = cfo0wckufbdhce.';
        const mcpClient = {
            callTool: jest.fn(async ({ name, arguments: args }: { name: string; arguments: unknown }) => {
                if (name === 'get_dashboard_by_uid') {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    dashboard: {
                                        uid: 'cfo0wckufbdhce',
                                        title: '2505-200033 / Keysight',
                                        version: 69,
                                        panels: [{ id: 10, title: 'Pressure Gauge', type: 'timeseries' }],
                                    },
                                }),
                            },
                        ],
                    };
                }
                if (name === 'update_dashboard') {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ uid: 'cfo0wckufbdhce', version: 70 }) }],
                    };
                }
                throw new Error(`unexpected tool ${name}: ${JSON.stringify(args)}`);
            }),
        };

        let reply = '';
        const result = await tryInterceptRenameBeforeLlm(
            [{ role: 'user', content: panelPrompt }],
            mcpClient,
            (content) => {
                reply = content;
            }
        );

        expect(result).toContain('Panel renamed');
        expect(reply).toContain('Pressure Gauge');
        expect(reply).toContain('System Pressure');
        expect(reply).toContain('title unchanged');
        expect(reply).not.toContain('Dashboard renamed');
    });
});
