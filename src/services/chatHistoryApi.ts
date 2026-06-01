import { getBackendSrv } from '@grafana/runtime';
import pluginJson from '../plugin.json';
import type { ChatSession } from '../types/chat.types';

export interface ChatHistoryPayload {
  sessions: ChatSession[];
  lastActiveSessionId: string | null;
}

const RESOURCE_URL = `/api/plugins/${pluginJson.id}/resources/chat-history`;

const fetchOpts = { showErrorAlert: false };

function normalizePayload(data: ChatHistoryPayload | undefined | null): ChatHistoryPayload | null {
  if (!data) {
    return null;
  }
  return {
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    lastActiveSessionId: data.lastActiveSessionId ?? null,
  };
}

/** Use BackendSrv.get/put — fetch({ method: 'PUT' }) does not reach app plugin resources reliably. */
export async function loadChatHistoryFromServer(): Promise<ChatHistoryPayload | null> {
  try {
    const data = await getBackendSrv().get<ChatHistoryPayload>(RESOURCE_URL, fetchOpts);
    return normalizePayload(data);
  } catch (e) {
    console.warn('[Graft] Could not load chat history from server', e);
    return null;
  }
}

export async function saveChatHistoryToServer(payload: ChatHistoryPayload): Promise<boolean> {
  try {
    await getBackendSrv().put(RESOURCE_URL, payload, fetchOpts);
    return true;
  } catch (e) {
    console.warn('[Graft] Could not save chat history to server', e);
    return false;
  }
}
