import React, { useState } from 'react';
import { Button, Field, Input, Modal, Select } from '@grafana/ui';
import { css } from '@emotion/css';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { SelectableValue } from '@grafana/data';

import { addMCPServer, MCPServer } from './useMCPServers';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAdded: (server: MCPServer) => void;
}

const TRANSPORT_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'SSE (Server-Sent Events)', value: 'sse' },
];

const getStyles = (theme: GrafanaTheme2) => ({
  form: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(2)};
  `,
  error: css`
    color: ${theme.colors.error.text};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  actions: css`
    display: flex;
    gap: ${theme.spacing(1)};
    justify-content: flex-end;
    margin-top: ${theme.spacing(2)};
  `,
});

export function MCPAddServerModal({ isOpen, onClose, onAdded }: Props) {
  const styles = useStyles2(getStyles);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [transport, setTransport] = useState('sse');
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!name.trim() || !url.trim()) {
      setError('Name and URL are required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const server = await addMCPServer({
        name: name.trim(),
        url: url.trim(),
        transport,
        token: token.trim() || undefined,
      });
      setName('');
      setUrl('');
      setToken('');
      onAdded(server);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to add server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Add MCP Server" isOpen={isOpen} onDismiss={onClose}>
      <div className={styles.form}>
        {error && <div className={styles.error} data-testid="mcp-add-error">{error}</div>}
        <Field label="Name" required>
          <Input
            data-testid="mcp-add-name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="e.g. GitHub MCP"
          />
        </Field>
        <Field label="SSE Endpoint URL" required>
          <Input
            data-testid="mcp-add-url"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            placeholder="https://api.example.com/mcp/sse"
          />
        </Field>
        <Field label="Transport">
          <Select
            options={TRANSPORT_OPTIONS}
            value={transport}
            onChange={(v: SelectableValue<string>) => setTransport(v.value ?? 'sse')}
          />
        </Field>
        <Field label="Bearer Token" description="Optional. Stored encrypted at rest.">
          <Input
            data-testid="mcp-add-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.currentTarget.value)}
            placeholder="Optional"
          />
        </Field>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={loading}>
            {loading ? 'Connecting…' : 'Add Server'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
