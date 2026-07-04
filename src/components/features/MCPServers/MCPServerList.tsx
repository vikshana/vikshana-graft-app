import React, { useState } from 'react';
import { Alert, Badge, Button, IconButton, Spinner, Tooltip } from '@grafana/ui';
import { css } from '@emotion/css';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';

import { useMCPServers, deleteMCPServer, reconnectMCPServer, MCPServer } from './useMCPServers';
import { MCPAddServerModal } from './MCPAddServerModal';
import { MCPToolList } from './MCPToolList';

const getStyles = (theme: GrafanaTheme2) => ({
  header: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: ${theme.spacing(2)};
  `,
  title: css`
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    margin: 0;
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
  `,
  th: css`
    text-align: left;
    padding: ${theme.spacing(1, 2)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    font-weight: ${theme.typography.fontWeightMedium};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    text-transform: uppercase;
    letter-spacing: 0.06em;
  `,
  td: css`
    padding: ${theme.spacing(1.5, 2)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    vertical-align: middle;
  `,
  url: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-family: ${theme.typography.fontFamilyMonospace};
    word-break: break-all;
  `,
  connectError: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.error.text};
    margin-top: ${theme.spacing(0.25)};
  `,
  actions: css`
    display: flex;
    gap: ${theme.spacing(0.5)};
    align-items: center;
  `,
  empty: css`
    text-align: center;
    padding: ${theme.spacing(6)};
    color: ${theme.colors.text.secondary};
  `,
});

export function MCPServerList() {
  const styles = useStyles2(getStyles);
  const { servers, loading, error, reload } = useMCPServers();
  const [showAddModal, setShowAddModal] = useState(false);
  const [toolServer, setToolServer] = useState<MCPServer | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleDelete = async (server: MCPServer) => {
    if (!window.confirm(`Remove MCP server "${server.name}"?`)) {
      return;
    }
    setActionLoading(`delete-${server.id}`);
    try {
      await deleteMCPServer(server.id);
      reload();
    } finally {
      setActionLoading(null);
    }
  };

  const handleReconnect = async (server: MCPServer) => {
    setActionLoading(`reconnect-${server.id}`);
    try {
      await reconnectMCPServer(server.id);
      reload();
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return <Spinner />;
  }

  return (
    <>
      <div className={styles.header}>
        <h4 className={styles.title}>MCP Servers</h4>
        <Button icon="plus" variant="primary" data-testid="mcp-add-server-btn" onClick={() => setShowAddModal(true)}>
          Add Server
        </Button>
      </div>

      {error && (
        <Alert title="Failed to load MCP servers" severity="error">
          {error}
        </Alert>
      )}

      {servers.length === 0 && !error ? (
        <div className={styles.empty}>
          <p>No MCP servers configured.</p>
          <Button icon="plus" onClick={() => setShowAddModal(true)}>
            Add your first server
          </Button>
        </div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>Name</th>
              <th className={styles.th}>URL</th>
              <th className={styles.th}>Status</th>
              <th className={styles.th}>Tools</th>
              <th className={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((server) => (
              <tr key={server.id} data-testid={`mcp-server-row-${server.id}`}>
                <td className={styles.td}>{server.name}</td>
                <td className={styles.td}>
                  <div className={styles.url}>{server.url}</div>
                  {server.connect_error && (
                    <div className={styles.connectError}>{server.connect_error}</div>
                  )}
                </td>
                <td className={styles.td}>
                  {server.connected ? (
                    <Badge text="Connected" color="green" />
                  ) : (
                    <Badge text="Disconnected" color="red" />
                  )}
                </td>
                <td className={styles.td}>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid={`mcp-tools-btn-${server.id}`}
                    onClick={() => setToolServer(server)}
                  >
                    {server.tool_count} tools
                  </Button>
                </td>
                <td className={styles.td}>
                  <div className={styles.actions}>
                    <Tooltip content="Reconnect and re-discover tools">
                      <IconButton
                        name="sync"
                        aria-label="Reconnect"
                        data-testid={`mcp-reconnect-btn-${server.id}`}
                        disabled={actionLoading === `reconnect-${server.id}`}
                        onClick={() => handleReconnect(server)}
                      />
                    </Tooltip>
                    <Tooltip content="Remove server">
                      <IconButton
                        name="trash-alt"
                        aria-label="Delete"
                        data-testid={`mcp-delete-btn-${server.id}`}
                        disabled={actionLoading === `delete-${server.id}`}
                        onClick={() => handleDelete(server)}
                      />
                    </Tooltip>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <MCPAddServerModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onAdded={() => {
          setShowAddModal(false);
          reload();
        }}
      />

      {toolServer && (
        <MCPToolList
          serverId={toolServer.id}
          serverName={toolServer.name}
          onClose={() => setToolServer(null)}
        />
      )}
    </>
  );
}
