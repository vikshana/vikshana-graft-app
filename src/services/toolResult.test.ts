import { evaluateMcpToolResult, formatToolResultForLlm } from './toolResult';

describe('toolResult', () => {
    describe('evaluateMcpToolResult', () => {
        it('flags MCP isError responses', () => {
            const result = evaluateMcpToolResult('update_dashboard', {
                isError: true,
                content: [{ type: 'text', text: 'permission denied' }],
            });
            expect(result.ok).toBe(false);
        });

        it('accepts update_dashboard with uid and version', () => {
            const result = evaluateMcpToolResult(
                'update_dashboard',
                { content: [{ type: 'text', text: '{"uid":"abc","version":3,"status":"success"}' }] }
            );
            expect(result.ok).toBe(true);
            expect(result.summary).toContain('abc');
        });

        it('rejects update_dashboard without uid or version', () => {
            const result = evaluateMcpToolResult(
                'update_dashboard',
                { content: [{ type: 'text', text: '{"status":"success"}' }] }
            );
            expect(result.ok).toBe(false);
        });
    });

    describe('formatToolResultForLlm', () => {
        it('allows larger dashboard tool payloads', () => {
            const big = 'x'.repeat(50000);
            const formatted = formatToolResultForLlm('get_dashboard_by_uid', big);
            expect(formatted.length).toBeGreaterThan(4000);
            expect(formatted).not.toContain('truncated');
        });

        it('includes userReference for get_dashboard_summary', () => {
            const result = evaluateMcpToolResult(
                'get_dashboard_summary',
                {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                uid: 'dash1',
                                panels: [{ id: 2, title: 'T', type: 'stat' }],
                            }),
                        },
                    ],
                }
            );
            expect(result.userReference).toContain('dash1');
            expect(result.userReference).toContain('panelId');
        });

        it('truncates non-dashboard tools at default limit', () => {
            const big = 'y'.repeat(5000);
            const formatted = formatToolResultForLlm('query_prometheus', big);
            expect(formatted).toContain('truncated');
        });
    });
});
