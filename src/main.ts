import {
  App,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginManifest,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from 'obsidian';
import Orchestrator from './services/Orchestrator';
import ModelRouter from './services/ModelRouter';
import VectorStore from './services/VectorStore';
import ToolsRegistry from './tools/Tools';
import { ICortexSettings } from './types';

interface SecretStorage {
  saveSecret(key: string, value: string): Promise<void>;
  loadSecret(key: string): Promise<string | null>;
}

type ElectronSafeStorage = {
  encryptString: (value: string) => Uint8Array;
  decryptString: (data: Uint8Array) => string;
  isEncryptionAvailable: () => boolean;
};

const DEFAULT_SETTINGS: ICortexSettings = {
  salt: '',
  passphrase: '',
  encryptedSecrets: {},
  preferredStorage: 'safeStorage',
  defaultAssistantModel: 'claude-3-5-sonnet-20241022',
  defaultToolModel: 'gpt-4o-mini',
  defaultResearchModel: 'gemini-1.5-pro',
  claudePromptCacheTtlMs: 5 * 60 * 1000,
  geminiContextCacheTtlMs: 30 * 60 * 1000,
  allowedCommandIds: [],
  autoIndex: true,
  persistIndex: true,
  indexFilePath: '.cortex-index.json',
  embeddingDimensions: 384,
  maxChunksPerFile: 64,
  chunkTokenTarget: 240,
  chunkTokenOverlap: 40,
  hybridWeights: { keyword: 0.55, vector: 0.45 },
};

class DesktopSafeSecretStorage implements SecretStorage {
  private pluginId: string;

  constructor(
    manifest: PluginManifest,
    private persist: (data: Record<string, string>) => Promise<void>,
    private snapshot: () => Record<string, string>
  ) {
    this.pluginId = manifest.id;
  }

  private get electronSafeStorage(): ElectronSafeStorage | null {
    const loader = (window as unknown as { require?: (module: string) => any }).require;
    if (!loader) return null;
    const electron = loader('electron');
    if (!electron?.safeStorage?.isEncryptionAvailable()) return null;
    return electron.safeStorage as ElectronSafeStorage;
  }

  isAvailable(): boolean {
    return this.electronSafeStorage !== null;
  }

  async saveSecret(key: string, value: string): Promise<void> {
    const safeStorage = this.electronSafeStorage;
    if (!safeStorage) throw new Error(`${this.pluginId}: Desktop secure storage is unavailable.`);
    const encrypted = safeStorage.encryptString(value);
    const secrets = this.snapshot();
    const payload = new Uint8Array(encrypted);
    secrets[key] = arrayBufferToBase64(payload.buffer);
    await this.persist(secrets);
  }

  async loadSecret(key: string): Promise<string | null> {
    const safeStorage = this.electronSafeStorage;
    if (!safeStorage) return null;
    const secrets = this.snapshot();
    const encoded = secrets[key];
    if (!encoded) return null;
    try {
      const encryptedBytes = new Uint8Array(base64ToArrayBuffer(encoded));
      const nodeBuffer = (window as unknown as { Buffer?: { from: (input: Uint8Array) => Uint8Array } }).Buffer;
      const payload = nodeBuffer ? nodeBuffer.from(encryptedBytes) : encryptedBytes;
      return safeStorage.decryptString(payload);
    } catch (error) {
      console.error('Failed to decrypt secret', error);
      return null;
    }
  }
}

class LocalEncryptedStorage implements SecretStorage {
  private readonly namespace: string;

  constructor(private getSettings: () => ICortexSettings) {
    this.namespace = 'obsidian-cortex';
  }

  private storageKey(key: string): string {
    return `${this.namespace}:${key}`;
  }

  async saveSecret(key: string, value: string): Promise<void> {
    const settings = this.getSettings();
    const encrypted = await encryptString(value, settings.passphrase, settings.salt);
    localStorage.setItem(this.storageKey(key), encrypted);
  }

  async loadSecret(key: string): Promise<string | null> {
    const payload = localStorage.getItem(this.storageKey(key));
    if (!payload) return null;
    try {
      const settings = this.getSettings();
      return await decryptString(payload, settings.passphrase, settings.salt);
    } catch (error) {
      console.error('Failed to decrypt secret', error);
      return null;
    }
  }
}

export default class ObsidianCortexPlugin extends Plugin {
  settings: ICortexSettings = DEFAULT_SETTINGS;
  public storage: SecretStorage | null = null;
  private modelRouter: ModelRouter | null = null;
  private vectorStore: VectorStore | null = null;
  private tools: ToolsRegistry | null = null;
  private orchestrator: Orchestrator | null = null;

  async onload(): Promise<void> {
    console.log('Obsidian Cortex initialized.');
    await this.loadSettings();
    this.storage = this.createStorage();
    await this.initializeCognitiveEngine();
    this.registerCommands();
    this.addSettingTab(new CortexSettingTab(this.app, this));
    this.registerView(CortexChatView.VIEW_TYPE, (leaf: any) => new CortexChatView(leaf));
    this.addRibbonIcon('bot', 'Open Cortex Chat', async () => this.activateCortexChat());
  }

  onunload(): void {
    console.log('Unloading Obsidian Cortex');
  }

  private async initializeCognitiveEngine(): Promise<void> {
    const loadSecret = async (key: string) => {
      await this.ensureStorage();
      return this.storage?.loadSecret(key) ?? null;
    };
    this.modelRouter = new ModelRouter(loadSecret, {
      claudePromptCacheTtlMs: this.settings.claudePromptCacheTtlMs,
      geminiContextCacheTtlMs: this.settings.geminiContextCacheTtlMs,
    });
    const persistPath = this.settings.persistIndex ? this.settings.indexFilePath : '';
    this.vectorStore = new VectorStore(this.app, this, persistPath, {
      chunkTokenTarget: this.settings.chunkTokenTarget,
      chunkTokenOverlap: this.settings.chunkTokenOverlap,
      maxChunksPerFile: this.settings.maxChunksPerFile,
      hybridWeights: this.settings.hybridWeights,
      embeddingDimensions: this.settings.embeddingDimensions,
    });
    if (this.settings.autoIndex) {
      await this.vectorStore.initialize();
    }
    this.tools = new ToolsRegistry(this.app, this.vectorStore, this.settings.allowedCommandIds ?? []);
    this.orchestrator = new Orchestrator(this.modelRouter, this.vectorStore, this.tools, this.settings);
  }

  private createStorage(): SecretStorage {
    if (this.settings.preferredStorage === 'safeStorage') {
      const storage = new DesktopSafeSecretStorage(
        this.manifest,
        async (data) => {
          this.settings.encryptedSecrets = data;
          await this.saveSettings();
        },
        () => this.settings.encryptedSecrets
      );
      if (storage.isAvailable()) {
        return storage;
      }
    }
    return new LocalEncryptedStorage(() => this.settings);
  }

  updateStorageProvider(preferred: ICortexSettings['preferredStorage']): void {
    this.settings.preferredStorage = preferred;
    this.storage = this.createStorage();
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'obsidian-cortex-ask',
      name: 'Ask Obsidian Cortex (Agentic)',
      callback: async () => {
        const prompt = await this.promptForInput('What would you like Obsidian Cortex to handle?', false);
        if (!prompt) return;
        if (!this.orchestrator) {
          new Notice('The cognitive engine is still loading. Please try again.');
          return;
        }
        const response = await this.orchestrator.run(prompt);
        new Notice('Cortex responded. Check the console for details.');
        console.log('Cortex response', response);
      },
    });

    this.addCommand({
      id: 'obsidian-cortex-reindex',
      name: 'Rebuild Cortex index',
      callback: async () => {
        if (!this.vectorStore) return;
        await this.vectorStore.indexVault();
        new Notice('Cortex index rebuilt.');
      },
    });
  }

  private async promptForInput(placeholder: string, masked: boolean): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new PromptModal(this.app, placeholder, resolve, masked ? 'password' : 'text');
      modal.open();
    });
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async ensureStorage(): Promise<void> {
    if (!this.storage) {
      this.storage = this.createStorage();
    }
  }

  public async storeSecret(key: string, value: string): Promise<void> {
    if (!value.trim()) return;
    await this.ensureStorage();
    await this.storage?.saveSecret(key, value.trim());
  }

  private async activateCortexChat(): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: CortexChatView.VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}

