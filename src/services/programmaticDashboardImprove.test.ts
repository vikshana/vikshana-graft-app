import {
    applySafeStructuralImprovements,
    detectPendingSuggestions,
    findExactDuplicateTopLevelPanels,
    formatDashboardImproveReply,
    panelDataSignature,
    resolveTopLevelOverlaps,
    runProgrammaticDashboardImprove,
} from './programmaticDashboardImprove';

type PanelRecord = Record<string, unknown>;

function statPanel(id: number, title: string, gridPos: PanelRecord, expr = `expr-${title}`): PanelRecord {
    return {
        id,
        type: 'stat',
        title,
        gridPos,
        targets: [{ refId: 'A', expr }],
    };
}

describe('findExactDuplicateTopLevelPanels', () => {
    it('flags a later panel with the same title AND same data', () => {
        const panels = [
            statPanel(200, 'Pressure Gauge', { x: 0, y: 0, w: 6, h: 6 }, 'pressure'),
            statPanel(203, 'Pressure Gauge', { x: 6, y: 0, w: 6, h: 6 }, 'pressure'),
        ];
        const dupes = findExactDuplicateTopLevelPanels(panels);
        expect(dupes).toHaveLength(1);
        expect(dupes[0]).toMatchObject({ index: 1, id: 203, title: 'Pressure Gauge' });
    });

    it('does NOT flag same-title panels that pull different data', () => {
        const panels = [
            statPanel(1, 'Voltage', { x: 0, y: 0, w: 6, h: 6 }, 'module1'),
            statPanel(2, 'Voltage', { x: 6, y: 0, w: 6, h: 6 }, 'module2'),
        ];
        expect(findExactDuplicateTopLevelPanels(panels)).toHaveLength(0);
    });

    it('never flags row panels or untitled panels', () => {
        const panels = [
            { id: 1, type: 'row', title: 'Row', gridPos: { x: 0, y: 0, w: 24, h: 1 } },
            { id: 2, type: 'row', title: 'Row', gridPos: { x: 0, y: 1, w: 24, h: 1 } },
            { id: 3, type: 'stat', title: '', gridPos: { x: 0, y: 2, w: 6, h: 6 } },
            { id: 4, type: 'stat', title: '', gridPos: { x: 6, y: 2, w: 6, h: 6 } },
        ];
        expect(findExactDuplicateTopLevelPanels(panels)).toHaveLength(0);
    });
});

describe('panelDataSignature', () => {
    it('ignores cosmetic fields and keys off type + targets', () => {
        const a = { type: 'stat', title: 'A', targets: [{ expr: 'x' }] };
        const b = { type: 'stat', title: 'B-different-title', targets: [{ expr: 'x' }] };
        expect(panelDataSignature(a)).toBe(panelDataSignature(b));
    });
});

describe('resolveTopLevelOverlaps', () => {
    it('nudges an overlapping panel down without touching side-by-side panels', () => {
        const panels = [
            { id: 1, type: 'stat', title: 'A', gridPos: { x: 0, y: 0, w: 12, h: 6 } },
            { id: 2, type: 'stat', title: 'B', gridPos: { x: 12, y: 0, w: 12, h: 6 } }, // side-by-side, ok
            { id: 3, type: 'stat', title: 'C', gridPos: { x: 0, y: 0, w: 12, h: 6 } }, // overlaps A
        ];
        const fixed = resolveTopLevelOverlaps(panels);
        expect(fixed).toBe(1);
        expect((panels[1].gridPos as PanelRecord).y).toBe(0);
        expect((panels[2].gridPos as PanelRecord).y).toBeGreaterThanOrEqual(6);
    });
});

describe('applySafeStructuralImprovements', () => {
    it('removes duplicates, adds a title row, and shifts panels down', () => {
        const dashboard = {
            title: '2505-200033 / KeysightNew',
            uid: 'ffq3wabj0i70gd',
            panels: [
                statPanel(200, 'Pressure Gauge', { x: 0, y: 0, w: 6, h: 6 }, 'pressure'),
                statPanel(203, 'Pressure Gauge', { x: 6, y: 0, w: 6, h: 6 }, 'pressure'),
                statPanel(24, 'Current', { x: 12, y: 0, w: 6, h: 6 }, 'current'),
            ],
        };
        const out = applySafeStructuralImprovements(dashboard, { titleLabel: dashboard.title });

        expect(out.removedPanels).toHaveLength(1);
        expect(out.removedPanels[0].id).toBe(203);

        const panels = out.dashboard.panels as PanelRecord[];
        // Title row first at y=0.
        expect(panels[0].type).toBe('text');
        expect((panels[0].gridPos as PanelRecord).y).toBe(0);
        const titleContent = (panels[0].options as { content?: string }).content;
        expect(titleContent).toContain('2505-200033 / KeysightNew');

        // Duplicate gone; remaining content panels shifted down by 2.
        const ids = panels.map((p) => p.id);
        expect(ids).not.toContain(203);
        expect(out.panelsShifted).toBeGreaterThan(0);

        // Original is untouched (works on a clone).
        expect((dashboard.panels as PanelRecord[]).length).toBe(3);
    });
});

