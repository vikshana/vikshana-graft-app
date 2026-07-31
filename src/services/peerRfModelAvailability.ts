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

/** List Influx datasources in the active org (includes URL for preferring bridge-backed hosts). */
export async function listInfluxDatasources(): Promise<
    Array<{ uid: string; name?: string; url?: string; isDefault?: boolean }>
> {
    try {
        const list = await grafanaGet<Array<Record<string, unknown>>>('/api/datasources');
        if (!Array.isArray(list)) {
            return [];
        }
        return list
            .filter((d) => /influx/i.test(String(d.type ?? '')))
            .map((d) => ({
                uid: String(d.uid ?? ''),
                name: typeof d.name === 'string' ? d.name : undefined,
                url: typeof d.url === 'string' ? d.url : undefined,
                isDefault: Boolean(d.isDefault),
            }))
            .filter((d) => Boolean(d.uid));
    } catch {
        return [];
    }
}

/** Prefer bridge/remote Influx over docker-local `influxdb:8086` (often lacks ml_predictions). */
export function rankInfluxDatasourcesForPeerRf(
    candidates: Array<{ uid: string; url?: string; isDefault?: boolean }>,
    preferredUid?: string
): string[] {
    const scored = candidates.map((c, index) => {
        const url = (c.url || '').toLowerCase();
        let score = 0;
        if (preferredUid && c.uid === preferredUid) {
            score += 50;
        }
        if (url.includes('influxdb:8086') || url.includes('://influxdb/')) {
            score -= 40;
        } else if (url.startsWith('http')) {
            score += 20;
        }
        if (c.isDefault) {
            score += 5;
        }
        return { uid: c.uid, score, index };
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of scored) {
        if (!seen.has(s.uid)) {
            seen.add(s.uid);
            out.push(s.uid);
        }
    }
    return out;
}

/**
 * Pick an Influx UID that already has peer_rf bands when possible.
 * Tries ranked datasources (dashboard preference first, then remote over local).
 */
export async function resolveInfluxUidWithPeerRfBands(opts: {
    preferredUid?: string;
    machineId: string;
    moduleNumber: number;
}): Promise<{ influxDatasourceUid?: string; availability: PeerRfAvailabilityResult }> {
    const listed = await listInfluxDatasources();
    const ranked = rankInfluxDatasourcesForPeerRf(listed, opts.preferredUid);
    const tryOrder =
        ranked.length > 0
            ? ranked
            : opts.preferredUid
              ? [opts.preferredUid]
              : [];

    let last: PeerRfAvailabilityResult = {
        available: false,
        machineId: opts.machineId,
        field: `Module${opts.moduleNumber}_Current_A`,
        influxDatasourceUid: opts.preferredUid ?? '',
    };

    for (const uid of tryOrder) {
        const availability = await probePeerRfModelAvailability({
            influxDatasourceUid: uid,
            machineId: opts.machineId,
            moduleNumber: opts.moduleNumber,
        });
        last = availability;
        if (availability.available) {
            return { influxDatasourceUid: uid, availability };
        }
    }

    return {
        influxDatasourceUid: tryOrder[0] ?? opts.preferredUid,
        availability: last,
    };
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
