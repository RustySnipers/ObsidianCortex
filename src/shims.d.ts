declare module 'obsidian' {
  export class App {
    vault: any;
    workspace: any;
    fileManager: any;
  }
  export class Plugin {
    app: App;
    manifest: any;
    addCommand(command: any): any;
    addRibbonIcon(icon: string, title: string, callback: () => void): any;
    addSettingTab(tab: any): any;
    registerView(type: string, callback: (leaf: WorkspaceLeaf) => any): any;
    registerEvent(eventRef: any): void;
    loadData(): Promise<any>;
    saveData(data: any): Promise<void>;
  }
  export class PluginManifest {
    id: string;
  }
  export class WorkspaceLeaf {}
  export class ItemView {
    constructor(leaf: WorkspaceLeaf);
    getViewType(): string;
    getDisplayText(): string;
    icon: string;
    contentEl: HTMLElement;
    containerEl: HTMLElement;
    onClose(): void;
  }
  export class Modal {
    app: App;
    contentEl: HTMLElement;
    constructor(app: App);
    open(): void;
    close(): void;
    onOpen(): void;
    onClose(): void;
  }
  export class Notice {
    constructor(message: string);
  }
  export class PluginSettingTab {
    containerEl: HTMLElement;
    constructor(app: App, plugin: Plugin);
    display(): void;
  }
  export class Setting {
    constructor(containerEl: HTMLElement);
    setName(name: string): this;
    setDesc(desc: string): this;
    addToggle(cb: (toggle: any) => any): this;
    addText(cb: (text: any) => any): this;
    addDropdown(cb: (dropdown: any) => any): this;
    addButton(cb: (button: any) => any): this;
  }
  export class TAbstractFile {
    path: string;
    name: string;
  }
  export class TFile extends TAbstractFile {
    extension: string;
  }
  export class TFolder extends TAbstractFile {
    children: TAbstractFile[];
  }
  export class MarkdownView {}
}

interface HTMLElement {
  [key: string]: any;
  empty: () => void;
  createEl: (tag: string, options?: any) => HTMLElement;
}

declare module '@anthropic-ai/sdk' {
  const Anthropic: any;
  export default Anthropic;
}

declare module '@google/generative-ai' {
  export class GoogleGenerativeAI {
    constructor(apiKey: string);
    getGenerativeModel(config: any): any;
  }
}

declare module 'openai' {
  const OpenAI: any;
  export default OpenAI;
}
