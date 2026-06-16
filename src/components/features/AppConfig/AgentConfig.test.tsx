import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { PluginType } from '@grafana/data';
import AgentConfig, { AgentConfigProps } from './AgentConfig';

// Mutable mock for getBackendSrv so individual tests can override it
const mockGet = jest.fn().mockResolvedValue({ tools: [] });
const mockFetch = jest.fn().mockReturnValue({
  subscribe: ({ next, complete }: any) => {
    next({ data: {} });
    if (complete) { complete(); }
    return { unsubscribe: jest.fn() };
  },
});

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getBackendSrv: () => ({
    get: (...args: any[]) => mockGet(...args),
    post: jest.fn(),
    fetch: (...args: any[]) => mockFetch(...args),
  }),
}));

const makeProps = (jsonData: any = {}): AgentConfigProps =>
  ({
    plugin: {
      meta: {
        id: 'sample-app',
        name: 'Sample App',
        type: PluginType.app,
        enabled: true,
        jsonData,
      },
    },
    query: {},
  } as unknown as AgentConfigProps);

describe('Components/AgentConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({ tools: [] });
    mockFetch.mockReturnValue({
      subscribe: ({ next, complete }: any) => {
        next({ data: {} });
        if (complete) { complete(); }
        return { unsubscribe: jest.fn() };
      },
    });
  });

  describe('Tool Access section', () => {
    it('renders all four category rows', async () => {
      await act(async () => {
        render(<AgentConfig {...makeProps()} />);
      });

      expect(screen.getByTestId('tool-category-loki')).toBeInTheDocument();
      expect(screen.getByTestId('tool-category-prometheus')).toBeInTheDocument();
      expect(screen.getByTestId('tool-category-dashboards')).toBeInTheDocument();
      expect(screen.getByTestId('tool-category-datasources')).toBeInTheDocument();
    });

    it('tool lists are collapsed by default', async () => {
      await act(async () => {
        render(<AgentConfig {...makeProps()} />);
      });

      expect(screen.queryByTestId('tool-list-loki')).not.toBeInTheDocument();
      expect(screen.queryByTestId('tool-list-prometheus')).not.toBeInTheDocument();
    });

    it('clicking the category header expands the tool list', async () => {
      await act(async () => {
        render(<AgentConfig {...makeProps()} />);
      });

      fireEvent.click(screen.getByTestId('tool-category-header-loki'));

      expect(screen.getByTestId('tool-list-loki')).toBeInTheDocument();
      expect(screen.getByTestId('tool-checkbox-query_loki_logs')).toBeInTheDocument();
    });

    it('clicking header again collapses the tool list', async () => {
      await act(async () => {
        render(<AgentConfig {...makeProps()} />);
      });

      fireEvent.click(screen.getByTestId('tool-category-header-loki'));
      expect(screen.getByTestId('tool-list-loki')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('tool-category-header-loki'));
      expect(screen.queryByTestId('tool-list-loki')).not.toBeInTheDocument();
    });

    it('clicking the checkbox does NOT toggle expand (stopPropagation)', async () => {
      await act(async () => {
        render(<AgentConfig {...makeProps()} />);
      });

      expect(screen.queryByTestId('tool-list-loki')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('tool-category-checkbox-loki'));
      expect(screen.queryByTestId('tool-list-loki')).not.toBeInTheDocument();
    });

    it('shows search input for categories with more than 5 tools', async () => {
      await act(async () => {
        render(<AgentConfig {...makeProps()} />);
      });

      fireEvent.click(screen.getByTestId('tool-category-header-prometheus'));
      expect(screen.getByTestId('tool-search-prometheus')).toBeInTheDocument();
    });

    it('does not show search for categories with 5 or fewer tools', async () => {
      await act(async () => {
        render(<AgentConfig {...makeProps()} />);
      });

      fireEvent.click(screen.getByTestId('tool-category-header-datasources'));
      expect(screen.queryByTestId('tool-search-datasources')).not.toBeInTheDocument();
    });

    it('search filters visible tool checkboxes by name', async () => {
      await act(async () => {
        render(<AgentConfig {...makeProps()} />);
      });

      fireEvent.click(screen.getByTestId('tool-category-header-prometheus'));

      expect(screen.getByTestId('tool-checkbox-query_prometheus')).toBeInTheDocument();
      expect(screen.getByTestId('tool-checkbox-list_prometheus_metric_names')).toBeInTheDocument();

      const searchWrapper = screen.getByTestId('tool-search-prometheus');
      const searchInput = searchWrapper.querySelector('input') ?? searchWrapper;
      fireEvent.change(searchInput, { target: { value: 'list_prometheus' } });

      expect(screen.queryByTestId('tool-checkbox-query_prometheus')).not.toBeInTheDocument();
      expect(screen.getByTestId('tool-checkbox-list_prometheus_metric_names')).toBeInTheDocument();
    });

    it('tool list renders tool rows', async () => {
      await act(async () => {
        render(<AgentConfig {...makeProps()} />);
      });

      fireEvent.click(screen.getByTestId('tool-category-header-loki'));

      const toolList = screen.getByTestId('tool-list-loki');
      expect(toolList.children.length).toBeGreaterThan(0);
    });

    it('shows Other group when backend returns unknown tools', async () => {
      mockGet.mockResolvedValue({
        tools: [
          { name: 'query_loki_logs' },          // known — should not appear in Other
          { name: 'alerting_manage_routing' },   // unknown — should appear in Other
          { name: 'fetch_pyroscope_profile' },   // unknown
        ],
      });

      await act(async () => {
        render(<AgentConfig {...makeProps()} />);
      });

      await waitFor(() => {
        expect(screen.getByTestId('tool-category-other')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('tool-category-header-other'));
      expect(screen.getByTestId('tool-checkbox-alerting_manage_routing')).toBeInTheDocument();
      expect(screen.getByTestId('tool-checkbox-fetch_pyroscope_profile')).toBeInTheDocument();
      // Known tools should NOT appear in Other
      expect(screen.queryByTestId('tool-checkbox-query_loki_logs')).not.toBeInTheDocument();
    });

    it('does not show Other group when all returned tools are known', async () => {
      mockGet.mockResolvedValue({
        tools: [{ name: 'query_loki_logs' }, { name: 'query_prometheus' }],
      });

      await act(async () => {
        render(<AgentConfig {...makeProps()} />);
      });

      await waitFor(() => {
        expect(screen.queryByTestId('tool-category-other')).not.toBeInTheDocument();
      });
    });
  });

  describe('Agent Behaviour section', () => {
    it('renders maxToolIterations input with default value 50', async () => {
      await act(async () => {
        render(<AgentConfig {...makeProps()} />);
      });

      const input = screen.getByTestId('max-tool-iterations-input');
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute('min', '1');
      expect(input).toHaveAttribute('max', '100');
      expect((input as HTMLInputElement).value).toBe('50');
    });

    it('loads maxToolIterations from jsonData', async () => {
      await act(async () => {
        render(<AgentConfig {...makeProps({ maxToolIterations: 75 })} />);
      });

      const input = screen.getByTestId('max-tool-iterations-input') as HTMLInputElement;
      expect(input.value).toBe('75');
    });

    it('description mentions the dashboard agent 2× multiplier', async () => {
      await act(async () => {
        render(<AgentConfig {...makeProps()} />);
      });

      expect(screen.getByText(/dashboard agent.*twice/i)).toBeInTheDocument();
    });
  });

  describe('Save', () => {
    it('merges with existing jsonData (preserves promptLibrary)', async () => {
      const existingJsonData = {
        promptLibrary: [{ id: 'cat1', name: 'Cat 1', subCategories: [] }],
        maxToolIterations: 30,
      };

      render(<AgentConfig {...makeProps(existingJsonData)} />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              jsonData: expect.objectContaining({
                promptLibrary: existingJsonData.promptLibrary,
              }),
            }),
          })
        );
      });
    });
  });
});
