import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { PluginType } from '@grafana/data';
import AgentConfig, { AgentConfigProps } from './AgentConfig';

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

  describe('OSS section', () => {
    it('renders Grafana OSS tier header', async () => {
      await act(async () => { render(<AgentConfig {...makeProps()} />); });
      expect(screen.getByTestId('tier-header-oss')).toBeInTheDocument();
    });

    it('renders all four fixed categories under OSS header', async () => {
      await act(async () => { render(<AgentConfig {...makeProps()} />); });

      expect(screen.getByTestId('tool-category-loki')).toBeInTheDocument();
      expect(screen.getByTestId('tool-category-prometheus')).toBeInTheDocument();
      expect(screen.getByTestId('tool-category-dashboards')).toBeInTheDocument();
      expect(screen.getByTestId('tool-category-datasources')).toBeInTheDocument();
    });

    it('shows discovered OSS categories when MCP returns their tools', async () => {
      mockGet.mockResolvedValue({
        tools: [
          { name: 'alerting_manage_routing' },
          { name: 'alerting_manage_rules' },
          { name: 'get_alert_group' },
          { name: 'list_alert_groups' },
        ],
      });

      await act(async () => { render(<AgentConfig {...makeProps()} />); });

      await waitFor(() => {
        expect(screen.getByTestId('tool-category-alerting')).toBeInTheDocument();
      });
    });
  });

  describe('Cloud / Enterprise section', () => {
    it('does not show Cloud section when no cloud tools are present', async () => {
      mockGet.mockResolvedValue({ tools: [] });
      await act(async () => { render(<AgentConfig {...makeProps()} />); });
      expect(screen.queryByTestId('tier-header-cloud')).not.toBeInTheDocument();
    });

    it('shows Cloud section when OnCall tools are present', async () => {
      mockGet.mockResolvedValue({
        tools: [
          { name: 'get_current_oncall_users' },
          { name: 'list_oncall_schedules' },
          { name: 'list_oncall_teams' },
          { name: 'list_oncall_users' },
          { name: 'get_oncall_shift' },
        ],
      });

      await act(async () => { render(<AgentConfig {...makeProps()} />); });

      await waitFor(() => {
        expect(screen.getByTestId('tier-header-cloud')).toBeInTheDocument();
        expect(screen.getByTestId('tool-category-oncall')).toBeInTheDocument();
      });
    });
  });

  describe('Unrecognised tools section', () => {
    it('does not show unrecognised section when all tools are categorised', async () => {
      mockGet.mockResolvedValue({
        tools: [{ name: 'query_loki_logs' }],
      });
      await act(async () => { render(<AgentConfig {...makeProps()} />); });
      await waitFor(() => {
        expect(screen.queryByTestId('tier-header-unknown')).not.toBeInTheDocument();
      });
    });

    it('shows unrecognised section for truly unknown tools', async () => {
      mockGet.mockResolvedValue({
        tools: [
          { name: 'query_loki_logs' },
          { name: 'some_brand_new_tool' },
        ],
      });

      await act(async () => { render(<AgentConfig {...makeProps()} />); });

      await waitFor(() => {
        expect(screen.getByTestId('tier-header-unknown')).toBeInTheDocument();
        expect(screen.getByTestId('tool-category-other')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('tool-category-header-other'));
      expect(screen.getByTestId('tool-checkbox-some_brand_new_tool')).toBeInTheDocument();
      // Categorised tools should not appear in Other
      expect(screen.queryByTestId('tool-checkbox-query_loki_logs')).not.toBeInTheDocument();
    });
  });

  describe('Category expand / collapse', () => {
    it('tool lists are collapsed by default', async () => {
      await act(async () => { render(<AgentConfig {...makeProps()} />); });
      expect(screen.queryByTestId('tool-list-loki')).not.toBeInTheDocument();
    });

    it('clicking category header expands tool list', async () => {
      await act(async () => { render(<AgentConfig {...makeProps()} />); });
      fireEvent.click(screen.getByTestId('tool-category-header-loki'));
      expect(screen.getByTestId('tool-list-loki')).toBeInTheDocument();
      expect(screen.getByTestId('tool-checkbox-query_loki_logs')).toBeInTheDocument();
    });

    it('clicking header again collapses tool list', async () => {
      await act(async () => { render(<AgentConfig {...makeProps()} />); });
      fireEvent.click(screen.getByTestId('tool-category-header-loki'));
      fireEvent.click(screen.getByTestId('tool-category-header-loki'));
      expect(screen.queryByTestId('tool-list-loki')).not.toBeInTheDocument();
    });

    it('checkbox click does not toggle expand', async () => {
      await act(async () => { render(<AgentConfig {...makeProps()} />); });
      fireEvent.click(screen.getByTestId('tool-category-checkbox-loki'));
      expect(screen.queryByTestId('tool-list-loki')).not.toBeInTheDocument();
    });
  });

  describe('Search', () => {
    it('shows search for categories with more than 5 tools', async () => {
      await act(async () => { render(<AgentConfig {...makeProps()} />); });
      fireEvent.click(screen.getByTestId('tool-category-header-prometheus'));
      expect(screen.getByTestId('tool-search-prometheus')).toBeInTheDocument();
    });

    it('does not show search for categories with 5 or fewer tools', async () => {
      await act(async () => { render(<AgentConfig {...makeProps()} />); });
      fireEvent.click(screen.getByTestId('tool-category-header-datasources'));
      expect(screen.queryByTestId('tool-search-datasources')).not.toBeInTheDocument();
    });

    it('search filters visible tool checkboxes', async () => {
      await act(async () => { render(<AgentConfig {...makeProps()} />); });
      fireEvent.click(screen.getByTestId('tool-category-header-prometheus'));

      const searchWrapper = screen.getByTestId('tool-search-prometheus');
      const searchInput = searchWrapper.querySelector('input') ?? searchWrapper;
      fireEvent.change(searchInput, { target: { value: 'list_prometheus' } });

      expect(screen.queryByTestId('tool-checkbox-query_prometheus')).not.toBeInTheDocument();
      expect(screen.getByTestId('tool-checkbox-list_prometheus_metric_names')).toBeInTheDocument();
    });
  });

  describe('Agent Behaviour', () => {
    it('renders maxToolIterations with default 50, range 1-100', async () => {
      await act(async () => { render(<AgentConfig {...makeProps()} />); });
      const input = screen.getByTestId('max-tool-iterations-input');
      expect(input).toHaveAttribute('min', '1');
      expect(input).toHaveAttribute('max', '100');
      expect((input as HTMLInputElement).value).toBe('50');
    });

    it('loads maxToolIterations from jsonData', async () => {
      await act(async () => { render(<AgentConfig {...makeProps({ maxToolIterations: 75 })} />); });
      expect((screen.getByTestId('max-tool-iterations-input') as HTMLInputElement).value).toBe('75');
    });

    it('description mentions dashboard agent 2× multiplier', async () => {
      await act(async () => { render(<AgentConfig {...makeProps()} />); });
      expect(screen.getByText(/dashboard agent.*twice/i)).toBeInTheDocument();
    });
  });

  describe('Save', () => {
    it('merges with existing jsonData (preserves promptLibrary)', async () => {
      const existingJsonData = {
        promptLibrary: [{ id: 'cat1', name: 'Cat', subCategories: [] }],
      };
      await act(async () => { render(<AgentConfig {...makeProps(existingJsonData)} />); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^save$/i })); });
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
