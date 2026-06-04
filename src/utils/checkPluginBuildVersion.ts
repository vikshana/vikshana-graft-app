import { GRAFT_BUILD_NUMBER } from '../buildInfo';

/** Reload once if the browser cached an older plugin entry while build-info.json is newer. */
export async function checkPluginBuildVersion(): Promise<void> {
    const storageKey = 'graft-build-version-check';
    try {
        const response = await fetch(
            `public/plugins/vikshana-graft-app/build-info.json?_=${Date.now()}`,
            { cache: 'no-store' }
        );
        if (!response.ok) {
            return;
        }
        const data = (await response.json()) as { build?: number };
        const remoteBuild = Number(data.build);
        if (!Number.isFinite(remoteBuild) || remoteBuild === GRAFT_BUILD_NUMBER) {
            sessionStorage.removeItem(storageKey);
            return;
        }
        if (!sessionStorage.getItem(storageKey)) {
            sessionStorage.setItem(storageKey, String(remoteBuild));
            window.location.reload();
        }
    } catch {
        // ignore network errors
    }
}
