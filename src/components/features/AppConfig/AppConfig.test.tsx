import React from 'react';
import { render, screen } from '@testing-library/react';
import { PluginType } from '@grafana/data';
import AppConfig, { AppConfigProps } from './AppConfig';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getBackendSrv: () => ({
    post: jest.fn(),
    fetch: jest.fn().mockReturnValue({
      subscribe: ({ next, complete }: any) => {
        next({ data: {} });
        if (complete) { complete(); }
        return { unsubscribe: jest.fn() };
      },
    }),
  }),
}));

describe('Components/AppConfig', () => {
  let props: AppConfigProps;

  beforeEach(() => {
    jest.resetAllMocks();

    props = {
      plugin: {
        meta: {
          id: 'sample-app',
          name: 'Sample App',
          type: PluginType.app,
          enabled: true,
          jsonData: {},
        },
      },
      query: {},
    } as unknown as AppConfigProps;
  });

  test('renders the simplified config page with info banner', () => {
    // @ts-ignore
    render(<AppConfig plugin={props.plugin} query={props.query} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/grafana llm plugin/i)).toBeInTheDocument();
    expect(screen.getByText(/prompt library configuration/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save & test/i })).not.toBeInTheDocument();
  });

  test('renders link to LLM plugin configuration', () => {
    // @ts-ignore
    render(<AppConfig plugin={props.plugin} query={props.query} />);

    const link = screen.getByRole('link', { name: /grafana llm plugin/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/plugins/grafana-llm-app');
  });

  test('renders link to Agent tab', () => {
    // @ts-ignore
    render(<AppConfig plugin={props.plugin} query={props.query} />);

    const agentLink = screen.getByRole('link', { name: /agent tab/i });
    expect(agentLink).toBeInTheDocument();
    expect(agentLink).toHaveAttribute('href', `/plugins/sample-app?page=agent`);
  });

  test('does not render model configuration fields', () => {
    // @ts-ignore
    render(<AppConfig plugin={props.plugin} query={props.query} />);

    expect(screen.queryByText(/standard model configuration/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/deep research model configuration/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('sk-...')).not.toBeInTheDocument();
  });

  test('does not render Tool Access or Agent Behaviour sections (moved to Agent tab)', () => {
    // @ts-ignore
    render(<AppConfig plugin={props.plugin} query={props.query} />);

    // These FieldSet headings should NOT be present — they live in AgentConfig now
    expect(screen.queryByRole('group', { name: /tool access/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /agent behaviour/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('max-tool-iterations-input')).not.toBeInTheDocument();
  });

  test('handles prompt library file upload container exists', async () => {
    // @ts-ignore
    render(<AppConfig plugin={props.plugin} query={props.query} />);

    const container = screen.getByTestId('prompt-library-upload-container');
    expect(container).toBeInTheDocument();
  });

  test('shows download button', () => {
    // @ts-ignore
    render(<AppConfig plugin={props.plugin} query={props.query} />);

    expect(screen.getByText(/download current config/i)).toBeInTheDocument();
  });

  test('shows prompt count when prompts are loaded', () => {
    const plugin = {
      meta: {
        ...props.plugin.meta,
        jsonData: {
          promptLibrary: [
            {
              id: 'test',
              name: 'Test',
              subCategories: [
                {
                  id: 'sub1',
                  name: 'Sub 1',
                  prompts: [
                    { name: 'Prompt 1', content: 'Content 1' },
                    { name: 'Prompt 2', content: 'Content 2' },
                  ],
                },
              ],
            },
          ],
        },
      },
    };

    // @ts-ignore
    render(<AppConfig plugin={plugin} query={props.query} />);

    expect(screen.getByText(/currently loaded: 1 categories with 2 prompts/i)).toBeInTheDocument();
  });
});
