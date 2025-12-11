import ModelRouter from '../services/ModelRouter';
import VectorStore from '../services/VectorStore';
import ToolDefinitions from '../tools/ToolDefinitions';
import { ModelMessage } from '../types';

export default class Orchestrator {
  constructor(
    private router: ModelRouter,
    private vectorStore: VectorStore,
    private tools: ToolDefinitions
  ) {}

  async run(query: string): Promise<string> {
    const searchResults = await this.vectorStore.search(query, 6);
    const contextText = searchResults
      .map((result) => `- (${result.chunk.filePath}#${result.chunk.blockId}) ${result.chunk.content}`)
      .join('\n');

    const messages: ModelMessage[] = [
      {
        role: 'system',
        content:
          'You are the Obsidian Cortex cognitive engine. Use ReAct: think, choose a tool if needed, observe, and answer succinctly.',
      },
      {
        role: 'user',
        content: `${query}\n\nLocal context:\n${contextText || 'No matching notes found.'}`,
      },
    ];

    let finalResponse = '';
    for (let step = 0; step < 3; step++) {
      const response = await this.router.complete({
        task: 'execute',
        prompt: query,
        messages,
        tools: this.tools.getDefinitions(),
      });
      finalResponse = response.text;
      if (response.toolCalls && response.toolCalls.length) {
        for (const call of response.toolCalls) {
          const result = await this.tools.runTool(call.name, call.arguments);
          messages.push({
            role: 'assistant',
            content: `Tool ${result.name} responded (${result.success ? 'success' : 'failure'}): ${result.output}`,
          });
        }
        messages.push({ role: 'user', content: 'Continue after executing the tool and return the final answer.' });
        continue;
      }
      break;
    }

    return finalResponse;
  }
}
