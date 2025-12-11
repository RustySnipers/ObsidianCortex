import ToolsRegistry from '../tools/Tools';
import ModelRouter from './ModelRouter';
import VectorStore from './VectorStore';
import { LLMMessage, VectorSearchResult } from '../types';

export default class Orchestrator {
  private maxSteps = 4;

  constructor(
    private router: ModelRouter,
    private vectorStore: VectorStore,
    private tools: ToolsRegistry
  ) {}

  async run(query: string): Promise<string> {
    const searchResults = await this.vectorStore.search(query, 6);
    const contextText = this.buildContext(searchResults);
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are Obsidian Cortex. Use ReAct: think, decide on a tool, observe results, and answer with concise steps. Always cite snippets using [[File#^block]] based on provided context. Only cite provided blockIds.',
      },
      { role: 'user', content: query },
      { role: 'system', content: `Context:\n${contextText || 'No matching notes found.'}` },
    ];

    for (let step = 0; step < this.maxSteps; step++) {
      const toolDecision = await this.router.route('tools', { messages, tools: this.tools.getSchemas() });
      if (toolDecision.toolCalls?.length) {
        const assistantToolMessage = {
          role: 'assistant' as const,
          content: toolDecision.text ?? null,
          tool_calls: toolDecision.toolCalls.map((call, index) => ({
            id: call.id ?? `call_${Date.now()}_${index}`,
            type: 'function' as const,
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments ?? {}),
            },
          })),
        } satisfies LLMMessage;
        messages.push(assistantToolMessage);

        for (const call of toolDecision.toolCalls) {
          const toolCallId = call.id ??
            assistantToolMessage.tool_calls?.find((c) => c.function.name === call.name)?.id ??
            `call_${Date.now()}`;
          const result = await this.tools.runTool(call.name, call.arguments);
          messages.push({ role: 'tool', name: call.name, content: result.output, tool_call_id: toolCallId });
        }
        messages.push({
          role: 'user',
          content: 'Continue reasoning with the new observations. Include citations where relevant.',
        });
        continue;
      }
      break;
    }

    const assistantResponse = await this.router.route('assistant', { messages, context: contextText });
    if (assistantResponse.text) {
      return this.applyCitations(assistantResponse.text, searchResults);
    }

    const deepResearch = await this.router.route('research', { messages, context: contextText });
    return this.applyCitations(deepResearch.text, searchResults);
  }

  private buildContext(results: VectorSearchResult[]): string {
    return results
      .map((result) => {
        const fileName = result.filePath.split('/').pop() ?? result.filePath;
        return `[[${fileName}#^${result.blockId}]]\n${result.content}`;
      })
      .join('\n\n');
  }

  private applyCitations(text: string, results: VectorSearchResult[]): string {
    if (!results.length) return text;
    const citations = results
      .slice(0, 5)
      .map((result) => `[[${(result.filePath.split('/').pop() ?? result.filePath)}#^${result.blockId}]]`)
      .join(' ');
    if (text.includes('[[')) return text;
    return `${text}\n\nSources: ${citations}`;
  }
}
