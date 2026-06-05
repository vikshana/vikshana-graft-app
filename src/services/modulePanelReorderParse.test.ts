import {
    assistantAwaitingModuleReorderConfirm,
    isModuleReorderConfirmation,
    parseModulePanelReorderRequest,
    parseModuleNumberFromTitle,
    userWantsModulePanelReorder,
} from './modulePanelReorderParse';

describe('modulePanelReorderParse', () => {
    it('detects rearrange intent on Exsolve dashboard', () => {
        const msg =
            'on dashboard 2406-176021 / Exsolve can re arrange the panels starting "Module" + number + "Current" to ordered by number and the same size';
        expect(userWantsModulePanelReorder(msg)).toBe(true);
        const req = parseModulePanelReorderRequest(msg);
        expect(req?.dashboardTitle).toBe('2406-176021 / Exsolve');
        expect(req?.includeRandomForest).toBe(true);
    });

    it('parses yes confirmation after assistant question', () => {
        const prior =
            'on dashboard 2406-176021 / Exsolve can re arrange the panels starting Module 5 Current to ordered by number';
        const assistant =
            'You want them reordered to **Module 1 → 2 → 3**. Should I also move the Module 5 RandomForest panels (Influx), or keep them at the end?';
        expect(assistantAwaitingModuleReorderConfirm(assistant)).toBe(true);
        expect(isModuleReorderConfirmation('yes in order including with the ones at end in order as well')).toBe(true);
        const req = parseModulePanelReorderRequest('yes in order including with the ones at end in order as well', {
            priorUserMessage: prior,
            priorAssistantMessage: assistant,
        });
        expect(req?.dashboardTitle).toContain('2406-176021');
        expect(req?.includeRandomForest).toBe(true);
    });

    it('parses module number from title', () => {
        expect(parseModuleNumberFromTitle('Module 5 Current — vs. Peer Band')).toBe(5);
        expect(parseModuleNumberFromTitle('Pressure 1')).toBeNull();
    });
});
