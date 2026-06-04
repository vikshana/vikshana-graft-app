/** Update chat session in the URL without React Router (avoids restore/effect loops on Send). */
export function replaceChatSessionInUrl(sessionId: string, options?: { defer?: boolean }): void {
    const apply = () => {
        if (typeof window === 'undefined') {
            return;
        }
        try {
            const url = new URL(window.location.href);
            if (url.searchParams.get('session') === sessionId && url.searchParams.get('chat') === 'true') {
                return;
            }
            url.searchParams.set('chat', 'true');
            url.searchParams.set('session', sessionId);
            window.history.replaceState(window.history.state, '', url.toString());
        } catch {
            // ignore URL errors in embedded Grafana routes
        }
    };

    if (options?.defer) {
        window.setTimeout(apply, 0);
        return;
    }
    apply();
}
