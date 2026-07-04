/**
 * MCPConfig — "MCP Servers" config tab.
 *
 * Satisfies the PluginConfigPageProps interface required by addConfigPage()
 * and delegates rendering entirely to MCPServerList.
 *
 * Unlike AppConfig/AgentConfig this tab has no Save button — it manages
 * server state directly via the orca-backend API rather than plugin jsonData.
 */

import React from 'react';
import { AppPluginMeta, PluginConfigPageProps } from '@grafana/data';

import { MCPServerList } from '../MCPServers/MCPServerList';
import type { AppPluginSettings } from '../../../types/settings.types';

export interface MCPConfigProps extends PluginConfigPageProps<AppPluginMeta<AppPluginSettings>> {}

const MCPConfig = (_props: MCPConfigProps) => <MCPServerList />;

export default MCPConfig;
