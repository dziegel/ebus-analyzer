// User notes, tags and the "ignored" flag per message key (UNK-9).

export interface Annotation {
  note?: string;
  tags?: string[];
  ignored?: boolean;
}

export class AnnotationStore {
  #items = new Map<string, Annotation>();
  #listeners = new Set<() => void>();

  get(key: string): Annotation | undefined {
    return this.#items.get(key);
  }

  isIgnored(key: string): boolean {
    return this.#items.get(key)?.ignored === true;
  }

  get size(): number {
    return this.#items.size;
  }

  /** Updates an annotation; empty values are removed. */
  set(key: string, change: Annotation): void {
    const a: Annotation = { ...this.#items.get(key), ...change };
    if (a.note !== undefined) a.note = a.note.trim();
    if (a.tags) a.tags = [...new Set(a.tags.map((t) => t.trim()).filter(Boolean))];
    if (!a.note) delete a.note;
    if (!a.tags?.length) delete a.tags;
    if (!a.ignored) delete a.ignored;
    if (Object.keys(a).length) this.#items.set(key, a);
    else this.#items.delete(key);
    this.#emit();
  }

  /** All tags in use, sorted. */
  tags(): string[] {
    const all = new Set<string>();
    for (const a of this.#items.values()) for (const t of a.tags ?? []) all.add(t);
    return [...all].sort((a, b) => a.localeCompare(b));
  }

  /** Text for the search box. */
  searchText(key: string): string {
    const a = this.#items.get(key);
    return a ? `${a.note ?? ''} ${(a.tags ?? []).map((t) => `#${t}`).join(' ')}`.toLowerCase() : '';
  }

  toJSON(): Record<string, Annotation> {
    return Object.fromEntries(this.#items);
  }

  load(data: unknown, merge = false): void {
    if (!merge) this.#items.clear();
    if (data && typeof data === 'object') {
      for (const [key, a] of Object.entries(data as Record<string, Annotation>)) {
        if (a && typeof a === 'object') this.#items.set(key, { ...(merge ? this.#items.get(key) : {}), ...a });
      }
    }
    this.#emit();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}

/** Parses "a, b #c" into tags. */
export function parseTags(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map((t) => t.replace(/^#/, '').trim())
    .filter(Boolean);
}
