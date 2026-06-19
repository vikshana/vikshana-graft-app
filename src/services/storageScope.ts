import { config } from '@grafana/runtime';

/**
 * Per-(org,user) suffix for browser storage keys so that Graft state never bleeds
 * between different Grafana users or organizations sharing the same browser profile.
 *
 * Uses orgId + login (NOT user.id, which can be missing on first paint and would
 * split storage). Returns 'default' only when no user is in context (e.g. tests /
 * logged-out), in which case the bare base key is used.
 */
export function getStorageSuffix(): string {
    try {
        const user = config.bootData?.user;
        if (user?.orgId != null && user.login) {
            return `${user.orgId}_${user.login}`;
        }
    } catch {
        // config may be unavailable in tests
    }
    return 'default';
}

/** Returns the base key when no user is in context, otherwise `${base}_<orgId>_<login>`. */
export function scopedStorageKey(base: string): string {
    const suffix = getStorageSuffix();
    return suffix === 'default' ? base : `${base}_${suffix}`;
}

/** True when a real Grafana user is in context (storage is being scoped). */
export function hasScopedUser(): boolean {
    return getStorageSuffix() !== 'default';
}
