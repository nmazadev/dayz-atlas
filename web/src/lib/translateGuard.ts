/**
 * Chrome's page translation swaps React's text nodes for <font> wrappers. When React later
 * removes or inserts next to one of those nodes it is no longer where React left it, and the
 * DOM call throws ("Failed to execute 'removeChild' on 'Node'"), unmounting the whole app.
 * Skip those calls instead of throwing: https://github.com/facebook/react/issues/11538
 */
export function guardAgainstTranslation() {
  const { removeChild, insertBefore } = Node.prototype;

  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) return child;
    return removeChild.call(this, child) as T;
  };

  Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, ref: Node | null): T {
    if (ref && ref.parentNode !== this) return node;
    return insertBefore.call(this, node, ref) as T;
  };
}
