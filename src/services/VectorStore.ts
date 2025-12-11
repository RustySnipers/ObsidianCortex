import { App, Plugin, TAbstractFile, TFile } from 'obsidian';
import { ISearchResult, SecretLoader } from '../types';

interface IndexedChunk {
  id: string;
  content: string;
  filePath: string;
  blockId: string;
  embedding: number[];
}

interface FallbackIndex {
  chunks: Map<string, IndexedChunk>;
}

export default class VectorStore {
  private db: any | FallbackIndex | null = null;
  private orama: any | null = null;
  private bindings = new Map<string, string[]>();
  private cachedChunks = new Map<string, IndexedChunk>();
  private loading = false;

  constructor(private app: App, private plugin: Plugin, private loadSecret: SecretLoader, private persistPath = '.cortex-index.json') {}

  async initialize(): Promise<void> {
    await this.ensureDatabase();
    await this.restoreIndex();
    await this.indexVault();
    this.observeVault();
  }

  async indexVault(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      await this.indexFile(file);
    }
    await this.persistIndex();
  }

  async indexFile(file: TFile): Promise<void> {
    await this.ensureDatabase();
    const content = await this.app.vault.read(file);
    const chunks = this.chunkByHeaders(content, file.path);
    await this.removeBindings(file.path);
    for (const chunk of chunks) {
      await this.insertChunk(chunk);
    }
    this.bindings.set(file.path, chunks.map((chunk) => chunk.id));
    await this.persistIndex();
  }

  async removeFile(filePath: string): Promise<void> {
    await this.removeBindings(filePath);
    await this.persistIndex();
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const ids = this.bindings.get(oldPath);
    if (!ids) return;
    for (const id of ids) {
      const chunk = this.cachedChunks.get(id);
      if (!chunk) continue;
      const updated: IndexedChunk = { ...chunk, filePath: newPath };
      this.cachedChunks.set(id, updated);
      if (this.orama) {
        await this.orama.insert(this.db, updated);
      } else {
        (this.db as FallbackIndex).chunks.set(id, updated);
      }
    }
    this.bindings.delete(oldPath);
    this.bindings.set(newPath, ids);
    await this.persistIndex();
  }

  async search(query: string, limit = 6): Promise<ISearchResult[]> {
    await this.ensureDatabase();
    const bm25Results = await this.keywordSearch(query, limit * 2);
    const vectorResults = await this.vectorSearch(query, limit * 2);
    const combined = new Map<string, ISearchResult>();

    const maxBm25 = bm25Results.length ? bm25Results[0].score : 1;
    const maxVector = vectorResults.length ? vectorResults[0].score : 1;

    for (const result of bm25Results) {
      const normalized = maxBm25 ? result.score / maxBm25 : 0;
      combined.set(result.blockId, { ...result, score: normalized * 0.55 });
    }

    for (const result of vectorResults) {
      const normalized = maxVector ? result.score / maxVector : 0;
      const weighted = normalized * 0.45;
      const existing = combined.get(result.blockId);
      if (existing) {
        existing.score += weighted;
      } else {
        combined.set(result.blockId, { ...result, score: weighted });
      }
    }

    return Array.from(combined.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private observeVault(): void {
    const modifyRef = this.app.vault.on('modify', (file) => this.handleModify(file));
    const deleteRef = this.app.vault.on('delete', (file) => this.handleDelete(file));
    const renameRef = this.app.vault.on('rename', (file, oldPath) => this.handleRename(file, oldPath));
    this.plugin.registerEvent(modifyRef);
    this.plugin.registerEvent(deleteRef);
    this.plugin.registerEvent(renameRef);
  }

  private async handleModify(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    await this.indexFile(file);
  }

  private async handleDelete(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    await this.removeFile(file.path);
  }

  private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    await this.renameFile(oldPath, file.path);
  }

  private async ensureDatabase(): Promise<void> {
    if (this.db || this.loading) return;
    this.loading = true;
    try {
      const orama = await import('@orama/orama');
      this.orama = orama;
      this.db = await orama.create({
        schema: {
          id: 'string',
          content: 'string',
          filePath: 'string',
          blockId: 'string',
        },
      });
    } catch (error) {
      console.warn('Orama unavailable; using fallback index.', error);
      this.db = { chunks: new Map<string, IndexedChunk>() };
    } finally {
      this.loading = false;
    }
  }

  private async insertChunk(chunk: IndexedChunk): Promise<void> {
    this.cachedChunks.set(chunk.id, chunk);
    if (this.orama) {
      await this.orama.insert(this.db, chunk);
    } else {
      (this.db as FallbackIndex).chunks.set(chunk.id, chunk);
    }
  }

  private async removeBindings(filePath: string): Promise<void> {
    const ids = this.bindings.get(filePath);
    if (!ids) return;
    for (const id of ids) {
      this.cachedChunks.delete(id);
      if (this.orama) {
        await this.orama.remove(this.db, id);
      } else {
        (this.db as FallbackIndex).chunks.delete(id);
      }
    }
    this.bindings.delete(filePath);
  }

  private chunkByHeaders(content: string, filePath: string): IndexedChunk[] {
    const lines = content.split(/\r?\n/);
    const chunks: IndexedChunk[] = [];
    let buffer: string[] = [];
    let header = 'Document';
    let sectionIndex = 0;

    const flush = () => {
      const text = buffer.join('\n').trim();
      if (!text) {
        buffer = [];
        return;
      }
      const blockId = this.createBlockId(filePath, header, sectionIndex++);
      const embedding = this.simpleFrequencyEmbedding(text);
      chunks.push({
        id: `${filePath}::${blockId}`,
        content: text,
        filePath,
        blockId,
        embedding,
      });
      buffer = [];
    };

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,2})\s+(.*)/);
      if (headingMatch) {
        flush();
        header = headingMatch[2]?.trim() || `Section ${sectionIndex + 1}`;
        continue;
      }
      buffer.push(line);
    }
    flush();

    if (!chunks.length) {
      const fallbackSections = content.split(/\n\n+/);
      fallbackSections.forEach((section, idx) => {
        const trimmed = section.trim();
        if (!trimmed) return;
        const blockId = this.createBlockId(filePath, 'section', idx);
        chunks.push({
          id: `${filePath}::${blockId}`,
          content: trimmed,
          filePath,
          blockId,
          embedding: this.simpleFrequencyEmbedding(trimmed),
        });
      });
    }

    return chunks;
  }

  private createBlockId(filePath: string, header: string, index: number): string {
    const base = `${filePath}-${header}-${index}`;
    return `block-${this.hashString(base).slice(0, 8)}`;
  }

  private hashString(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = (hash << 5) - hash + input.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }

  private async keywordSearch(query: string, limit: number): Promise<ISearchResult[]> {
    if (this.orama) {
      const results = await this.orama.search(this.db, {
        term: query,
        properties: ['content', 'filePath'],
        limit,
      });
      return results.hits.map((hit: any) => ({
        content: hit.document.content,
        filePath: hit.document.filePath,
        blockId: hit.document.blockId,
        score: hit.score,
      }));
    }
    const tokens = this.tokenize(query);
    const matches: ISearchResult[] = [];
    for (const chunk of this.cachedChunks.values()) {
      const score = this.simpleMatchScore(chunk.content, tokens);
      if (score > 0) {
        matches.push({ content: chunk.content, filePath: chunk.filePath, blockId: chunk.blockId, score });
      }
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private async vectorSearch(query: string, limit: number): Promise<ISearchResult[]> {
    const embedding = this.simpleFrequencyEmbedding(query);
    const results: ISearchResult[] = [];
    for (const chunk of this.cachedChunks.values()) {
      const score = this.cosineSimilarity(embedding, chunk.embedding);
      results.push({ content: chunk.content, filePath: chunk.filePath, blockId: chunk.blockId, score });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  private simpleMatchScore(text: string, tokens: string[]): number {
    const haystack = text.toLowerCase();
    return tokens.reduce((acc, token) => (haystack.includes(token) ? acc + 1 : acc), 0);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const minLen = Math.min(a.length, b.length);
    if (!minLen) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < minLen; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB) || 1;
    return dot / denominator;
  }

  private simpleFrequencyEmbedding(text: string): number[] {
    const tokens = this.tokenize(text);
    const freq = new Map<string, number>();
    tokens.forEach((token) => freq.set(token, (freq.get(token) ?? 0) + 1));
    const sorted = Array.from(freq.keys()).sort();
    const vector = sorted.map((key) => freq.get(key) ?? 0);
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  }

  private async persistIndex(): Promise<void> {
    if (!this.plugin || !this.persistPath) return;
    const payload = {
      bindings: Array.from(this.bindings.entries()),
      chunks: Array.from(this.cachedChunks.values()).map((chunk) => ({
        id: chunk.id,
        content: chunk.content,
        filePath: chunk.filePath,
        blockId: chunk.blockId,
        embedding: chunk.embedding,
      })),
    };
    const serialized = JSON.stringify(payload);
    const existing = this.app.vault.getAbstractFileByPath(this.persistPath);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, () => serialized);
    } else {
      await this.app.vault.create(this.persistPath, serialized);
    }
  }

  private async restoreIndex(): Promise<void> {
    if (!this.persistPath) return;
    const existing = this.app.vault.getAbstractFileByPath(this.persistPath);
    if (!(existing instanceof TFile)) return;
    try {
      const content = await this.app.vault.read(existing);
      const payload = JSON.parse(content) as { bindings: [string, string[]][]; chunks: IndexedChunk[] };
      this.bindings = new Map(payload.bindings);
      payload.chunks.forEach((chunk) => {
        this.cachedChunks.set(chunk.id, chunk);
        if (this.orama) {
          this.orama.insert(this.db, chunk);
        } else {
          (this.db as FallbackIndex).chunks.set(chunk.id, chunk);
        }
      });
    } catch (error) {
      console.warn('Failed to restore index, rebuilding from vault.', error);
    }
  }
}
