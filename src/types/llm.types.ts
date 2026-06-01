// LLM and AI-related type definitions

/**
 * Represents the execution status and details of a tool call
 */
export interface ToolExecution {
    name: string;
    status: 'pending' | 'success' | 'error';
    error?: string;
    /** Matches OpenAI tool_call id for reliable status updates */
    toolCallId?: string;
    /** Short human-readable outcome (e.g. saved dashboard version) */
    summary?: string;
}

/**
 * File attachment that can be sent with messages
 */
export interface Attachment {
    name: string;
    content: string; // base64 for images, text content for text files
    type: 'image' | 'text';
    mimeType?: string; // MIME type for images (e.g., 'image/png', 'image/jpeg')
}

/**
 * A message in the conversation
 */
export interface Message {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    attachments?: Attachment[];
    interrupted?: boolean;
    thinkingSeconds?: number;
    tool_call_id?: string;
    tool_calls?: any[];
    toolExecutions?: ToolExecution[];
}

/**
 * Request payload for chat completions
 */
export interface ChatRequest {
    messages: Message[];
    model?: string;
    provider?: string;
    context?: any;
}
