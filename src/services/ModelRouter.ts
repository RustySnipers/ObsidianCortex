import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { ILLMMessage, ModelRouterResponse, SecretLoader } from '../types';

interface GeminiCacheEntry {
  id: string;
  digest: string;
  created: number;
}

const CLAUDE_PERSONA_PROMPT =
  'You are Claude 3.5 Sonnet acting as the personal assistant within Obsidian Cortex. Use concise, actionable responses and respect vault citations when provided. System prompts are cacheable; do not expose cache details to the user.';

export default class ModelRouter {
  private geminiCache = new Map<string, GeminiCacheEntry>();
  private openaiClient: OpenAI | null = null;
  private anthropicClient: Anthropic | null = null;
  private geminiClient: GoogleGenerativeAI | null = null;

  constructor(private loadSecret: SecretLoader) {}

  async runDeepResearch(prompt: string, context: string, messages: ILLMMessage[]): Promise<ModelRouterResponse> {
    const apiKey = await this.getApiKey(['gemini', 'google', 'gemini-pro']);
    if (!apiKey) {
      return { text: 'Gemini API key is missing. Please store a key labeled "gemini" or "google".' };
    }
    const cacheEntry = await this.ensureGeminiCache(apiKey, context);
    const model = this.getGeminiClient(apiKey).getGenerativeModel({ model: 'gemini-1.5-pro' });
    const contents = messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : message.role,
      parts: [{ text: message.content }],
    }));
    const result = await model.generateContent({
      contents,
      systemInstruction: cacheEntry ? { text: 'Cached vault context available.' } : undefined,
      tools: cacheEntry
        ? [
            {
              functionDeclarations: [
                {
                  name: 'vault_context_cache',
                  description: 'Provides cached vault context for retrieval augmented responses.',
                  parameters: { type: 'object', properties: {} },
                },
              ],
            },
          ]
        : undefined,
      cachedContent: cacheEntry ? { name: cacheEntry.id } : undefined,
      generationConfig: { temperature: 0.3 },
      contentsDelta: cacheEntry ? undefined : undefined,
    });
    const responseText = result.response?.candidates?.[0]?.content?.parts?.map((part) => part.text).join('\n') ??
      result.response?.text() ??
      'Gemini did not return a response.';
    return { text: responseText, metadata: { cacheId: cacheEntry?.id }, provider: 'gemini-pro' };
  }

  async runAssistant(prompt: string, context: string, messages: ILLMMessage[]): Promise<ModelRouterResponse> {
    const apiKey = await this.getApiKey(['anthropic', 'claude']);
    if (!apiKey) {
      return { text: 'Anthropic API key is missing. Please store a key labeled "anthropic" or "claude".' };
    }
    const client = this.getAnthropicClient(apiKey);
    const combinedMessages = [
      {
        role: 'system' as const,
        content: [
          {
            type: 'text',
            text: CLAUDE_PERSONA_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      ...messages.map((message) => ({
        role: message.role,
        content: [{ type: 'text', text: message.content }],
      })),
      { role: 'user' as const, content: [{ type: 'text', text: `Context:\n${context}` }] },
    ];
    const completion = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: combinedMessages as any,
    });
    const text = completion.content?.[0]?.text ?? 'Claude did not return a response.';
    return { text, metadata: { cache: 'ephemeral' }, provider: 'claude-sonnet' };
  }

  async runToolCall(messages: ILLMMessage[], tools: any[]): Promise<ModelRouterResponse> {
    const apiKey = await this.getApiKey(['openai']);
    if (!apiKey) {
      return { text: 'OpenAI API key is missing. Please store it via the secure storage command.' };
    }
    const client = this.getOpenAIClient(apiKey);
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools: tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.schema,
        },
      })),
      tool_choice: 'auto',
      temperature: 0.2,
    });
    const choice = completion.choices[0];
    const text = choice.message.content ?? '';
    const toolCalls = choice.message.tool_calls?.map((call) => {
      let args: Record<string, any> = {};
      try {
        args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
      } catch (error) {
        console.error('Failed to parse tool call arguments', error);
      }
      return { name: call.function.name, arguments: args, id: call.id };
    });
    return { text, toolCalls, provider: 'gpt-4o' };
  }

  private getOpenAIClient(apiKey: string): OpenAI {
    if (!this.openaiClient) {
      this.openaiClient = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
    }
    return this.openaiClient;
  }

  private getAnthropicClient(apiKey: string): Anthropic {
    if (!this.anthropicClient) {
      this.anthropicClient = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    }
    return this.anthropicClient;
  }

  private getGeminiClient(apiKey: string): GoogleGenerativeAI {
    if (!this.geminiClient) {
      this.geminiClient = new GoogleGenerativeAI(apiKey);
    }
    return this.geminiClient;
  }

  private async ensureGeminiCache(apiKey: string, context: string): Promise<GeminiCacheEntry | null> {
    const digest = await this.digestText(context);
    const existing = this.geminiCache.get(digest);
    if (existing) return existing;

    const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${encodeURIComponent(apiKey)}`;
    const payload = {
      displayName: 'Obsidian Cortex cached context',
      contents: [{ parts: [{ text: context.slice(0, 20000) }] }],
    };
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) return null;
      const data = await response.json();
      const entry: GeminiCacheEntry = { id: data?.name, digest, created: Date.now() };
      this.geminiCache.set(digest, entry);
      return entry;
    } catch (error) {
      console.error('Failed to cache Gemini context', error);
      return null;
    }
  }

  private async getApiKey(candidates: string[]): Promise<string | null> {
    for (const key of candidates) {
      const value = await this.loadSecret(key);
      if (value) return value;
    }
    return null;
  }

  private async digestText(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
}
