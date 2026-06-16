import {
    formatAmbiguousGraphCreateClarification,
    messageDescribesAmbiguousGraphCreate,
} from './ambiguousGraphCreateParse';
import { messageDescribesMultiPanelCreate } from './panelCreateParse';
import { userWantsDashboardMetricPanels } from './dashboardMetricPanelsParse';

describe('ambiguousGraphCreateParse', () => {
    const keysightPrompt =
        'Create graphs that would be useful for the Keysight machine on the dashboard with UID = cfo0wckufbdhce.';

    it('detects vague Keysight graph create', () => {
        expect(messageDescribesAmbiguousGraphCreate(keysightPrompt)).toBe(true);
    });

    it('does not match typed multi-panel create', () => {
        const prompt =
            'Create a gauge panel, time series panel, table panel, and stat panel for dashboard with UID = cfo0wckufbdhce.';
        expect(messageDescribesAmbiguousGraphCreate(prompt)).toBe(false);
        expect(messageDescribesMultiPanelCreate(prompt)).toBe(true);
    });

    it('does not match bulk metric panels', () => {
        const prompt =
            'Create 50 panels covering every available metric on the dashboard with UID = cfo0wckufbdhce';
        expect(messageDescribesAmbiguousGraphCreate(prompt)).toBe(false);
        expect(userWantsDashboardMetricPanels(prompt)).toBe(true);
    });

    it('formats clarification with programmatic examples', () => {
        const msg = formatAmbiguousGraphCreateClarification(keysightPrompt);
        expect(msg).toContain('Need clarification');
        expect(msg).toContain('cfo0wckufbdhce');
        expect(msg).toContain('machine_metrics');
        expect(msg).toContain('gauge panel, time series panel');
    });
});
