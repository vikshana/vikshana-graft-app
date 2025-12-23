// Common type definitions used across the application

/**
 * Model type for LLM configuration
 */
export type ModelType = 'standard' | 'thinking';

/**
 * File type for attachments
 */
export type FileType = 'image' | 'text';

/**
 * Generic status type
 */
export type Status = 'idle' | 'loading' | 'success' | 'error';
