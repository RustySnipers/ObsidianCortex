import { App, MarkdownView, TAbstractFile, TFile, TFolder } from 'obsidian';
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
      name: 'notes',
      description: 'List notes in a folder or read the contents of a specific note.',
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'read'], description: 'Choose list or read.' },
          path: { type: 'string', description: "Folder or file path, e.g., 'Projects' or 'Projects/Idea.md'." },
        },
        required: ['action'],
      },
      handler: async (args: Record<string, any>): Promise<IToolResult> => {
        const action = (args.action ?? 'list') as 'list' | 'read';
        const path = String(args.path ?? '').trim();
        if (action === 'list') {
          const folder = path ? this.app.vault.getAbstractFileByPath(path) : this.app.vault.getRoot();
          if (!(folder instanceof TFolder)) {
            return { name: 'notes', success: false, output: 'Provide a valid folder to list notes.' };
          }
          const items = folder.children.filter(
            (child: TAbstractFile): child is TFile => child instanceof TFile && child.extension === 'md'
          );
          const summary = items.map((item: TFile) => item.path).join('\n');
          return { name: 'notes', success: true, output: summary || 'No markdown files found.' };
        }

        if (!path) {
          return { name: 'notes', success: false, output: 'A file path is required to read a note.' };
        }
        const normalized = path.endsWith('.md') ? path : `${path}.md`;
        const file = this.app.vault.getAbstractFileByPath(normalized);
        if (!(file instanceof TFile)) {
          return { name: 'notes', success: false, output: `No file found at ${normalized}.` };
        }
        try {
          const content = await this.app.vault.cachedRead(file);
          return { name: 'notes', success: true, output: content };
        } catch (error) {
          console.error('Failed to read note', error);
          return { name: 'notes', success: false, output: 'Unable to read the note.' };
        }
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
          sourcePath: { type: 'string', description: 'Existing path to the note.' },
          targetFolder: { type: 'string', description: 'Destination folder for the note.' },
          newName: { type: 'string', description: 'Optional new file name (without extension).' },
        },
        required: ['sourcePath', 'targetFolder'],
      },
      handler: async (args: Record<string, any>): Promise<IToolResult> => {
        const sourcePath = String(args.sourcePath ?? '').trim();
        const targetFolder = String(args.targetFolder ?? '').trim();
        const newName = String(args.newName ?? '').trim();
        if (!sourcePath || !targetFolder) {
          return { name: 'organize_note', success: false, output: 'Both sourcePath and targetFolder are required.' };
        }
        const file = this.app.vault.getAbstractFileByPath(sourcePath);
        if (!(file instanceof TFile)) {
          return { name: 'organize_note', success: false, output: `No file found at ${sourcePath}.` };
        }
        const destinationFolder = targetFolder.replace(/\/$/, '');
        const fileName = newName || file.name.replace(/\.md$/, '');
        const normalized = `${destinationFolder}/${fileName.endsWith('.md') ? fileName : `${fileName}.md`}`;
        try {
          await this.ensureFolders(destinationFolder);
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
