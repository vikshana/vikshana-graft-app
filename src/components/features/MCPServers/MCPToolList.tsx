import React, { useEffect, useState } from 'react';
import { Drawer, Switch, Spinner } from '@grafana/ui';
import { css } from '@emotion/css';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';

import { fetchMCPServerTools, toggleMCPTool, MCPTool } from './useMCPServers';

interface Props {
  serverId: string;
  serverName: string;
  onClose: () => void;
}

const getStyles = (theme: GrafanaTheme2) => ({
  list: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(2)};
  `,
  row: css`
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: ${theme.spacing(1.5)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
  `,
  toolInfo: css`
    flex: 1;
    margin-right: ${theme.spacing(2)};
  `,
  toolName: css`
    font-weight: ${theme.typography.fontWeightMedium};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  toolDesc: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin-top: ${theme.spacing(0.5)};
  `,
  qualifiedName: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.disabled};
    font-family: ${theme.typography.fontFamilyMonospace};
  `,
  empty: css`
    color: ${theme.colors.text.secondary};
    text-align: center;
    padding: ${theme.spacing(4)};
  `,
});

export function MCPToolList({ serverId, serverName, onClose }: Props) {
  const styles = useStyles2(getStyles);
  const [tools, setTools] = useState<MCPTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchMCPServerTools(serverId)
      .then(setTools)
      .finally(() => setLoading(false));
  }, [serverId]);

  const handleToggle = async (tool: MCPTool) => {
    setToggling(tool.name);
    try {
      await toggleMCPTool(serverId, tool.name, !tool.enabled);
      setTools((prev) =>
        prev.map((t) => (t.name === tool.name ? { ...t, enabled: !t.enabled } : t))
      );
    } finally {
      setToggling(null);
    }
  };

  return (
    <Drawer title={`Tools — ${serverName}`} onClose={onClose}>
      {loading ? (
        <Spinner />
      ) : tools.length === 0 ? (
        <div className={styles.empty}>No tools discovered for this server.</div>
      ) : (
        <div className={styles.list}>
          {tools.map((tool) => (
            <div key={tool.name} className={styles.row} data-testid={`mcp-tool-row-${tool.name}`}>
              <div className={styles.toolInfo}>
                <div className={styles.toolName}>{tool.name}</div>
                {tool.description && (
                  <div className={styles.toolDesc}>{tool.description}</div>
                )}
                <div className={styles.qualifiedName}>{tool.qualified_name}</div>
              </div>
              <Switch
                data-testid={`mcp-tool-toggle-${tool.name}`}
                value={tool.enabled}
                disabled={toggling === tool.name}
                onChange={() => handleToggle(tool)}
              />
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}
