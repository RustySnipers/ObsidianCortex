import { App, Plugin, TAbstractFile, TFile } from 'obsidian';
import { CortexChunk, SearchResult } from '../types';

interface FallbackIndex {
  chunks: Map<string, CortexChunk>;
}

export default class VectorStore {
  private db: any | FallbackIndex | null = null;
  private orama: any | null = null;
  private embeddings = new Map<string, number[]>();
  private fileBindings = new Map<string, string[]>();
  private chunkCache = new Map<string, CortexChunk>();

  constructor(private app: App, private plugin: Plugin) {}

  async initialize(): Promise<void> {
    await this.ensureDatabase();
    await this.indexExistingNotes();
    this.observeVault();
  }

  private async ensureDatabase(): Promise<void> {
    if (this.db) return;
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
      console.warn('Orama is unavailable; using fallback in-memory index.', error);
      this.db = { chunks: new Map<string, CortexChunk>() };
    }
  }

  private observeVault(): void {
    const ref = this.app.vault.on('modify', (file) => this.handleModify(file));
    this.plugin.registerEvent(ref);
  }

  private async handleModify(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    await this.indexFile(file);
  }

  private async indexExistingNotes(): Promise<void> {
    const markdownFiles = this.app.vault.getMarkdownFiles();
    for (const file of markdownFiles) {
      await this.indexFile(file);
    }
  }

  async indexFile(file: TFile): Promise<void> {
    await this.ensureDatabase();
    const content = await this.app.vault.read(file);
    const chunks = this.chunkByHeaders(content, file.path);
    await this.removeFileChunks(file.path);
    for (const chunk of chunks) {
      await this.insertChunk(chunk);
    }
    this.fileBindings.set(
      file.path,
      chunks.map((chunk) => chunk.id)
    );
  }

  private async insertChunk(chunk: CortexChunk): Promise<void> {
    if (!this.db) return;
    this.embeddings.set(chunk.id, this.embed(chunk.content));
    this.chunkCache.set(chunk.id, chunk);
    if (this.orama) {
      await this.orama.insert(this.db, chunk);
    } else {
      (this.db as FallbackIndex).chunks.set(chunk.id, chunk);
    }
  }

  private async removeFileChunks(filePath: string): Promise<void> {
    const ids = this.fileBindings.get(filePath);
    if (!ids || !this.db) return;
    for (const id of ids) {
      this.embeddings.delete(id);
      this.chunkCache.delete(id);
      if (this.orama) {
        await this.orama.remove(this.db, id);
      } else {
        (this.db as FallbackIndex).chunks.delete(id);
      }
    }
    this.fileBindings.delete(filePath);
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    await this.ensureDatabase();
    const bm25Results = await this.bm25Search(query, limit * 2);
    const vectorResults = this.vectorSearch(query);
    const combined = new Map<string, SearchResult>();

    const maxBm25 = bm25Results.length ? bm25Results[0].score : 1;
    const maxVector = vectorResults.length ? vectorResults[0].score : 1;

    for (const result of bm25Results) {
      const normalized = maxBm25 ? result.score / maxBm25 : 0;
      combined.set(result.chunk.id, { chunk: result.chunk, score: normalized * 0.6 });
    }

    for (const result of vectorResults) {
      const normalized = maxVector ? result.score / maxVector : 0;
      const existing = combined.get(result.chunk.id);
      const weighted = normalized * 0.4;
      if (existing) {
        existing.score += weighted;
      } else {
        combined.set(result.chunk.id, { chunk: result.chunk, score: weighted });
      }
    }

    return Array.from(combined.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private async bm25Search(query: string, limit: number): Promise<SearchResult[]> {
    if (!this.db) return [];
    if (this.orama) {
      const result = await this.orama.search(this.db, {
        term: query,
        properties: ['content'],
        limit,
      });
      return result.hits.map((hit: any) => ({ chunk: hit.document as CortexChunk, score: hit.score }));
    }
    const hits: SearchResult[] = [];
    const tokens = this.tokenize(query);
    (this.db as FallbackIndex).chunks.forEach((chunk) => {
      const score = this.simpleMatchScore(chunk.content, tokens);
      if (score > 0) {
        hits.push({ chunk, score });
      }
    });
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private vectorSearch(query: string): SearchResult[] {
    const queryEmbedding = this.embed(query);
    const results: SearchResult[] = [];
    for (const [id, embedding] of this.embeddings.entries()) {
      const score = this.cosineSimilarity(queryEmbedding, embedding);
      if (score <= 0) continue;
      const chunk = this.getChunkById(id);
      if (chunk) {
        results.push({ chunk, score });
      }
    }
    return results.sort((a, b) => b.score - a.score);
  }

  private getChunkById(id: string): CortexChunk | null {
    if (!this.db) return null;
    return this.chunkCache.get(id) ?? null;
  }

  private chunkByHeaders(content: string, filePath: string): CortexChunk[] {
    const lines = content.split(/\r?\n/);
    const chunks: CortexChunk[] = [];
    let buffer: string[] = [];
    let currentHeading = 'root';
    let sectionIndex = 0;

    const flush = () => {
      if (!buffer.length) return;
      const text = buffer.join('\n').trim();
      if (!text) {
        buffer = [];
        return;
      }
      const id = `${filePath}::${currentHeading}-${sectionIndex}`;
      const blockId = `${currentHeading}-${sectionIndex}`;
      chunks.push({ id, content: text, filePath, blockId });
      sectionIndex += 1;
      buffer = [];
    };

    for (const line of lines) {
      const headingMatch = /^(#+)\s+(.*)/.exec(line);
      if (headingMatch) {
        flush();
        currentHeading = this.slugify(headingMatch[2]);
        continue;
      }
      buffer.push(line);
    }
    flush();
    return chunks;
  }

  private slugify(input: string): string {
    const cleaned = input.trim().toLowerCase().replace(/[^a-z0-9\-\s]/g, '');
    return cleaned.replace(/\s+/g, '-').replace(/-+/g, '-') || 'section';
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  private embed(text: string): number[] {
    const tokens = this.tokenize(text);
    const frequencies = new Map<string, number>();
    tokens.forEach((token) => frequencies.set(token, (frequencies.get(token) ?? 0) + 1));
    const vector: number[] = [];
    const vocab = Array.from(frequencies.keys()).sort();
    for (const term of vocab) {
      vector.push(frequencies.get(term) ?? 0);
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (!a.length || !b.length) return 0;
    const minLength = Math.min(a.length, b.length);
    let dot = 0;
    for (let i = 0; i < minLength; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }

  private simpleMatchScore(text: string, tokens: string[]): number {
    let score = 0;
    const haystack = text.toLowerCase();
    for (const token of tokens) {
      if (haystack.includes(token)) {
        score += 1;
      }
    }
    return score;
  }
}
