// A ring over the discovered elements. The tree is flattened depth-first so a
// panel and its subcontents sit next to each other, then wrapped in a circular
// queue: `next` / `prev` walk the whole page with no dead ends, and `jumpTo`
// snaps to any node by id.

// Depth-first flatten: parent first, then its children (which recurse). Keeps a
// landmark immediately followed by its subcontents.
export function flattenTree(nodes) {
  const out = [];
  const walk = (list) => list.forEach((n) => { out.push(n); walk(n.children); });
  walk(nodes);
  return out;
}

export class CircularQueue {
  constructor(items = []) {
    this.items = items;
    this.i = -1;
  }

  setItems(items) {
    this.items = items;
    // Preserve position when possible so re-discovery doesn't jump.
    if (this.current && items.some((n) => n.id === this.current.id)) {
      this.i = items.findIndex((n) => n.id === this.current.id);
    } else if (this.i >= items.length) {
      this.i = items.length - 1;
    }
  }

  get size() { return this.items.length; }
  get current() { return this.i < 0 ? null : this.items[this.i] ?? null; }

  next() {
    if (!this.items.length) return null;
    this.i = (this.i + 1) % this.items.length;
    return this.current;
  }

  prev() {
    if (!this.items.length) return null;
    this.i = (this.i - 1 + this.items.length) % this.items.length;
    return this.current;
  }

  jumpTo(idOrNode) {
    const id = typeof idOrNode === 'string' ? idOrNode : idOrNode && idOrNode.id;
    const idx = this.items.findIndex((n) => n.id === id);
    if (idx < 0) return null;
    this.i = idx;
    return this.current;
  }

  find(id) { return this.items.find((n) => n.id === id) || null; }

  list() { return this.items.map((n) => ({ id: n.id, label: n.label, kind: n.kind, depth: n.depth })); }

  [Symbol.iterator]() { return this.items[Symbol.iterator](); }
}
