import { scanPanelFluxIssues } from './panelFluxVerification';

describe('scanPanelFluxIssues', () => {
    it('flags peer targets that still use regex _field =~', () => {
        const issues = scanPanelFluxIssues({
            targets: [
                {
                    refId: 'B',
                    query:
                        'from(b: "x") |> filter(fn: (r) => r._field =~ /^Module[1-46-8]_Current_A$/) |> mean()',
                },
            ],
        });
        expect(issues.some((i) => i.refId === 'B' && /=~/.test(i.issue))).toBe(true);
    });

    it('flags OR peer filter and passes collapsed union with machine_metrics', () => {
        const orIssues = scanPanelFluxIssues({
            targets: [
                {
                    refId: 'B',
                    query:
                        'from(b:"x") |> filter(fn: (r) => r.machine == "m" and (r._field == "Module1_Current_A" or r._field == "Module2_Current_A")) |> keep()',
                },
            ],
        });
        expect(orIssues.some((i) => i.refId === 'B' && /OR filter/i.test(i.issue))).toBe(true);

        const unionIssues = scanPanelFluxIssues({
            targets: [
                {
                    refId: 'B',
                    query:
                        'union(tables: [from(b:"x") |> filter(fn: (r) => r._measurement == "machine_metrics" and r._field == "Module1_Current_A") |> keep(columns: ["_time", "_value"]), from(b:"x") |> filter(fn: (r) => r._measurement == "machine_metrics" and r._field == "Module2_Current_A") |> keep(columns: ["_time", "_value"]), from(b:"x") |> filter(fn: (r) => r._measurement == "machine_metrics" and r._field == "Module3_Current_A") |> keep(columns: ["_time", "_value"])]) |> group(columns: ["_time"]) |> mean(column: "_value")',
                },
            ],
        });
        expect(unionIssues.filter((i) => i.refId === 'B')).toHaveLength(0);
    });
});
