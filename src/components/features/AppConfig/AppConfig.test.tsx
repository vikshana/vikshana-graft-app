import React from 'react';
import { render, screen } from '@testing-library/react';
import { PluginType } from '@grafana/data';
import AppConfig, { AppConfigProps } from './AppConfig';

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

    // Should show info banner about LLM plugin - Grafana Alert has role="status"
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/grafana llm plugin/i)).toBeInTheDocument();

    // Should show prompt library section
    expect(screen.getByText(/prompt library configuration/i)).toBeInTheDocument();

    // Should show save button (not save & test)
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

  test('does not render model configuration fields', () => {
    // @ts-ignore
    render(<AppConfig plugin={props.plugin} query={props.query} />);

    // Model config fields should NOT be present
    expect(screen.queryByText(/standard model configuration/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/deep research model configuration/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/enable standard model/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/enable deep research model/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('sk-...')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('http://host.docker.internal:11434')).not.toBeInTheDocument();
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
                    { name: 'Prompt 2', content: 'Content 2' }
                  ]
                }
              ]
            }
          ]
        }
      }
    };

    // @ts-ignore
    render(<AppConfig plugin={plugin} query={props.query} />);

    expect(screen.getByText(/currently loaded: 1 categories with 2 prompts/i)).toBeInTheDocument();
  });
});
