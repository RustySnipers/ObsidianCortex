export type ModelProvider = 'gemini' | 'claude' | 'openai';

export interface ICortexSettings {
  salt: string;
  passphrase: string;
  encryptedSecrets: Record<string, string>;
  preferredStorage: 'safeStorage' | 'localStorage';
  defaultAssistantModel: string;
  defaultToolModel: string;
  defaultResearchModel: string;
  autoIndex: boolean;
  persistIndex: boolean;
  indexFilePath: string;
  embeddingDimensions?: number;
  maxChunksPerFile?: number;
  chunkTokenTarget?: number;
  chunkTokenOverlap?: number;
  hybridWeights?: { keyword: number; vector: number };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCallResult {
  name: string;
  success: boolean;
  output: string;
  data?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  safety?: {
    requiresActiveFile?: boolean;
    confirm?: boolean;
  };
}

export interface Tool extends ToolDefinition {
  handler: (args: Record<string, any>) => Promise<ToolCallResult>;
}

export interface VectorSearchResult {
  content: string;
  filePath: string;
  blockId: string;
  score: number;
  highlights?: string[];
}

export type SecretLoader = (key: string) => Promise<string | null>;

export interface ModelRouterResponse {
  text: string;
  toolCalls?: { name: string; arguments: Record<string, any>; id?: string }[];
  provider?: ModelProvider;
  metadata?: Record<string, any>;
}

export interface ReActStep {
  thought: string;
  action?: string;
  observation?: string;
}

// Backwards compatibility exports for existing imports
export type ILLMMessage = LLMMessage;
export type IToolResult = ToolCallResult;
export type IToolDefinition = ToolDefinition;
export type ITool = Tool;
export type ISearchResult = VectorSearchResult;
