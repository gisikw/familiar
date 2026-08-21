export class BodyLimitError extends Error {
  constructor(readonly limit: number) { super(`request body exceeds ${limit} bytes`); this.name = "BodyLimitError"; }
}

/** Incremental accumulator: checks before retaining each chunk. */
export class BoundedBody {
  private chunks: Buffer[] = [];
  private total = 0;
  constructor(readonly limit: number) {}
  push(chunk: Buffer): void {
    if (chunk.length > this.limit - this.total) { this.clear(); throw new BodyLimitError(this.limit); }
    this.chunks.push(chunk); this.total += chunk.length;
  }
  finish(): Buffer { return Buffer.concat(this.chunks, this.total); }
  clear(): void { this.chunks.length = 0; this.total = 0; }
  get size(): number { return this.total; }
}
