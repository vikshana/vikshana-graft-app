import { normalizeToolArgs } from './toolUtils';

describe('normalizeToolArgs', () => {
    it('leaves primitive values unchanged', () => {
        const args = { name: 'My Dashboard', overwrite: true, folderId: 0 };
        expect(normalizeToolArgs(args)).toEqual(args);
    });

    it('parses a double-serialized object value', () => {
        const dashboard = { title: 'CPU Usage', panels: [] };
        const args = { dashboard: JSON.stringify(dashboard), overwrite: false };
        expect(normalizeToolArgs(args)).toEqual({ dashboard, overwrite: false });
    });

    it('parses a double-serialized array value', () => {
        const panels = [{ id: 1 }, { id: 2 }];
        const args = { panels: JSON.stringify(panels) };
        expect(normalizeToolArgs(args)).toEqual({ panels });
    });

    it('leaves a plain string unchanged when it is not JSON', () => {
        const args = { uid: 'abc-123', title: 'hello' };
        expect(normalizeToolArgs(args)).toEqual(args);
    });

    it('leaves an invalid JSON string unchanged', () => {
        const args = { broken: '{not: valid json}' };
        expect(normalizeToolArgs(args)).toEqual(args);
    });

    it('handles an empty args object', () => {
        expect(normalizeToolArgs({})).toEqual({});
    });

    it('does not mutate the original object', () => {
        const dashboard = { title: 'Test' };
        const args = { dashboard: JSON.stringify(dashboard) };
        const result = normalizeToolArgs(args);
        expect(result).not.toBe(args);
        expect(args.dashboard).toBe(JSON.stringify(dashboard));
    });

    it('handles objects with leading whitespace in string values', () => {
        const inner = { key: 'value' };
        const args = { data: '  ' + JSON.stringify(inner) };
        expect(normalizeToolArgs(args)).toEqual({ data: inner });
    });
});
