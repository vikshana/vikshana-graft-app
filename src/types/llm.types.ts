// LLM and AI-related type definitions

/**
 * Represents the execution status and details of a tool call
 */
export interface ToolExecution {
    name: string;
    status: 'pending' | 'success' | 'error';
    error?: string;
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
 * A single step in an agent plan, stored on the message for history persistence.
 */
export interface AgentPlanStep {
    id: string;
    description: string;
    toolCategories: string[];
}

/**
 * Agent plan attached to an assistant message produced by the multi-agent orchestrator.
 * Stored here so the plan is visible when loading a past chat session.
 */
export interface AgentPlan {
    reasoning: string;
    steps: AgentPlanStep[];
}

/**
 * Tool executions belonging to a single specialist step, used in the
 * multi-agent path to group tool calls by step and prevent parallel
 * specialists from overwriting each other's state.
 */
export interface StepToolExecutions {
    stepId: string;
    /** Human-readable step description shown as the group header */
    stepDescription: string;
    toolExecutions: ToolExecution[];
    /** 'running' while the specialist is executing, 'done' when it finishes */
    status: 'running' | 'done' | 'error';
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
    /** Flat tool executions — used by the single-agent path */
    toolExecutions?: ToolExecution[];
    /** Step-grouped tool executions — used by the multi-agent orchestrator path */
    stepToolExecutions?: StepToolExecutions[];
    /** Agent plan produced by the orchestrator planner — rendered as a collapsible block */
    agentPlan?: AgentPlan;
    /** True once the planner has finished and specialists have started executing */
    agentPlanComplete?: boolean;
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