describe('detectPendingSuggestions', () => {
    it('reports bar charts and missing units as confirm-only items', () => {
        const panels = [
            { id: 1, type: 'barchart', title: 'Module Voltage per Cartridge', gridPos: { x: 0, y: 0, w: 12, h: 6 } },
            {
                id: 2,
                type: 'stat',
                title: 'Current',
                gridPos: { x: 12, y: 0, w: 6, h: 6 },
                fieldConfig: { defaults: { unit: 'none' } },
            },
        ];
        const pending = detectPendingSuggestions(panels);
        expect(pending.some((p) => /bar chart/i.test(p.title))).toBe(true);
        expect(pending.some((p) => /Set a unit/i.test(p.title))).toBe(true);
    });
});

describe('runProgrammaticDashboardImprove (integration)', () => {
    it('reads the full dashboard once and saves the structural fixes in one pass', async () => {
        const calls: string[] = [];
        let savedDashboard: PanelRecord | undefined;
        const mcpClient = {
            callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
                calls.push(name);
                if (name === 'get_dashboard_by_uid') {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    dashboard: {
                                        title: '2505-200033 / KeysightNew',
                                        uid: 'ffq3wabj0i70gd',
                                        version: 7,
                                        panels: [
                                            statPanel(200, 'Pressure Gauge', { x: 0, y: 0, w: 6, h: 6 }, 'pressure'),
                                            statPanel(203, 'Pressure Gauge', { x: 6, y: 0, w: 6, h: 6 }, 'pressure'),
                                            statPanel(24, 'Current', { x: 12, y: 0, w: 6, h: 6 }, 'current'),
                                        ],
                                    },
                                }),
                            },
                        ],
                    };
                }
                if (name === 'update_dashboard') {
                    savedDashboard = args.dashboard as PanelRecord;
                    return {
                        content: [
                            { type: 'text', text: JSON.stringify({ uid: 'ffq3wabj0i70gd', version: 8 }) },
                        ],
                    };
                }
                throw new Error(`unexpected tool ${name}`);
            },
        };

        const result = await runProgrammaticDashboardImprove(mcpClient, { dashboardUid: 'ffq3wabj0i70gd' });

        expect(result.ok).toBe(true);
        expect(result.changedAnything).toBe(true);
        // Read once, saved once — no fetch loop.
        expect(calls.filter((c) => c === 'get_dashboard_by_uid')).toHaveLength(1);
        expect(calls.filter((c) => c === 'update_dashboard').length).toBeGreaterThanOrEqual(1);

        expect(result.removedPanels.map((p) => p.id)).toContain(203);

        const savedPanels = savedDashboard?.panels as PanelRecord[];
        expect(savedPanels[0].type).toBe('text'); // title row saved
        expect(savedPanels.map((p) => p.id)).not.toContain(203); // duplicate removed
    });

    it('returns a graceful error (no loop) when the dashboard JSON cannot be parsed', async () => {
        const mcpClient = {
            callTool: async ({ name }: { name: string }) => {
                if (name === 'get_dashboard_by_uid') {
                    return { content: [{ type: 'text', text: '{ truncated json ...' }] };
                }
                throw new Error(`unexpected tool ${name}`);
            },
        };
        const result = await runProgrammaticDashboardImprove(mcpClient, { dashboardUid: 'ffq3wabj0i70gd' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/parse/i);
    });
});

describe('formatDashboardImproveReply', () => {
    it('lists applied changes and pending confirm-only suggestions', () => {
        const text = formatDashboardImproveReply(
            {
                ok: true,
                toolExecutions: [],
                dashboardUid: 'ffq3wabj0i70gd',
                dashboardTitle: '2505-200033 / KeysightNew',
                panelCount: 34,
                removedPanels: [{ id: 203, title: 'Pressure Gauge' }],
                titleRowCreated: true,
                panelsShifted: 30,
                overlapsFixed: 2,
                chunksSaved: 6,
                totalChunks: 6,
                appliedChanges: [
                    { kind: 'remove_duplicates', detail: 'Removed 1 exact-duplicate panel(s): "Pressure Gauge"' },
                    { kind: 'title_row', detail: 'Added a full-width title row at the top and shifted 30 panel(s) down' },
                    { kind: 'overlaps', detail: 'Resolved 2 overlapping panel position(s)' },
                ],
                pendingSuggestions: [
                    { title: 'Fix broken query — Failed Panel', detail: 'has broken Flux.' },
                ],
                changedAnything: true,
            },
            178
        );
        expect(text).toContain('applied safe improvements');
        expect(text).toContain('Pressure Gauge');
        expect(text).toContain('title row');
        expect(text).toContain('Needs your confirmation');
        expect(text).toContain('Fix broken query');
    });

    it('reports a clean dashboard when nothing structural needs changing', () => {
        const text = formatDashboardImproveReply(
            {
                ok: true,
                toolExecutions: [],
                dashboardUid: 'abc',
                panelCount: 5,
                removedPanels: [],
                titleRowCreated: false,
                panelsShifted: 0,
                overlapsFixed: 0,
                appliedChanges: [],
                pendingSuggestions: [],
                changedAnything: false,
            },
            178
        );
        expect(text).toMatch(/no safe structural changes/i);
    });
});
