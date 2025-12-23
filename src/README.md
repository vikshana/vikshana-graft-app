# Graft: AI Assistant for Grafana

[![License](https://img.shields.io/github/license/vikshana/vikshana-graft-app)](https://github.com/vikshana/vikshana-graft-app/blob/main/LICENSE)

An open-source AI assistant plugin for Grafana, enabling natural language interaction with your observability data.

## Features

- **Natural Language Queries** - Ask questions about your dashboards, metrics, logs, traces, alerts or more
- **Dual Model Support** - Configure separate models for quick responses (Standard) and complex reasoning tasks (Deep Research/Thinking)
- **Multiple LLM Providers** - Works with Anthropic, OpenAI-compatible APIs as well as Ollama, and LM Studio for local inference
- **Grafana MCP Tools** - Leverage Grafana's built-in MCP tools for interacting with your Grafana instance
- **Chat History** - Browse and continue previous conversations
- **Prompt Library** - Save and reuse commonly used prompts with customizable templates

## Screenshots

### Chat Interface
![Chat Interface](https://raw.githubusercontent.com/vikshana/vikshana-graft-app/main/src/img/landing_page.png)

### Tool Execution
![Tool Execution](https://raw.githubusercontent.com/vikshana/vikshana-graft-app/main/src/img/chat_tool_call.png)

### Rich Content Rendering
![Mermaid Charts](https://raw.githubusercontent.com/vikshana/vikshana-graft-app/main/src/img/chat_mermaid_charts_rendering.png)

### Prompt Library
![Prompt Library](https://raw.githubusercontent.com/vikshana/vikshana-graft-app/main/src/img/prompt_library.png)

### Previous Conversations
![Previous Conversations](https://raw.githubusercontent.com/vikshana/vikshana-graft-app/main/src/img/previous_conversations.png)

## Requirements

- Grafana 10.4.0 or later
- [Grafana LLM Plugin](https://grafana.com/grafana/plugins/grafana-llm-app/) 1.0.0 or later
- An LLM provider (OpenAI, Anthropic, or Ollama/LM Studio for local inference)

## Installation

1. Download the latest release from the [Releases page](https://github.com/vikshana/vikshana-graft-app/releases)
2. Extract the archive to your Grafana plugins directory (typically `/var/lib/grafana/plugins/`)
3. Restart Grafana

## Configuration

1. Navigate to **Administration > Plugins > Graft AI Assistant**
2. Click **Enable** to activate the plugin

### LLM Configuration

Graft uses the Grafana LLM Plugin for model configuration. Configure your LLM providers in the [Grafana LLM Plugin settings](https://grafana.com/grafana/plugins/grafana-llm-app/).

## Usage

1. Click **Graft AI Assistant** in the Grafana sidebar under App section
2. Type your question in the chat input
3. Toggle between **Standard** and **Deep Research** modes as needed
4. View tool executions and reasoning in expandable sections

### Example Queries

- "What's the current CPU usage across all nodes?"
- "Show me error rates for the payment service over the last hour"
- "Explain the spike in memory usage I'm seeing on the dashboard"
- "Help me create an alert for when response times exceed 500ms"

## Development

See [Development Guide](https://github.com/vikshana/vikshana-graft-app/blob/main/docs/development.md) for build instructions, testing, and local development setup.

## Contributing

Contributions are welcome! Please visit the [GitHub repository](https://github.com/vikshana/vikshana-graft-app) to submit issues or pull requests.

## License

Graft is distributed under AGPL-3.0. See [LICENSE](https://github.com/vikshana/vikshana-graft-app/blob/main/LICENSE) for details.
