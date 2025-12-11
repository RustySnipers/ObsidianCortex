import { App, TFile } from 'obsidian';

export type ModelProvider = 'gemini-pro' | 'claude-sonnet' | 'gpt-4o';

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
}

export interface ILLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }[];
}

export interface IToolResult {
  name: string;
  success: boolean;
  output: string;
  data?: any;
}

export interface IToolDefinition {
  name: string;
  description: string;
  schema: Record<string, any>;
}

export interface ITool extends IToolDefinition {
  handler: (args: Record<string, any>) => Promise<IToolResult>;
}

export interface ISearchResult {
  content: string;
  filePath: string;
  blockId: string;
  score: number;
  highlights?: string[];
}

export interface IVectorIndexBinding {
  app: App;
  file: TFile;
  content: string;
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
