/** Deterministic, zero-padded ID counter shared by the mocks. */
export class Counter {
  #next = 1;

  nextId(prefix: string): string {
    const id = `${prefix}_${String(this.#next).padStart(6, "0")}`;
    this.#next += 1;
    return id;
  }
}
