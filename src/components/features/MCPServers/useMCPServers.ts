import { getBackendSrv } from '@grafana/runtime';
import { useCallback, useEffect, useState } from 'react';

export interface MCPServer {
  id: string;
  org_id: number;
  name: string;
  url: string;
  transport: string;
  enabled: boolean;
  created_at: string | null;
  connected: boolean;
  tool_count: number;
  connect_error: string | null;
}

export interface MCPTool {
  name: string;
  qualified_name: string;
  description: string;
  enabled: boolean;
}

const PLUGIN_ID = 'vikshana-graft-app';

function pluginUrl(path: string): string {
  return `/api/plugins/${PLUGIN_ID}/resources${path}`;
}

export function useMCPServers() {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await getBackendSrv().get<{ servers: MCPServer[] }>(pluginUrl('/mcp/servers'));
      setServers(resp.servers ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load MCP servers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { servers, loading, error, reload };
}

export async function addMCPServer(body: {
  name: string;
  url: string;
  transport: string;
  token?: string;
}): Promise<MCPServer> {
  return getBackendSrv().post<MCPServer>(pluginUrl('/mcp/servers'), body);
}

export async function deleteMCPServer(serverId: string): Promise<void> {
  return getBackendSrv().delete(pluginUrl(`/mcp/servers/${serverId}`));
}

export async function reconnectMCPServer(serverId: string): Promise<{ tool_count: number }> {
  return getBackendSrv().post<{ tool_count: number }>(pluginUrl(`/mcp/servers/${serverId}/reconnect`), {});
}

export async function fetchMCPServerTools(serverId: string): Promise<MCPTool[]> {
  const resp = await getBackendSrv().get<{ tools: MCPTool[] }>(pluginUrl(`/mcp/servers/${serverId}/tools`));
  return resp.tools ?? [];
}

export async function toggleMCPTool(serverId: string, toolName: string, enabled: boolean): Promise<void> {
  return getBackendSrv().patch(pluginUrl(`/mcp/tools/${serverId}/${toolName}`), { enabled });
}
