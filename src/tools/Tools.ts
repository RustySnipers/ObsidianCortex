import { App, MarkdownView, TFile } from 'obsidian';
import VectorStore from '../services/VectorStore';
import { ITool, IToolDefinition, IToolResult } from '../types';

export default class ToolsRegistry {
  private tools: ITool[];

  constructor(private app: App, private vectorStore?: VectorStore, private allowedCommands: string[] = []) {
    this.tools = [this.createNotesTool(), this.createExecuteCommandTool(), this.createOrganizeNoteTool()];
  }

  getSchemas(): IToolDefinition[] {
    return this.tools.map(({ handler, schema, ...rest }) => ({ ...rest, schema }));
  }

  async runTool(name: string, args: Record<string, any>): Promise<IToolResult> {
    const tool = this.tools.find((entry) => entry.name === name);
    if (!tool) {
      return { name, success: false, output: `Tool ${name} is not implemented.` };
    }
    return tool.handler(args);
  }

  private createNotesTool(): ITool {
    return {
      name: 'notes',
      description: 'Search vault content and return citations for relevant snippets.',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for inside your vault.' },
          top_k: { type: 'number', description: 'How many results to return.', minimum: 1, maximum: 20 },
        },
        required: ['query'],
      },
      handler: async (args: Record<string, any>): Promise<IToolResult> => {
        if (!this.vectorStore) {
          return { name: 'notes', success: false, output: 'Vector search is unavailable until the index loads.' };
        }
        const query = String(args.query ?? '').trim();
        const topK = Number.isFinite(args.top_k) ? Math.max(1, Math.min(20, Number(args.top_k))) : 6;
        if (!query) {
          return { name: 'notes', success: false, output: 'Provide a query to search notes.' };
        }
        const results = await this.vectorStore.search(query, topK);
        if (!results.length) {
          return { name: 'notes', success: true, output: 'No matching notes found.' };
        }
        const formatted = results
          .map((hit) => {
            const blockRef = hit.blockRef ?? `^${hit.blockId}`;
            const cite = `[[${hit.filePath}#${blockRef}]]`;
            const heading = hit.heading ? `${hit.heading}: ` : '';
            return `${cite} ${heading}${hit.content}`.trim();
          })
          .join('\n\n');
        return { name: 'notes', success: true, output: formatted };
      },
    };
  }

  private createExecuteCommandTool(): ITool {
    return {
      name: 'execute_command',
      description: 'Execute an Obsidian command by ID with optional active file safety checks.',
      schema: {
        type: 'object',
        properties: {
          commandId: { type: 'string', description: "Command ID, e.g., 'editor:toggle-bold'" },
          args: { type: 'object', description: 'Optional arguments for the command.', additionalProperties: true },
          requiresActiveFile: {
            type: 'boolean',
            description: 'If true, ensure there is an active Markdown file before executing.',
          },
        },
        required: ['commandId'],
      },
      handler: async (args: Record<string, any>): Promise<IToolResult> => {
        const commandId = String(args.commandId ?? '').trim();
        const requiresActiveFile = Boolean(args.requiresActiveFile);
        if (!commandId) {
          return { name: 'execute_command', success: false, output: 'commandId is required.' };
        }
        const commandsApi = (this.app as any).commands;
        const command = commandsApi?.listCommands?.()?.find((entry: any) => entry.id === commandId);
        if (!command) {
          return { name: 'execute_command', success: false, output: `Command ${commandId} not found.` };
        }
        if (this.allowedCommands.length && !this.allowedCommands.includes(commandId)) {
          return { name: 'execute_command', success: false, output: 'This command is not allowlisted for automation.' };
        }
        if (requiresActiveFile) {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (!view) {
            return { name: 'execute_command', success: false, output: 'This command requires an active Markdown editor.' };
          }
        }
        try {
          commandsApi?.executeCommandById?.(commandId, args.args ?? {});
          return { name: 'execute_command', success: true, output: `Executed ${commandId}.` };
        } catch (error) {
          console.error('Failed to execute command', error);
          return { name: 'execute_command', success: false, output: 'Command execution failed.' };
        }
      },
    };
  }

  private createOrganizeNoteTool(): ITool {
    return {
      name: 'organize_note',
      description: 'Move or rename a markdown note while preserving wikilinks.',
      schema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Existing path to the note.' },
          newFolderPath: { type: 'string', description: 'Destination folder for the note.' },
          newFileName: { type: 'string', description: 'Optional new file name (without extension).' },
          newHeading: { type: 'string', description: 'Replace the first heading in the note.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of tags to ensure in the frontmatter.',
          },
        },
        required: ['filePath'],
      },
      handler: async (args: Record<string, any>): Promise<IToolResult> => {
        const sourcePath = String(args.filePath ?? '').trim();
        const targetFolder = String(args.newFolderPath ?? '').trim();
        const newFileName = String(args.newFileName ?? '').trim();
        const newHeading = String(args.newHeading ?? '').trim();
        const tags = Array.isArray(args.tags) ? args.tags.map((tag: any) => String(tag).trim()).filter(Boolean) : [];
        if (!sourcePath) {
          return { name: 'organize_note', success: false, output: 'filePath is required.' };
        }
        const file = this.app.vault.getAbstractFileByPath(sourcePath);
        if (!(file instanceof TFile)) {
          return { name: 'organize_note', success: false, output: `No file found at ${sourcePath}.` };
        }
        const currentFolder = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : '';
        const destinationFolder = targetFolder ? targetFolder.replace(/\/$/, '') : currentFolder;
        const fileName = newFileName || file.name.replace(/\.md$/, '');
        const normalized = destinationFolder
          ? `${destinationFolder}/${fileName.endsWith('.md') ? fileName : `${fileName}.md`}`
          : file.path;
        try {
          if (destinationFolder) {
            await this.ensureFolders(destinationFolder);
          }
          if (newHeading || tags.length) {
            await this.app.vault.process(file, (data: string) => this.applyNoteUpdates(data, newHeading, tags));
          }
          if (normalized !== file.path) {
            await this.app.fileManager.renameFile(file, normalized);
          }
          return { name: 'organize_note', success: true, output: `Note updated${normalized ? ` at ${normalized}` : ''}.` };
        } catch (error) {
          console.error('Failed to organize note', error);
          return { name: 'organize_note', success: false, output: 'Unable to move or rename the note.' };
        }
      },
    };
  }

  private async ensureFolders(targetPath: string): Promise<void> {
    const parts = targetPath.split('/');
    parts.pop();
    let current = '';
    for (const segment of parts) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private applyNoteUpdates(content: string, newHeading: string, tags: string[]): string {
    let updated = content;
    if (newHeading) {
      const lines = updated.split(/\r?\n/);
      const firstHeadingIndex = lines.findIndex((line) => /^#\s+/.test(line));
      if (firstHeadingIndex >= 0) {
        lines[firstHeadingIndex] = `# ${newHeading}`;
      } else {
        lines.unshift(`# ${newHeading}`);
      }
      updated = lines.join('\n');
    }

    if (tags.length) {
      const tagLine = `tags: [${tags.join(', ')}]`;
      if (updated.startsWith('---')) {
        const end = updated.indexOf('\n---', 3);
        if (end !== -1) {
          const header = updated.slice(0, end);
          const body = updated.slice(end);
          const existingTagLine = /tags:\s*\[[^\]]*\]/;
          const newHeader = existingTagLine.test(header)
            ? header.replace(existingTagLine, tagLine)
            : `${header}\n${tagLine}`;
          updated = `${newHeader}${body}`;
        }
      } else {
        updated = `---\n${tagLine}\n---\n${updated}`;
      }
    }

    return updated;
  }
}
