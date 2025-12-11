import { App, TFile } from 'obsidian';

export type CortexTask = 'research' | 'chat' | 'execute';

export type ModelProvider = 'gemini-pro' | 'claude-sonnet' | 'gpt-4o';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelRequest {
  task: CortexTask;
  prompt: string;
  context?: string;
  messages?: ModelMessage[];
  tools?: ToolSchema[];
}

export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface ModelResponse {
  text: string;
  toolCalls?: ToolCall[];
  metadata?: Record<string, any>;
  provider?: ModelProvider;
}

export interface ToolExecutionResult {
  name: string;
  success: boolean;
  output: string;
  data?: any;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export type EmbeddingProvider = 'openai' | 'transformers' | 'local-fallback';

export interface CortexChunk {
  id: string;
  content: string;
  filePath: string;
  blockId: string;
}

export interface SearchResult {
  chunk: CortexChunk;
  score: number;
}

export type SecretLoader = (key: string) => Promise<string | null>;

export interface VectorIndexBinding {
  app: App;
  file: TFile;
  content: string;
}

export interface OrchestratorContext {
  query: string;
  searchResults: SearchResult[];
  messages: ModelMessage[];
}
