import { isChunkLoadError } from './lazyWithChunkRetry';

describe('isChunkLoadError', () => {
    it('detects webpack chunk load failures', () => {
        expect(
            isChunkLoadError(
                new Error(
                    'Loading chunk 9948 failed.\n(error: https://example/public/plugins/vikshana-graft-app/9948.js?_cache=abc)'
                )
            )
        ).toBe(true);
    });

    it('ignores unrelated errors', () => {
        expect(isChunkLoadError(new Error('Network request failed'))).toBe(false);
    });
});
