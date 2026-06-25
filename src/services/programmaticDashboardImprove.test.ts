import {
    applyDataVisualFixes,
    applySafeStructuralImprovements,
    detectPendingSuggestions,
    findExactDuplicateTopLevelPanels,
    formatDashboardImproveReply,
    panelDataSignature,
    resolveTopLevelOverlaps,
    runProgrammaticDashboardImprove,
    unitForTitle,
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

describe('unitForTitle', () => {
    it('maps current → amp and voltage → volt', () => {
        expect(unitForTitle('Current')).toBe('amp');
        expect(unitForTitle('Module 1 Current')).toBe('amp');
        expect(unitForTitle('Module Voltage per Cartridge')).toBe('volt');
        expect(unitForTitle('Pressure')).toBeUndefined();
    });
});

describe('applyDataVisualFixes', () => {
    it('converts bar charts to time series and clears instant on their targets', () => {
        const dashboard = {
            panels: [
                {
                    id: 201,
                    type: 'barchart',
                    title: 'Module Voltage per Cartridge',
                    gridPos: { x: 0, y: 0, w: 12, h: 6 },
                    targets: [{ refId: 'A', expr: 'v', instant: true }],
                },
            ],
        };
        const counts = applyDataVisualFixes(dashboard);
        expect(counts.barchartsConverted.map((p) => p.id)).toContain(201);
        const panel = (dashboard.panels as PanelRecord[])[0];
        expect(panel.type).toBe('timeseries');
        expect((panel.targets as PanelRecord[])[0].instant).toBe(false);
    });

    it('sets a unit only on unitless current/voltage panels', () => {
        const dashboard = {
            panels: [
                { id: 24, type: 'stat', title: 'Current', gridPos: { x: 0, y: 0, w: 6, h: 6 }, fieldConfig: { defaults: { unit: 'none' } } },
                { id: 30, type: 'stat', title: 'Voltage', gridPos: { x: 6, y: 0, w: 6, h: 6 } },
                { id: 40, type: 'stat', title: 'Pressure', gridPos: { x: 12, y: 0, w: 6, h: 6 } },
                { id: 50, type: 'stat', title: 'Current (calibrated)', gridPos: { x: 18, y: 0, w: 6, h: 6 }, fieldConfig: { defaults: { unit: 'amp' } } },
            ],
        };
        const counts = applyDataVisualFixes(dashboard);
        expect(counts.unitsSet.map((p) => p.id).sort()).toEqual([24, 30]);
        const panels = dashboard.panels as PanelRecord[];
        expect((panels[0].fieldConfig as { defaults: { unit: string } }).defaults.unit).toBe('amp');
        expect((panels[1].fieldConfig as { defaults: { unit: string } }).defaults.unit).toBe('volt');
        // Pressure untouched; already-set unit not overwritten.
        expect((panels[2] as PanelRecord).fieldConfig).toBeUndefined();
        expect((panels[3].fieldConfig as { defaults: { unit: string } }).defaults.unit).toBe('amp');
    });

    it('repairs broken Flux syntax in place (keeps the panel reference in the tree)', () => {
        const brokenQuery =
            'from(bucket: "b") |> range(start: -1h) |> group(by: ["x"]) |> stdDev()';
        const dashboard = {
            panels: [
                {
                    id: 103,
                    type: 'timeseries',
                    title: 'Failed Panel',
                    gridPos: { x: 0, y: 0, w: 12, h: 6 },
                    datasource: { type: 'influxdb', uid: 'inf1' },
                    targets: [{ refId: 'A', query: brokenQuery, rawQuery: true }],
                },
            ],
        };
        const originalRef = (dashboard.panels as PanelRecord[])[0];
        const counts = applyDataVisualFixes(dashboard);
        expect(counts.queriesFixed.map((p) => p.id)).toContain(103);
        // Same object reference, repaired contents (stdDev → stddev, group(by → group(columns).
        expect((dashboard.panels as PanelRecord[])[0]).toBe(originalRef);
        const q = ((dashboard.panels as PanelRecord[])[0].targets as PanelRecord[])[0].query as string;
        expect(q).not.toMatch(/stdDev\b/);
        expect(q).not.toMatch(/group\s*\(\s*by\s*:/);
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
                barchartsConverted: [{ id: 201, title: 'Module Voltage per Cartridge' }],
                unitsSet: [{ id: 24, title: 'Current', unit: 'amp' }],
                queriesFixed: [{ id: 103, title: 'Failed Panel' }],
                appliedChanges: [
                    { kind: 'remove_duplicates', detail: 'Removed 1 exact-duplicate panel(s): "Pressure Gauge"' },
                    { kind: 'title_row', detail: 'Added a full-width title row at the top and shifted 30 panel(s) down' },
                    { kind: 'overlaps', detail: 'Resolved 2 overlapping panel position(s)' },
                    { kind: 'barchart_timeseries', detail: 'Converted 1 bar chart(s) to time series: "Module Voltage per Cartridge"' },
                    { kind: 'set_units', detail: 'Set units on 1 panel(s): "Current" → amp' },
                    { kind: 'fix_queries', detail: 'Repaired 1 broken Flux query/queries: "Failed Panel"' },
                ],
                pendingSuggestions: [],
                changedAnything: true,
            },
            178
        );
        expect(text).toContain('applied safe improvements');
        expect(text).toContain('Pressure Gauge');
        expect(text).toContain('title row');
        expect(text).toContain('time series');
        expect(text).toContain('Set units');
        expect(text).toContain('Repaired 1 broken Flux');
    });

    it('reports a clean dashboard when nothing needs changing', () => {
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
                barchartsConverted: [],
                unitsSet: [],
                queriesFixed: [],
                appliedChanges: [],
                pendingSuggestions: [],
                changedAnything: false,
            },
            178
        );
        expect(text).toMatch(/nothing to change/i);
    });
});

