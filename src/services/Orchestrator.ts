import ToolsRegistry from '../tools/Tools';
import ModelRouter from './ModelRouter';
import VectorStore from './VectorStore';
import { ILLMMessage, ISearchResult } from '../types';

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
    const messages: ILLMMessage[] = [
      {
        role: 'system',
        content:
          'You are Obsidian Cortex. Use ReAct: think, decide on a tool, observe results, and answer with concise steps. Always cite snippets using [[File#^block]] based on provided context. Only cite provided blockIds.',
      },
      {
        role: 'user',
        content: `${query}\n\nContext:\n${contextText || 'No matching notes found.'}`,
      },
    ];

    for (let step = 0; step < this.maxSteps; step++) {
      const toolDecision = await this.router.runToolCall(messages, this.tools.getSchemas());
      if (toolDecision.toolCalls?.length) {
        for (const call of toolDecision.toolCalls) {
          const result = await this.tools.runTool(call.name, call.arguments);
          messages.push({ role: 'assistant', content: `Action ${call.name}: ${JSON.stringify(call.arguments)}`, tool_call_id: call.id });
          messages.push({ role: 'tool', name: call.name, content: result.output, tool_call_id: call.id });
        }
        messages.push({ role: 'user', content: 'Continue and incorporate the new observations. Include citations if relevant.' });
        continue;
      }
      break;
    }

    const assistantResponse = await this.router.runAssistant(query, contextText, messages);
    if (assistantResponse.text) {
      return this.applyCitations(assistantResponse.text, searchResults);
    }

    const deepResearch = await this.router.runDeepResearch(query, contextText, messages);
    return this.applyCitations(deepResearch.text, searchResults);
  }

  private buildContext(results: ISearchResult[]): string {
    return results
      .map((result) => {
        const fileName = result.filePath.split('/').pop() ?? result.filePath;
        return `[[${fileName}#^${result.blockId}]]\n${result.content}`;
      })
      .join('\n\n');
  }

  private applyCitations(text: string, results: ISearchResult[]): string {
    if (!results.length) return text;
    const citations = results
      .slice(0, 5)
      .map((result) => `[[${(result.filePath.split('/').pop() ?? result.filePath)}#^${result.blockId}]]`)
      .join(' ');
    if (text.includes('[[')) return text;
    return `${text}\n\nSources: ${citations}`;
  }
}
