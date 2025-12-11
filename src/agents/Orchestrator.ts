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

    const baseMessages: ModelMessage[] = [
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

    let workingMessages = [...baseMessages];
    for (let step = 0; step < 3; step++) {
      const execution = await this.router.complete({
        task: 'execute',
        prompt: query,
        messages: workingMessages,
        tools: this.tools.getDefinitions(),
      });

      if (execution.toolCalls && execution.toolCalls.length) {
        for (const call of execution.toolCalls) {
          const result = await this.tools.runTool(call.name, call.arguments);
          workingMessages.push({
            role: 'assistant',
            content: `Observation: ${result.output}`,
          });
        }
        workingMessages.push({ role: 'user', content: 'Continue with updated state and provide the next step.' });
        continue;
      }

      const research = await this.router.complete({
        task: 'research',
        prompt: query,
        context: contextText,
        messages: workingMessages,
      });
      return research.text;
    }

    const fallback = await this.router.complete({ task: 'chat', prompt: query, context: contextText });
    return fallback.text;
  }
}
