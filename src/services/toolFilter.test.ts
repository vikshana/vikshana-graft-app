import { filterTools, filterToolsForReadOnlyIntent } from './toolFilter';

function tool(name: string) {
    return { function: { name } };
}

describe('filterToolsForReadOnlyIntent', () => {
    it('removes update_dashboard for read-only turns', () => {
        const tools = [
            tool('get_dashboard_by_uid'),
            tool('update_dashboard'),
            tool('query_prometheus'),
        ];
        const filtered = filterToolsForReadOnlyIntent(tools);
        expect(filtered.map((t) => t.function.name)).toEqual(['get_dashboard_by_uid', 'query_prometheus']);
    });

    it('filterTools still allows update_dashboard', () => {
        const tools = [tool('get_dashboard_by_uid'), tool('update_dashboard')];
        expect(filterTools(tools).map((t) => t.function.name)).toContain('update_dashboard');
    });
});
