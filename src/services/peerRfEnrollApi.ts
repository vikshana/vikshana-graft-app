import { getBackendSrv } from '@grafana/runtime';
import pluginJson from '../plugin.json';

const BASE = `/api/plugins/${pluginJson.id}/resources`;

export interface PeerRfEnrollResult {
    ok: boolean;
    machineId?: string;
    alreadyEnrolled?: boolean;
    backfillQueued?: boolean;
    backfillWarning?: string;
    targets?: Array<{ target: string; peerFeatures?: string[] }>;
    error?: string;
    status?: number;
}

export interface PeerRfControlHealth {
    ok: boolean;
    controlConfigured?: boolean;
    error?: string;
}

export interface PeerRfMachineStatus {
    ok?: boolean;
    enrolled?: boolean;
    machineId?: string;
    backfill?: {
        running?: boolean;
        machineId?: string;
        error?: string | null;
        startedAt?: string | null;
        finishedAt?: string | null;
    };
    targets?: Array<{ target: string; peerFeatures?: string[] }>;
    error?: string;
}

export async function fetchPeerRfControlHealth(): Promise<PeerRfControlHealth> {
    try {
        return await getBackendSrv().get<PeerRfControlHealth>(`${BASE}/peer-rf/health`, {
            showErrorAlert: false,
        });
    } catch (e) {
        return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

/** Machine enroll + backfill status via Graft plugin backend (Admin). */
export async function fetchPeerRfMachineStatus(machineId: string): Promise<PeerRfMachineStatus> {
    const id = machineId.trim();
    if (!id) {
        return { ok: false, error: 'machineId required' };
    }
    try {
        const data = await getBackendSrv().get<PeerRfMachineStatus>(
            `${BASE}/peer-rf/machines/${encodeURIComponent(id)}`,
            { showErrorAlert: false }
        );
        return { ok: true, ...(data as object) } as PeerRfMachineStatus;
    } catch (e: unknown) {
        const err = e as { status?: number; data?: { message?: string; error?: string }; message?: string };
        return {
            ok: false,
            machineId: id,
            error:
                err?.data?.error ||
                err?.data?.message ||
                err?.message ||
                (e instanceof Error ? e.message : String(e)),
        };
    }
}

/** Enroll machine via Graft plugin backend → exporter control API. Admin only. */
export async function enrollPeerRfMachine(
    machineId: string,
    opts?: { backfill?: boolean }
): Promise<PeerRfEnrollResult> {
    try {
        const data = await getBackendSrv().post(`${BASE}/peer-rf/machines`, {
            machineId,
            backfill: opts?.backfill !== false,
        }, { showErrorAlert: false });
        return { ok: true, ...(data as object) } as PeerRfEnrollResult;
    } catch (e: unknown) {
        const err = e as { status?: number; data?: { message?: string; error?: string }; message?: string };
        return {
            ok: false,
            machineId,
            status: err?.status,
            error:
                err?.data?.error ||
                err?.data?.message ||
                err?.message ||
                (e instanceof Error ? e.message : String(e)),
        };
    }
}

export function messageRequestsPeerRfEnroll(message: string): boolean {
    const text = message.trim();
    if (!text) {
        return false;
    }
    return (
        /\benroll\b/i.test(text) &&
        (/\bpeer\s*[- ]?\s*rf\b/i.test(text) ||
            /\brandom\s*forest\b/i.test(text) ||
            /\bpeer_rf\b/i.test(text))
    );
}
