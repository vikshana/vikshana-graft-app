import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';

export interface PeerRfAvailabilityResult {
    /** True when Influx has at least one peer_rf expected point for machine+field. */
    available: boolean;
    /** Probe could not run (auth, datasource, Flux error) — treat as unavailable for create. */
    probeError?: string;
    machineId: string;
    field: string;
    influxDatasourceUid: string;
    bucket?: string;
}

function escapeFluxString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function grafanaGet<T>(url: string): Promise<T> {
    const obs = getBackendSrv().fetch<T>({ url, method: 'GET', showErrorAlert: false });
    const res = await lastValueFrom(obs);
    return res.data;
}

async function grafanaPost<T>(url: string, data: unknown): Promise<T> {
    const obs = getBackendSrv().fetch<T>({
        url,
        method: 'POST',
        data,
        showErrorAlert: false,
    });
    const res = await lastValueFrom(obs);
    return res.data;
}

/** Resolve Influx bucket from Grafana datasource settings (no hard-coded bucket). */
export async function resolveInfluxBucketForDatasource(datasourceUid: string): Promise<string | undefined> {
    try {
        const ds = await grafanaGet<{
            jsonData?: Record<string, unknown>;
            database?: string;
        }>(`/api/datasources/uid/${encodeURIComponent(datasourceUid)}`);
        const jd = ds.jsonData ?? {};
        for (const key of ['defaultBucket', 'bucket', 'organizationBucket']) {
            const v = jd[key];
            if (typeof v === 'string' && v.trim()) {
                return v.trim();
            }
        }
        if (typeof ds.database === 'string' && ds.database.trim()) {
            return ds.database.trim();
        }
    } catch (err) {
        return undefined;
    }
    return undefined;
}

function frameHasNumericPoints(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    const results = (payload as { results?: Record<string, unknown> }).results;
    if (!results || typeof results !== 'object') {
        return false;
    }
    for (const ref of Object.values(results)) {
        if (!ref || typeof ref !== 'object') {
            continue;
        }
        const block = ref as { error?: string; frames?: unknown[] };
        if (block.error) {
            continue;
        }
        const frames = block.frames;
        if (!Array.isArray(frames)) {
            continue;
        }
        for (const frame of frames) {
            if (!frame || typeof frame !== 'object') {
                continue;
            }
            const data = (frame as { data?: { values?: unknown[] } }).data;
            const values = data?.values;
            if (!Array.isArray(values)) {
                continue;
            }
            for (const col of values) {
                if (!Array.isArray(col)) {
                    continue;
                }
                for (const cell of col) {
                    if (typeof cell === 'number' && Number.isFinite(cell) && cell > 0) {
                        return true;
                    }
                    if (typeof cell === 'string' && Number(cell) > 0) {
                        return true;
                    }
                }
            }
        }
    }
    return false;
}

function extractQueryError(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') {
        return undefined;
    }
    const results = (payload as { results?: Record<string, unknown> }).results;
    if (!results) {
        return undefined;
    }
    for (const ref of Object.values(results)) {
        if (ref && typeof ref === 'object' && typeof (ref as { error?: string }).error === 'string') {
            return (ref as { error: string }).error;
        }
    }
    return undefined;
}

/**
 * Probe Influx for peer-RF bands (`ml_predictions` + `model=peer_rf`) for one machine/field.
 * Uses the signed-in Grafana session (`/api/ds/query`) — not MCP.
 */
export async function probePeerRfModelAvailability(opts: {
    influxDatasourceUid: string;
    machineId: string;
    moduleNumber: number;
    /** Lookback for existence check (default 30d). */
    rangeStart?: string;
}): Promise<PeerRfAvailabilityResult> {
    const field = `Module${opts.moduleNumber}_Current_A`;
    const base: PeerRfAvailabilityResult = {
        available: false,
        machineId: opts.machineId,
        field,
        influxDatasourceUid: opts.influxDatasourceUid,
    };

    const bucket = await resolveInfluxBucketForDatasource(opts.influxDatasourceUid);
    if (!bucket) {
        return {
            ...base,
            probeError:
                'Could not resolve Influx bucket from the datasource settings (defaultBucket / bucket).',
        };
    }
    base.bucket = bucket;

    const m = escapeFluxString(opts.machineId);
    const f = escapeFluxString(field);
    const rangeStart = opts.rangeStart ?? '-30d';
    const flux =
        `from(bucket: "${escapeFluxString(bucket)}")\n` +
        `  |> range(start: ${rangeStart})\n` +
        `  |> filter(fn: (r) => r._measurement == "ml_predictions")\n` +
        `  |> filter(fn: (r) => r.machine == "${m}" and r.field == "${f}" and r.model == "peer_rf")\n` +
        `  |> filter(fn: (r) => r._field == "expected")\n` +
        `  |> count()`;

    try {
        const payload = await grafanaPost<unknown>('/api/ds/query', {
            queries: [
                {
                    refId: 'A',
                    datasource: { type: 'influxdb', uid: opts.influxDatasourceUid },
                    query: flux,
                },
            ],
        });
        const qErr = extractQueryError(payload);
        if (qErr) {
            return { ...base, probeError: qErr };
        }
        return { ...base, available: frameHasNumericPoints(payload) };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ...base, probeError: msg };
    }
}

/** Operator-facing explanation when peer-RF data is missing — no placeholder panel. */
export function formatPeerRfUnavailableExplanation(opts: {
    machineId: string;
    moduleNumber: number;
    field: string;
    probeError?: string;
}): string {
    const { machineId, moduleNumber, field, probeError } = opts;
    const lines = [
        `No **peer-RF** RandomForest bands were found in Influx for machine \`${machineId}\` / \`${field}\` (\`ml_predictions\` where \`model=peer_rf\`).`,
        ``,
        `The Actual series can exist without peer-RF — peer-RF is trained by the ML exporter, not by Grafana panels.`,
        ``,
        `**What Graft needs:**`,
        `1. Peer-RF bands in the **same Influx** Grafana queries (\`ml_predictions\` / \`model=peer_rf\` for \`${field}\`).`,
        `2. Machine \`${machineId}\` enrolled in the exporter (\`peer_rf_config.json\`) with backfill enabled.`,
        ``,
        `When Graft peer-RF control is configured, a create prompt **auto-enrolls** the machine and waits briefly for bands — no separate enroll phrase required.`,
        ``,
        `If enroll/backfill already finished but this probe is still empty, Grafana’s Influx datasource URL likely does not match the data bridge \`INFLUX_HOST\` (fix with \`scripts/sync-grafana-influx-to-bridge.sh\`).`,
        ``,
        `Until bands are visible via Grafana, Graft will **not** create placeholder band queries (they would only show Module ${moduleNumber} Actual).`,
        ``,
        `**Alternatives that work without peer-RF:**`,
        `- **vs. Peer Band (±2σ)** — Flux mean/stddev across peer modules (no ML exporter).`,
        `- **History Comparison** — live Prometheus RandomForest (\`machine_metric_*\`) when that exporter covers this machine.`,
    ];
    if (probeError) {
        lines.push(``, `_Probe note:_ ${probeError}`);
    }
    return lines.join('\n');
}
