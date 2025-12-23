// Chat session and history related type definitions

import { Message } from './llm.types';

/**
 * A saved chat session with metadata
 */
export interface ChatSession {
    id: string;
    title: string;
    messages: Message[];
    createdAt: number;
    updatedAt: number;
    isPinned?: boolean;
}
