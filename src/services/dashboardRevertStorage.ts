export interface DashboardRevertSnapshot {
    uid: string;
    title?: string;
    dashboard: Record<string, unknown>;
    capturedAt: number;
}

const REVERT_SNAPSHOT_KEY = 'graft_dashboard_revert_snapshot';
const PENDING_REVERT_KEY = 'graft_dashboard_revert_pending';

function readJson<T>(key: string): T | null {
    try {
        const raw = sessionStorage.getItem(key);
        if (!raw) {
            return null;
        }
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function writeJson(key: string, value: unknown): void {
    try {
        sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
        // ignore
    }
}

/** Snapshot of dashboard JSON from the last get_dashboard_by_uid before a Graft save. */
export function setPendingRevertBaseline(
    uid: string,
    dashboard: Record<string, unknown>,
    title?: string
): void {
    writeJson(PENDING_REVERT_KEY, {
        uid,
        title,
        dashboard,
        capturedAt: Date.now(),
    } satisfies DashboardRevertSnapshot);
}

export function commitRevertSnapshotAfterSave(savedUid: string): void {
    const pending = readJson<DashboardRevertSnapshot>(PENDING_REVERT_KEY);
    if (!pending || pending.uid !== savedUid) {
        return;
    }
    writeJson(REVERT_SNAPSHOT_KEY, pending);
    try {
        sessionStorage.removeItem(PENDING_REVERT_KEY);
    } catch {
        // ignore
    }
}

export function getDashboardRevertSnapshot(): DashboardRevertSnapshot | null {
    return readJson<DashboardRevertSnapshot>(REVERT_SNAPSHOT_KEY);
}

export function hasDashboardRevertSnapshot(): boolean {
    return getDashboardRevertSnapshot() != null;
}

export function clearDashboardRevertSnapshot(): void {
    try {
        sessionStorage.removeItem(REVERT_SNAPSHOT_KEY);
        sessionStorage.removeItem(PENDING_REVERT_KEY);
    } catch {
        // ignore
    }
}
