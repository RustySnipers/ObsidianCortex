import { App, MarkdownView, TFile } from 'obsidian';
import { ToolExecutionResult, ToolSchema } from '../types';

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'create_note',
    description: 'Create a new markdown note.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "Full path (e.g., 'Folder/Note.md')" },
        content: { type: 'string', description: 'Markdown content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'execute_command',
    description: 'Trigger an internal Obsidian command.',
    parameters: {
      type: 'object',
      properties: {
        command_id: { type: 'string', description: "The command ID (e.g., 'editor:toggle-bold')" },
      },
      required: ['command_id'],
    },
  },
  {
    name: 'organize_note',
    description: 'Move or rename a markdown note while preserving wikilinks.',
    parameters: {
      type: 'object',
      properties: {
        current_path: {
          type: 'string',
          description: "Existing path to the note (e.g., 'Projects/Alpha.md')",
        },
        new_path: {
          type: 'string',
          description: "Target path for the renamed note (e.g., 'Projects/Archive/Alpha.md')",
        },
      },
      required: ['current_path', 'new_path'],
    },
  },
];

export default class ToolDefinitions {
  constructor(private app: App) {}

  getDefinitions(): ToolSchema[] {
    return TOOL_SCHEMAS;
  }

  async runTool(name: string, args: Record<string, any>): Promise<ToolExecutionResult> {
    switch (name) {
      case 'create_note':
        return this.createNote(args);
      case 'execute_command':
        return this.executeCommand(args);
      case 'organize_note':
        return this.organizeNote(args);
      default:
        return { name, success: false, output: `Tool ${name} is not implemented.` };
    }
  }

  private async createNote(args: Record<string, any>): Promise<ToolExecutionResult> {
    const path = String(args.path ?? '').trim();
    const content = String(args.content ?? '');
    if (!path) {
      return { name: 'create_note', success: false, output: 'A valid path is required.' };
    }
    const normalized = path.endsWith('.md') ? path : `${path}.md`;
    try {
      await this.ensureFolders(normalized);
      const existing = this.app.vault.getAbstractFileByPath(normalized);
      if (existing instanceof TFile) {
        await this.app.vault.process(existing, () => content);
        return { name: 'create_note', success: true, output: `Updated note at ${normalized}.` };
      }
      await this.app.vault.create(normalized, content);
      return { name: 'create_note', success: true, output: `Created note at ${normalized}.` };
    } catch (error) {
      console.error('Failed to create note', error);
      return { name: 'create_note', success: false, output: 'Unable to create the note.' };
    }
  }

  private async ensureFolders(targetPath: string): Promise<void> {
    const segments = targetPath.split('/');
    segments.pop();
    let current = '';
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async executeCommand(args: Record<string, any>): Promise<ToolExecutionResult> {
    const commandId = String(args.command_id ?? '').trim();
    if (!commandId) {
      return { name: 'execute_command', success: false, output: 'A command_id is required.' };
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
  }

  private async organizeNote(args: Record<string, any>): Promise<ToolExecutionResult> {
    const currentPath = String(args.current_path ?? '').trim();
    const newPath = String(args.new_path ?? '').trim();
    if (!currentPath || !newPath) {
      return { name: 'organize_note', success: false, output: 'Both current_path and new_path are required.' };
    }
    const currentFile = this.app.vault.getAbstractFileByPath(currentPath);
    if (!(currentFile instanceof TFile)) {
      return { name: 'organize_note', success: false, output: `No file found at ${currentPath}.` };
    }
    const normalizedTarget = newPath.endsWith('.md') ? newPath : `${newPath}.md`;
    try {
      await this.ensureFolders(normalizedTarget);
      await this.app.fileManager.renameFile(currentFile, normalizedTarget);
      return { name: 'organize_note', success: true, output: `Moved note to ${normalizedTarget}.` };
    } catch (error) {
      console.error('Failed to organize note', error);
      return { name: 'organize_note', success: false, output: 'Unable to move or rename the note.' };
    }
  }
}