describe('runProgrammaticDashboardImprove — auto-applies data/visual fixes', () => {
    it('converts bar charts, sets units, and repairs queries in one save', async () => {
        const calls: string[] = [];
        let saved: PanelRecord | undefined;
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
                                        version: 9,
                                        panels: [
                                            {
                                                id: 201,
                                                type: 'barchart',
                                                title: 'Module Voltage per Cartridge',
                                                gridPos: { x: 0, y: 0, w: 12, h: 6 },
                                                targets: [{ refId: 'A', expr: 'v', instant: true }],
                                            },
                                            {
                                                id: 24,
                                                type: 'stat',
                                                title: 'Current',
                                                gridPos: { x: 12, y: 0, w: 6, h: 6 },
                                                fieldConfig: { defaults: { unit: 'none' } },
                                            },
                                        ],
                                    },
                                }),
                            },
                        ],
                    };
                }
                if (name === 'update_dashboard') {
                    saved = args.dashboard as PanelRecord;
                    return { content: [{ type: 'text', text: JSON.stringify({ uid: 'ffq3wabj0i70gd', version: 10 }) }] };
                }
                throw new Error(`unexpected tool ${name}`);
            },
        };

        const result = await runProgrammaticDashboardImprove(mcpClient, { dashboardUid: 'ffq3wabj0i70gd' });

        expect(result.ok).toBe(true);
        expect(result.barchartsConverted.map((p) => p.id)).toContain(201);
        expect(result.unitsSet.map((p) => p.id)).toContain(24);
        expect(calls.filter((c) => c === 'get_dashboard_by_uid')).toHaveLength(1);

        const savedPanels = saved?.panels as PanelRecord[];
        const barchart = savedPanels.find((p) => p.id === 201);
        const current = savedPanels.find((p) => p.id === 24);
        expect(barchart?.type).toBe('timeseries');
        expect((current?.fieldConfig as { defaults: { unit: string } }).defaults.unit).toBe('amp');
    });
});
