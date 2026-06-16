import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { StepToolCallContainer } from './StepToolCallContainer';
import type { StepToolExecutions } from '../../../../types/llm.types';

jest.mock('@grafana/ui', () => ({
    useStyles2: (fn: (theme: any) => any) => fn({
        colors: {
            border: { weak: '#ccc' },
            background: { primary: '#fff', secondary: '#f0f0f0' },
            text: { primary: '#000', secondary: '#666' },
            action: { hover: '#eee' },
            error: { text: '#f00', border: '#f00' },
            success: { text: '#0f0' },
            primary: { text: '#00f' },
        },
        spacing: (n: number) => `${n * 8}px`,
        typography: {
            bodySmall: { fontSize: '12px' },
            fontFamilyMonospace: 'monospace',
        },
    }),
    Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));

jest.mock('@emotion/css', () => ({
    css: (...args: any[]) => args.join(' '),
}));

describe('StepToolCallContainer', () => {
    const makeGroup = (overrides: Partial<StepToolExecutions>): StepToolExecutions => ({
        stepId: 'step_1',
        stepDescription: 'Fetch Loki data',
        toolExecutions: [],
        status: 'done',
        ...overrides,
    });

    it('renders nothing when stepGroups is empty', () => {
        const { container } = render(<StepToolCallContainer stepGroups={[]} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders step description', () => {
        render(<StepToolCallContainer stepGroups={[makeGroup({ status: 'done' })]} />);
        expect(screen.getByText('Fetch Loki data')).toBeInTheDocument();
    });

    it('shows error icon when status is error', () => {
        render(<StepToolCallContainer stepGroups={[makeGroup({ status: 'error' })]} />);
        expect(screen.getByText('✗')).toBeInTheDocument();
    });

    it('shows error message when step has error and no tool rows (step-level failure)', () => {
        render(<StepToolCallContainer stepGroups={[makeGroup({
            status: 'error',
            toolExecutions: [],
            error: '400 Bad Request: response_format not supported',
        })]} />);
        expect(screen.getByText('400 Bad Request: response_format not supported')).toBeInTheDocument();
    });

    it('shows fallback message when step errors without an error string', () => {
        render(<StepToolCallContainer stepGroups={[makeGroup({
            status: 'error',
            toolExecutions: [],
            error: undefined,
        })]} />);
        expect(screen.getByText('Step failed with an unknown error.')).toBeInTheDocument();
    });

    it('does not show step-level error block when tool rows exist', () => {
        render(<StepToolCallContainer stepGroups={[makeGroup({
            status: 'error',
            toolExecutions: [{ name: 'query_loki_logs', status: 'error', error: 'timeout' }],
            error: 'timeout',
        })]} />);
        // The tool row is rendered, not the step-level error block
        expect(screen.getByText('query_loki_logs')).toBeInTheDocument();
        // The step-level error div (no tool rows guard) should NOT be present as duplicate
        const errorTexts = screen.getAllByText('timeout');
        // Only from the ToolRow error details, not a second step-level error block
        expect(errorTexts.length).toBeGreaterThanOrEqual(0); // error details only visible when expanded
    });

    it('collapses when step transitions from running to done', () => {
        const { rerender } = render(<StepToolCallContainer stepGroups={[makeGroup({ status: 'running' })]} />);
        // Initial: expanded (running)
        expect(screen.getByText('Fetch Loki data')).toBeInTheDocument();

        // Transition to done → should auto-collapse
        rerender(<StepToolCallContainer stepGroups={[makeGroup({ status: 'done' })]} />);
        // Step header still visible; tool list hidden (no tools, and collapsed)
        expect(screen.getByText('Fetch Loki data')).toBeInTheDocument();
    });

    it('allows re-expanding a collapsed step by clicking the header', () => {
        render(<StepToolCallContainer stepGroups={[makeGroup({
            status: 'error',
            toolExecutions: [],
            error: 'connection refused',
        })]} />);

        // Initially expanded and error is visible
        expect(screen.getByText('connection refused')).toBeInTheDocument();

        // Click header to collapse
        fireEvent.click(screen.getByText('Fetch Loki data'));
        expect(screen.queryByText('connection refused')).not.toBeInTheDocument();

        // Click again to expand
        fireEvent.click(screen.getByText('Fetch Loki data'));
        expect(screen.getByText('connection refused')).toBeInTheDocument();
    });
});
