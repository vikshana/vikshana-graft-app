import { setPendingRevertBaseline } from './dashboardRevertStorage';
import type { ScopedPanelFixTarget } from './panelFixScope';
import type { PanelFixResolvedPanel } from './panelCrossReference';

const SCOPE_KEY = 'graft_panel_fix_scope';
const BASELINE_KEY = 'graft_panel_fix_baseline';
const REVERTED_KEY = 'graft_panel_fix_reverted_count';
const NO_SAVE_STREAK_KEY = 'graft_panel_fix_no_save_streak';
const NO_SAVE_RECORDED_TURN_KEY = 'graft_panel_fix_no_save_recorded_turn';
const ASSISTANT_TURN_KEY = 'graft_panel_fix_assistant_turn';
const RESOLVED_PANEL_KEY = 'graft_panel_fix_resolved_panel';
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

export function setPanelFixScope(scope: ScopedPanelFixTarget): void {
    writeJson(SCOPE_KEY, scope);
}

export function getPanelFixScope(): ScopedPanelFixTarget | null {
    return readJson<ScopedPanelFixTarget>(SCOPE_KEY);
}

export function clearPanelFixScope(): void {
    try {
        sessionStorage.removeItem(SCOPE_KEY);
        sessionStorage.removeItem(BASELINE_KEY);
        sessionStorage.removeItem(REVERTED_KEY);
        sessionStorage.removeItem(NO_SAVE_STREAK_KEY);
        sessionStorage.removeItem(NO_SAVE_RECORDED_TURN_KEY);
        sessionStorage.removeItem(ASSISTANT_TURN_KEY);
        sessionStorage.removeItem(RESOLVED_PANEL_KEY);
    } catch {
        // ignore
    }
}

export function setPanelFixResolvedPanel(info: PanelFixResolvedPanel): void {
    writeJson(RESOLVED_PANEL_KEY, info);
}

export function getPanelFixResolvedPanel(): PanelFixResolvedPanel | null {
    return readJson<PanelFixResolvedPanel>(RESOLVED_PANEL_KEY);
}

/** Start a new assistant turn so no-save streak increments at most once per reply. */
export function beginPanelFixAssistantTurn(): void {
    writeJson(ASSISTANT_TURN_KEY, String(Date.now()));
    try {
        sessionStorage.removeItem(NO_SAVE_RECORDED_TURN_KEY);
    } catch {
        // ignore
    }
}

export function recordPanelFixNoSaveTurn(): number {
    const turn = readJson<string>(ASSISTANT_TURN_KEY);
    if (turn && readJson<string>(NO_SAVE_RECORDED_TURN_KEY) === turn) {
        return readJson<number>(NO_SAVE_STREAK_KEY) ?? 0;
    }
    const n = (readJson<number>(NO_SAVE_STREAK_KEY) ?? 0) + 1;
    writeJson(NO_SAVE_STREAK_KEY, n);
    if (turn) {
        writeJson(NO_SAVE_RECORDED_TURN_KEY, turn);
    }
    return n;
}

export function clearPanelFixNoSaveStreak(): void {
    try {
        sessionStorage.removeItem(NO_SAVE_STREAK_KEY);
    } catch {
        // ignore
    }
}

export function getPanelFixNoSaveStreak(): number {
    return readJson<number>(NO_SAVE_STREAK_KEY) ?? 0;
}

export function setPanelFixBaseline(dashboard: Record<string, unknown>): void {
    writeJson(BASELINE_KEY, dashboard);
    const scope = getPanelFixScope();
    const uid =
        scope?.dashboardUid ??
        (typeof dashboard.uid === 'string' ? dashboard.uid : undefined);
    if (uid) {
        setPendingRevertBaseline(
            uid,
            dashboard,
            typeof dashboard.title === 'string' ? dashboard.title : undefined
        );
    }
}

export function getPanelFixBaseline(): Record<string, unknown> | null {
    return readJson<Record<string, unknown>>(BASELINE_KEY);
}

export function setPanelFixRevertedCount(count: number): void {
    writeJson(REVERTED_KEY, count);
}

export function getPanelFixRevertedCount(): number {
    const n = readJson<number>(REVERTED_KEY);
    return typeof n === 'number' && n > 0 ? n : 0;
}
