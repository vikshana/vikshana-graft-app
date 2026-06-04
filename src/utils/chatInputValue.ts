function readNativeTextAreaValue(node: Element | null | undefined): string {
    if (!node) {
        return '';
    }
    if (node instanceof HTMLTextAreaElement) {
        return node.value;
    }
    const nested = node.querySelector('textarea');
    if (nested instanceof HTMLTextAreaElement) {
        return nested.value;
    }
    return '';
}

/** Read the live chat textarea value (Grafana TextArea may wrap the native element). */
export function readChatInputDomValue(fallback = ''): string {
    const root = document.querySelector('[data-testid="chat-input"]');
    const fromDom = readNativeTextAreaValue(root);
    const trimmedDom = fromDom.trim();
    const trimmedFallback = fallback.trim();
    if (trimmedDom && trimmedFallback) {
        return trimmedDom.length >= trimmedFallback.length ? trimmedDom : trimmedFallback;
    }
    return trimmedDom || trimmedFallback;
}

/** Prefer the longest non-empty value from React state and the live textarea. */
export function resolveChatInputText(
    reactValue: string,
    refEl?: HTMLTextAreaElement | null
): string {
    const fromRef = readNativeTextAreaValue(refEl).trim();
    const fromDom = readChatInputDomValue('').trim();
    const fromReact = reactValue.trim();
    return [fromRef, fromDom, fromReact].sort((a, b) => b.length - a.length)[0] ?? '';
}
