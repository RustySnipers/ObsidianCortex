import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginManifest,
  PluginSettingTab,
  Setting,
} from 'obsidian';
import Orchestrator from './agents/Orchestrator';
import ModelRouter from './services/ModelRouter';
import VectorStore from './services/VectorStore';
import ToolDefinitions from './tools/ToolDefinitions';

interface CortexSettings {
  salt: string;
  passphrase: string;
  encryptedSecrets: Record<string, string>;
  preferredStorage: 'safeStorage' | 'localStorage';
}

const DEFAULT_SETTINGS: CortexSettings = {
  salt: '',
  passphrase: '',
  encryptedSecrets: {},
  preferredStorage: 'safeStorage',
};

interface SecretStorage {
  saveSecret(key: string, value: string): Promise<void>;
  loadSecret(key: string): Promise<string | null>;
}

type ElectronSafeStorage = {
  encryptString: (value: string) => Uint8Array;
  decryptString: (data: Uint8Array) => string;
  isEncryptionAvailable: () => boolean;
};

class DesktopSafeSecretStorage implements SecretStorage {
  private pluginId: string;

  constructor(manifest: PluginManifest, private persist: (data: Record<string, string>) => Promise<void>, private snapshot: () => Record<string, string>) {
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

  constructor(private getSettings: () => CortexSettings) {
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
  settings: CortexSettings = DEFAULT_SETTINGS;
  private storage: SecretStorage | null = null;
  private modelRouter: ModelRouter | null = null;
  private vectorStore: VectorStore | null = null;
  private tools: ToolDefinitions | null = null;
  private orchestrator: Orchestrator | null = null;

  async onload(): Promise<void> {
    console.log('Obsidian Cortex Architect initialized. Ready to implement the Agentic OS.');
    await this.loadSettings();
    this.storage = this.createStorage();
    await this.initializeCognitiveEngine();
    this.registerCommands();
    this.addSettingTab(new CortexSettingTab(this.app, this));
  }

  onunload(): void {
    console.log('Unloading Obsidian Cortex');
  }

  private async initializeCognitiveEngine(): Promise<void> {
    const loadSecret = async (key: string) => {
      await this.ensureStorage();
      return this.storage?.loadSecret(key) ?? null;
    };
    this.modelRouter = new ModelRouter(loadSecret);
    this.tools = new ToolDefinitions(this.app);
    this.vectorStore = new VectorStore(this.app, this, loadSecret);
    await this.vectorStore.initialize();
    this.orchestrator = new Orchestrator(this.modelRouter, this.vectorStore, this.tools);
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

  updateStorageProvider(preferred: CortexSettings['preferredStorage']): void {
    this.settings.preferredStorage = preferred;
    this.storage = this.createStorage();
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'obsidian-cortex-store-openai',
      name: 'Store OpenAI API key',
      callback: async () => {
        const value = await this.promptForSecret('Enter your OpenAI API key');
        if (!value) return;
        await this.ensureStorage();
        await this.storage?.saveSecret('openai', value);
        new Notice('OpenAI API key stored securely.');
      },
    });

    this.addCommand({
      id: 'obsidian-cortex-recall-openai',
      name: 'Show OpenAI API key (for verification)',
      callback: async () => {
        await this.ensureStorage();
        const secret = await this.storage?.loadSecret('openai');
        if (!secret) {
          new Notice('No OpenAI API key found or it could not be decrypted.');
          return;
        }
        new Notice('OpenAI API key loaded. Check the log for the value.');
        console.log('OpenAI API key', secret);
      },
    });

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
  }

  private async promptForSecret(placeholder: string): Promise<string | null> {
    return this.promptForInput(placeholder, true);
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
}

class CortexSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ObsidianCortexPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Obsidian Cortex — Security Preferences' });

    new Setting(containerEl)
      .setName('Preferred storage provider')
      .setDesc('Use OS-level safeStorage on desktop or a passphrase-protected localStorage fallback for mobile.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('safeStorage', 'Desktop safeStorage')
          .addOption('localStorage', 'Local encrypted storage')
          .setValue(this.plugin.settings.preferredStorage)
          .onChange(async (value) => {
            this.plugin.updateStorageProvider(value as CortexSettings['preferredStorage']);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Passphrase')
      .setDesc('Used for deriving encryption keys when localStorage is selected. Stored in plugin data; choose a strong passphrase.')
      .addText((text) =>
        text
          .setPlaceholder('Enter passphrase')
          .setValue(this.plugin.settings.passphrase)
          .onChange(async (value) => {
            this.plugin.settings.passphrase = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Salt')
      .setDesc('Additional salt for deriving local encryption keys. Stored in plugin data.')
      .addText((text) =>
        text
          .setPlaceholder('Enter salt value')
          .setValue(this.plugin.settings.salt)
          .onChange(async (value) => {
            this.plugin.settings.salt = value;
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
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.placeholder });
    const input = contentEl.createEl('input', { type: this.inputType });
    input.placeholder = this.placeholder;
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        this.resolve(input.value || null);
        this.close();
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

async function encryptString(plainText: string, passphrase: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await deriveAesKey(passphrase, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plainText)
  );
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
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    key,
    cipher
  );
  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

async function deriveAesKey(passphrase: string, salt: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    baseKey,
    {
      name: 'AES-GCM',
      length: 256,
    },
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
