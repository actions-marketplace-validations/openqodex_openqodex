// One depth-first pass over a parse tree that serves several fact readers
// at once. Each reader alone used to walk the whole tree with its own
// cursor, and on a JavaScript repository the walks cost more than the
// readers' own work: three readers, three walks of every file. Here the
// cursor moves once, each named node is made once, and its type, its field
// name and its ancestors are read once and handed to every reader.
//
// Ways it could fail, written before the code (shared-walk.test.ts):
// 1. A reader sees other nodes, or the same nodes in another order, than
//    its own walk showed it, so its facts change.
// 2. A reader that skips a node's children hides them from the others.
// 3. A reader that throws loses the facts of the others, or keeps being
//    called and throws again on every node.
// 4. A reader is told it left a node at another point than its own walk
//    told it, so a scope or a frame it keeps closes at the wrong node.
//
// The walk keeps no step back up the parents: a node's ancestors come from
// the path it keeps as it enters and leaves nodes, never from a node's
// `parent`, which tree-sitter finds by descending from the root again (a
// lookup per node would make a deeply nested file quadratic).
import type { Node } from "web-tree-sitter";

// The node's ancestors: `up(1)` its parent, `up(2)` the one above.
export type Up = (k: number) => Node | null;
// The types of the same ancestors, read once when each was entered.
export type UpType = (k: number) => string | null;

export type TreeVisitor = {
  // A named node outside any region the parser could not read. `field()`
  // is the field its parent holds it in, read when asked and only during
  // this call; `depth` is the node's depth (the root is 0).
  // False: none of the node's descendants is shown to this reader.
  enter(node: Node, type: string, field: () => string | null, depth: number, up: Up, upType: UpType): boolean | void;
  // The walk leaves a node at `depth`, named or not, after its descendants.
  leave?(depth: number): void;
  // A region the parser could not read (an ERROR or a missing node) starts
  // at `line`. It is never entered: the language would not run such a
  // file, so nothing in it is a fact.
  broken?(line: number): void;
};

export function walkTree(root: Node, visitors: readonly TreeVisitor[]): void {
  const n = visitors.length;
  if (n === 0) return;
  // The depth below which each reader skips the nodes, or -1.
  const skipBelow: number[] = Array.from({ length: n }, () => -1);
  const path: Node[] = [];
  const types: string[] = [];
  let depth = 0;
  const up: Up = (k) => (depth - k >= 0 ? (path[depth - k] ?? null) : null);
  const upType: UpType = (k) => (depth - k >= 0 ? (types[depth - k] ?? null) : null);
  const shown = (i: number): boolean => {
    const s = skipBelow[i] as number;
    return s < 0 || depth <= s;
  };
  const cursor = root.walk();
  // The current node's field, read from the cursor once, when a reader asks.
  let fieldRead = false;
  let fieldName: string | null = null;
  const field = (): string | null => {
    if (!fieldRead) {
      fieldName = cursor.currentFieldName;
      fieldRead = true;
    }
    return fieldName;
  };
  try {
    for (;;) {
      let descend = true;
      const cursorType = cursor.nodeType;
      if (cursorType === "ERROR" || cursor.nodeIsMissing) {
        descend = false;
        const line = cursor.startPosition.row + 1;
        for (let i = 0; i < n; i++) if (shown(i)) visitors[i]?.broken?.(line);
      } else if (cursor.nodeIsNamed) {
        const node = cursor.currentNode;
        const type = cursorType;
        fieldRead = false;
        path[depth] = node;
        types[depth] = type;
        let any = false;
        for (let i = 0; i < n; i++) {
          if (!shown(i)) continue;
          if (visitors[i]?.enter(node, type, field, depth, up, upType) === false) skipBelow[i] = depth;
          else any = true;
        }
        descend = any;
      } else {
        // An unnamed node (a keyword or punctuation) is entered by no reader;
        // its children, if any, still are, as each reader's own walk did.
        descend = true;
      }
      if (descend && cursor.gotoFirstChild()) {
        depth++;
        continue;
      }
      for (;;) {
        for (let i = 0; i < n; i++) if (shown(i)) visitors[i]?.leave?.(depth);
        // Leaving the node a reader skipped below: it sees the nodes again.
        for (let i = 0; i < n; i++) if (skipBelow[i] === depth) skipBelow[i] = -1;
        if (cursor.gotoNextSibling()) break;
        if (!cursor.gotoParent()) return;
        depth--;
      }
    }
  } finally {
    cursor.delete();
  }
}

// One reader's facts when it walks the tree alone.
export function readAlone<F>(root: Node, reader: { visitor: TreeVisitor | null; finish(): F[] }): F[] {
  if (reader.visitor) walkTree(root, [reader.visitor]);
  return reader.finish();
}
