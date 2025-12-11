import {
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ToolCall,
  SecretLoader,
} from '../types';

interface GeminiCacheEntry {
  id: string;
  created: number;
  summary: string;
}

export default class ModelRouter {
  private geminiCache = new Map<string, GeminiCacheEntry>();

  constructor(private loadSecret: SecretLoader) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    switch (request.task) {
      case 'research':
        return this.callGeminiPro(request);
      case 'chat':
        return this.callClaudeSonnet(request);
      case 'execute':
      default:
        return this.callGpt4o(request);
    }
  }

  private async callGeminiPro(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = await this.getApiKey(['gemini', 'google']);
    if (!apiKey) {
      return { text: 'Gemini API key is missing. Please store a key labeled "gemini" or "google".' };
    }
    const cache = request.context ? await this.cacheVaultContext(apiKey, request.context) : null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${encodeURIComponent(
      apiKey
    )}`;
    const messages: ModelMessage[] = request.messages ?? [{ role: 'user', content: request.prompt }];
    const payload: Record<string, any> = {
      contents: messages.map((message) => ({ role: message.role, parts: [{ text: message.content }] })),
    };
    if (cache) {
      payload.cachedContent = { name: cache.id };
      payload.tools = [
        {
          functionDeclarations: [
            {
              name: 'context_cache',
              description: cache.summary,
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
      ];
    }

    const response = await this.safeJsonRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text =
      response?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text).join('\n') ??
      'Gemini did not return a response.';
    return { text, metadata: { cacheId: cache?.id } };
  }

  private async cacheVaultContext(apiKey: string, context: string): Promise<GeminiCacheEntry | null> {
    const digest = await this.digestText(context);
    const existing = this.geminiCache.get(digest);
    if (existing) return existing;

    const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${encodeURIComponent(apiKey)}`;
    const payload = {
      displayName: 'Obsidian Cortex cached context',
      contents: [{ parts: [{ text: context.slice(0, 15000) }] }],
    };
    const response = await this.safeJsonRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const id: string | undefined = response?.name;
    if (!id) return null;
    const summary = `Cached vault context reference ${id}`;
    const entry = { id, created: Date.now(), summary };
    this.geminiCache.set(digest, entry);
    return entry;
  }

  private async callClaudeSonnet(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = await this.getApiKey(['anthropic', 'claude']);
    if (!apiKey) {
      return { text: 'Anthropic API key is missing. Please store a key labeled "anthropic" or "claude".' };
    }
    const body = {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: (request.messages ?? [{ role: 'user', content: request.prompt }]).map((message) => ({
        role: message.role,
        content: [{ type: 'text', text: message.content }],
      })),
    };
    const response = await this.safeJsonRequest('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'anthropic-cache-control': 'max-age=86400',
      },
      body: JSON.stringify(body),
    });
    const text = response?.content?.[0]?.text ?? 'Claude did not return a response.';
    return { text, metadata: { cache: 'persona' } };
  }

  private async callGpt4o(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = await this.getApiKey(['openai']);
    if (!apiKey) {
      return { text: 'OpenAI API key is missing. Please store it via the secure storage command.' };
    }
    const messages = request.messages ?? [{ role: 'user', content: request.prompt }];
    const body: Record<string, any> = {
      model: 'gpt-4o-mini',
      messages,
    };
    if (request.tools && request.tools.length) {
      body.tools = request.tools.map((tool) => ({ type: 'function', function: tool }));
      body.tool_choice = 'auto';
    }
    const response = await this.safeJsonRequest('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const choice = response?.choices?.[0];
    const text: string = choice?.message?.content ?? 'The model did not return content.';
    const toolCalls: ToolCall[] | undefined = choice?.message?.tool_calls?.map((call: any) => {
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(call.function?.arguments ?? '{}');
      } catch (error) {
        console.error('Failed to parse tool call arguments', error);
      }
      return { name: call.function?.name, arguments: args };
    });
    return { text, toolCalls };
  }

  private async getApiKey(candidates: string[]): Promise<string | null> {
    for (const key of candidates) {
      const value = await this.loadSecret(key);
      if (value) return value;
    }
    return null;
  }

  private async safeJsonRequest(url: string, init: RequestInit): Promise<any> {
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        console.error('ModelRouter request failed', response.status, response.statusText);
        return null;
      }
      return await response.json();
    } catch (error) {
      console.error('ModelRouter request error', error);
      return null;
    }
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