class CortexChatView extends ItemView {
  static VIEW_TYPE = 'cortex-chat-view';

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return CortexChatView.VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Cortex Chat';
  }

  async onOpen(): Promise<void> {
    (this.containerEl as any).empty();
    (this.containerEl as any).createEl('div', { text: 'Cortex Chat UI coming soon.' });
  }
}

class CortexSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ObsidianCortexPlugin) {
    super(app, plugin);
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    (containerEl as any).empty();
    (containerEl as any).createEl('h2', { text: 'Obsidian Cortex — Security & Models' });

    await this.plugin.ensureStorage();
    const openaiPresent = (await this.plugin.storage?.loadSecret('openai')) ? 'Stored' : 'Not set';
    const geminiPresent = (await this.plugin.storage?.loadSecret('gemini')) ? 'Stored' : 'Not set';
    const anthropicPresent = (await this.plugin.storage?.loadSecret('anthropic')) ? 'Stored' : 'Not set';

    new Setting(containerEl)
      .setName('Preferred storage provider')
      .setDesc('Use OS-level safeStorage on desktop or a passphrase-protected localStorage fallback for mobile.')
      .addDropdown((dropdown: any) => {
        dropdown
          .addOption('safeStorage', 'Desktop safeStorage')
          .addOption('localStorage', 'Local encrypted storage')
          .setValue(this.plugin.settings.preferredStorage)
          .onChange(async (value: any) => {
            this.plugin.updateStorageProvider(value as ICortexSettings['preferredStorage']);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Passphrase')
      .setDesc('Used for deriving encryption keys when localStorage is selected. Stored in plugin data; choose a strong passphrase.')
      .addText((text: any) =>
        text
          .setPlaceholder('Enter passphrase')
          .setValue(this.plugin.settings.passphrase)
          .onChange(async (value: any) => {
            this.plugin.settings.passphrase = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Salt')
      .setDesc('Additional salt for deriving local encryption keys. Stored in plugin data.')
      .addText((text: any) =>
        text
          .setPlaceholder('Enter salt value')
          .setValue(this.plugin.settings.salt)
          .onChange(async (value: any) => {
            this.plugin.settings.salt = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('OpenAI API Key')
      .setDesc(`Status: ${openaiPresent}`)
      .addText((text: any) =>
        text
          .setPlaceholder('sk-...')
          .onChange(async (value: any) => {
            await this.plugin.storeSecret('openai', value);
          })
      );

    new Setting(containerEl)
      .setName('Gemini API Key')
      .setDesc(`Status: ${geminiPresent}`)
      .addText((text: any) =>
        text
          .setPlaceholder('AIza...')
          .onChange(async (value: any) => {
            await this.plugin.storeSecret('gemini', value);
          })
      );

    new Setting(containerEl)
      .setName('Anthropic API Key')
      .setDesc(`Status: ${anthropicPresent}`)
      .addText((text: any) =>
        text
          .setPlaceholder('sk-ant-...')
          .onChange(async (value: any) => {
            await this.plugin.storeSecret('anthropic', value);
          })
      );

    new Setting(containerEl)
      .setName('Assistant model (Claude)')
      .setDesc('Model used for the assistant persona.')
      .addText((text: any) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.defaultAssistantModel)
          .setValue(this.plugin.settings.defaultAssistantModel)
          .onChange(async (value: any) => {
            this.plugin.settings.defaultAssistantModel = value || DEFAULT_SETTINGS.defaultAssistantModel;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Tool model (GPT-4o)')
      .setDesc('Model used for function calling and tool routing.')
      .addText((text: any) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.defaultToolModel)
          .setValue(this.plugin.settings.defaultToolModel)
          .onChange(async (value: any) => {
            this.plugin.settings.defaultToolModel = value || DEFAULT_SETTINGS.defaultToolModel;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Research model (Gemini)')
      .setDesc('Model used for deep research with cached context.')
      .addText((text: any) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.defaultResearchModel)
          .setValue(this.plugin.settings.defaultResearchModel)
          .onChange(async (value: any) => {
            this.plugin.settings.defaultResearchModel = value || DEFAULT_SETTINGS.defaultResearchModel;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Auto-index vault')
      .setDesc('Automatically index notes on startup and when they change.')
      .addToggle((toggle: any) =>
        toggle.setValue(this.plugin.settings.autoIndex).onChange(async (value: any) => {
          this.plugin.settings.autoIndex = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Persist index to vault')
      .setDesc('Store the index JSON in the vault for faster reloads.')
      .addToggle((toggle: any) =>
        toggle.setValue(this.plugin.settings.persistIndex).onChange(async (value: any) => {
          this.plugin.settings.persistIndex = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Index file path')
      .setDesc('Relative path inside the vault for storing the index JSON.')
      .addText((text: any) =>
        text
          .setPlaceholder('.cortex-index.json')
          .setValue(this.plugin.settings.indexFilePath)
          .onChange(async (value: any) => {
            this.plugin.settings.indexFilePath = value || DEFAULT_SETTINGS.indexFilePath;
            await this.plugin.saveSettings();
          })
      );
  }
}

class PromptModal extends Modal {
  private resolve: (value: string | null) => void;
  private placeholder: string;
  private inputType: 'text' | 'password';

  constructor(app: App, placeholder: string, resolve: (value: string | null) => void, inputType: 'text' | 'password' = 'password') {
    super(app);
    this.resolve = resolve;
    this.placeholder = placeholder;
    this.inputType = inputType;
  }

  onOpen(): void {
    const { contentEl } = this as any;
    const inputEl = contentEl.createEl('input', { type: this.inputType });
    contentEl.createEl('h3', { text: this.placeholder });
    inputEl.placeholder = this.placeholder;
    inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        this.resolve((inputEl as any).value || null);
        this.close();
      }
    });
  }

  onClose(): void {
    (this.contentEl as any).empty();
  }
}

async function encryptString(plainText: string, passphrase: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await deriveAesKey(passphrase, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plainText));
  const combined = new Uint8Array(iv.byteLength + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.byteLength);
  return arrayBufferToBase64(combined.buffer);
}

async function decryptString(payload: string, passphrase: string, salt: string): Promise<string> {
  const data = base64ToArrayBuffer(payload);
  const iv = data.slice(0, 12);
  const cipher = data.slice(12);
  const key = await deriveAesKey(passphrase, salt);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, cipher);
  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

async function deriveAesKey(passphrase: string, salt: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
