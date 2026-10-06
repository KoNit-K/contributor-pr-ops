import type { ReadApi } from './collect.js';
import { OpsError } from './errors.js';
import type { BatchResult } from './github.js';
import type { BatchKind, BatchTarget, QueryName } from './queries.js';

type Variables = Record<string, string | number | null>;
export interface BatchApi extends ReadApi { queryBatch(kind: BatchKind, targets: BatchTarget[]): Promise<BatchResult[]> }
type Pending = { target: BatchTarget; resolve(value: unknown): void; reject(error: unknown): void };

// Collectors keep their existing pagination and evidence rules. This round-local
// adapter coalesces only registered first reads. The client still sends serially.
export class BatchReader implements ReadApi {
  private pending = new Map<BatchKind, Pending[]>();
  private scheduled = new Set<BatchKind>();
  private rich = new Map<number, Promise<unknown>>();
  private finals = new Map<number, Promise<unknown>>();
  private relations = new Map<string, { at: number; value: Promise<unknown> }>();
  private dirtyFinal = new Set<number>();
  private metadata = new Set<number>();
  private group = new Set<number>();
  private ready = new Set<number>();
  private stopped?: OpsError;
  constructor(private readonly api: BatchApi, private readonly now = Date.now) {}
  begin(numbers: number[]) { this.group = new Set(numbers); this.ready.clear(); }
  finished(number: number) { this.ready.add(number); this.rich.delete(number); this.finals.delete(number); this.metadata.delete(number); this.dirtyFinal.delete(number); this.scheduleFinal(); }
  private scheduleFinal() { if ([...this.group].every(number => this.ready.has(number))) this.schedule('final'); }
  private schedule(kind: BatchKind) {
    if (this.scheduled.has(kind)) return;
    this.scheduled.add(kind);
    setImmediate(() => { void this.flush(kind); });
  }
  private async flush(kind: BatchKind) {
    this.scheduled.delete(kind);
    const items = this.pending.get(kind) ?? []; this.pending.delete(kind);
    const size = kind === 'details' || kind === 'relationComments' ? 5 : 20;
    for (let start = 0; start < items.length; start += size) {
      const part = items.slice(start, start + size);
      try {
        if (this.stopped) throw this.stopped;
        const values = await this.api.queryBatch(kind, part.map(item => item.target));
        part.forEach((item, index) => { const value = values[index]; if (!value || value.error) item.reject(value?.error ?? new OpsError('Batch target is missing.', 'PARTIAL', 'DATA_MISSING')); else item.resolve(value.value); });
      } catch (error) {
        if (error instanceof OpsError && (error.outcome === 'PAUSED' || ['HTTP_401', 'HTTP_403'].includes(error.code))) this.stopped = error;
        for (const item of part) item.reject(error);
      }
    }
  }
  private enqueue(kind: BatchKind, variables: Variables): Promise<unknown> {
    if (this.stopped) return Promise.reject(this.stopped);
    const target: BatchTarget = {};
    for (const key of ['owner', 'repo', 'number', 'head', 'id'] as const) if (variables[key] !== undefined && variables[key] !== null) Object.assign(target, { [key]: variables[key] });
    const result = new Promise((resolve, reject) => { const pending = this.pending.get(kind) ?? []; pending.push({ target, resolve, reject }); this.pending.set(kind, pending); });
    if (kind === 'final') { this.ready.add(Number(variables.number)); this.scheduleFinal(); } else this.schedule(kind);
    return result;
  }
  async query<T>(name: QueryName, variables: Variables): Promise<T> {
    if (this.stopped) throw this.stopped;
    const number = Number(variables.number);
    if (name === 'meta') {
      if (this.metadata.has(number) && this.finals.has(number) && !this.dirtyFinal.has(number)) return await this.finals.get(number) as T;
      this.metadata.add(number); return await this.enqueue('preflight', variables) as T;
    }
    if (['comments', 'reviews', 'threads', 'commits', 'timeline'].includes(name) && !variables.cursor) {
      if (!this.rich.has(number)) this.rich.set(number, this.enqueue('details', variables));
      return await this.rich.get(number) as T;
    }
    if (name === 'checks') {
      if (!this.finals.has(number)) this.finals.set(number, this.enqueue('final', variables));
      const value = await this.finals.get(number);
      if (variables.cursor) {
        // A resumed final page also occurs after the batched observation.
        this.invalidateFinal(number);
        return await this.api.query<T>(name, variables);
      }
      return value as T;
    }

    if (name === 'relation' || name === 'relationComments') {
      const key = JSON.stringify([name, variables.owner, variables.repo, variables.number, variables.id, variables.version, variables.cursor]);
      const cached = this.relations.get(key);
      if (cached && this.now() - cached.at >= 0 && this.now() - cached.at < 60000) return await cached.value as T;
      const value = variables.cursor ? this.api.query(name, variables) : this.enqueue(name, variables);
      this.relations.set(key, { at: this.now(), value });
      try { return await value as T; } catch (error) { this.relations.delete(key); throw error; }
    }
    return this.api.query<T>(name, variables);
  }
  invalidateFinal(number: number) { this.dirtyFinal.add(number); }
}
