import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

const RELOAD_FLAG_PREFIX = 'graft-chunk-reload:';

export function isChunkLoadError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    return (
        /Loading chunk [\w-]+ failed/i.test(error.message) ||
        /ChunkLoadError/i.test(error.message) ||
        /Failed to fetch dynamically imported module/i.test(error.message)
    );
}

export function lazyWithChunkRetry<T extends ComponentType<any>>(
    factory: () => Promise<{ default: T }>,
    chunkLabel: string
): LazyExoticComponent<T> {
    return lazy(async () => {
        try {
            return await factory();
        } catch (error) {
            if (isChunkLoadError(error)) {
                const storageKey = `${RELOAD_FLAG_PREFIX}${chunkLabel}`;
                if (!sessionStorage.getItem(storageKey)) {
                    sessionStorage.setItem(storageKey, String(Date.now()));
                    window.location.reload();
                    await new Promise<void>(() => {
                        /* wait for reload */
                    });
                }
            }
            throw error;
        }
    });
}

export function clearChunkReloadFlags(): void {
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
        const key = sessionStorage.key(i);
        if (key?.startsWith(RELOAD_FLAG_PREFIX)) {
            sessionStorage.removeItem(key);
        }
    }
}
