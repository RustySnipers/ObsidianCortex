import { App, MarkdownView, TFile } from 'obsidian';
import { ITool, IToolDefinition, IToolResult } from '../types';

export default class ToolsRegistry {
  private tools: ITool[];

  constructor(private app: App) {
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
      name: 'Notes',
      description: 'Create or overwrite a markdown note with provided content.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "Full path for the note, e.g., 'Projects/Idea.md'" },
          content: { type: 'string', description: 'Markdown content to write into the file.' },
        },
        required: ['path', 'content'],
      },
      handler: async (args: Record<string, any>): Promise<IToolResult> => {
        const path = String(args.path ?? '').trim();
        const content = String(args.content ?? '');
        if (!path) {
          return { name: 'Notes', success: false, output: 'A valid path is required.' };
        }
        const normalized = path.endsWith('.md') ? path : `${path}.md`;
        try {
          const existing = this.app.vault.getAbstractFileByPath(normalized);
          if (existing instanceof TFile) {
            await this.app.vault.process(existing, () => content);
            return { name: 'Notes', success: true, output: `Updated ${normalized}` };
          }
          await this.ensureFolders(normalized);
          await this.app.vault.create(normalized, content);
          return { name: 'Notes', success: true, output: `Created ${normalized}` };
        } catch (error) {
          console.error('Failed to write note', error);
          return { name: 'Notes', success: false, output: 'Unable to write the note.' };
        }
      },
    };
  }

  private createExecuteCommandTool(): ITool {
    return {
      name: 'execute_command',
      description: 'Execute an Obsidian command by ID with Markdown view safety checks.',
      schema: {
        type: 'object',
        properties: {
          command_id: { type: 'string', description: "Command ID, e.g., 'editor:toggle-bold'" },
        },
        required: ['command_id'],
      },
      handler: async (args: Record<string, any>): Promise<IToolResult> => {
        const commandId = String(args.command_id ?? '').trim();
        if (!commandId) {
          return { name: 'execute_command', success: false, output: 'command_id is required.' };
        }
        const commandsApi = (this.app as any).commands;
        const command = commandsApi?.listCommands?.()?.find((entry: any) => entry.id === commandId);
        if (!command) {
          return { name: 'execute_command', success: false, output: `Command ${commandId} not found.` };
        }
        const requiresEditor = Boolean(command.editorCallback || command.editorCheckCallback);
        if (requiresEditor) {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (!view) {
            return {
              name: 'execute_command',
              success: false,
              output: 'This command requires an active Markdown editor.',
            };
          }
        }
        try {
          commandsApi?.executeCommandById?.(commandId);
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
          current_path: { type: 'string', description: 'Existing path to the note.' },
          new_path: { type: 'string', description: 'Destination path for the note.' },
        },
        required: ['current_path', 'new_path'],
      },
      handler: async (args: Record<string, any>): Promise<IToolResult> => {
        const currentPath = String(args.current_path ?? '').trim();
        const newPath = String(args.new_path ?? '').trim();
        if (!currentPath || !newPath) {
          return { name: 'organize_note', success: false, output: 'Both current_path and new_path are required.' };
        }
        const file = this.app.vault.getAbstractFileByPath(currentPath);
        if (!(file instanceof TFile)) {
          return { name: 'organize_note', success: false, output: `No file found at ${currentPath}.` };
        }
        const normalized = newPath.endsWith('.md') ? newPath : `${newPath}.md`;
        try {
          await this.ensureFolders(normalized);
          await this.app.fileManager.renameFile(file, normalized);
          return { name: 'organize_note', success: true, output: `Moved note to ${normalized}.` };
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
}
