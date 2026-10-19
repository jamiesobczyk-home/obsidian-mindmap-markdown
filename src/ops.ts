// Structural edits on the tree. Pure: no DOM, no Obsidian, so every edit the
// view makes is unit-tested here. Each function returns false when the edit
// isn't allowed, and leaves the tree untouched in that case.

import { Link, MapDoc, MindNode, Summary, parentOf } from "./model";

export function isAncestor(ancestor: MindNode, node: MindNode): boolean {
	if (ancestor === node) return true;
	return ancestor.children.some((c) => isAncestor(c, node));
}

export function insertChild(parent: MindNode, child: MindNode, index = parent.children.length): void {
	parent.collapsed = false;
	parent.children.splice(Math.max(0, Math.min(index, parent.children.length)), 0, child);
}

export function insertSibling(root: MindNode, target: MindNode, node: MindNode, before = false): boolean {
	const parent = parentOf(root, target);
	if (!parent) return false;
	const i = parent.children.indexOf(target);
	parent.children.splice(before ? i : i + 1, 0, node);
	return true;
}

// Removes the node and returns the topic to select afterwards: the next
// sibling, else the previous one, else the parent.
export function remove(root: MindNode, node: MindNode): MindNode | null {
	const parent = parentOf(root, node);
	if (!parent) return null;
	const i = parent.children.indexOf(node);
	parent.children.splice(i, 1);
	return parent.children[i] ?? parent.children[i - 1] ?? parent;
}

// Moves a node (with its branch) under newParent at index. Refuses to move the
// root, or to move a node into its own branch. index counts positions in the
// parent's children before the move.
export function move(root: MindNode, node: MindNode, newParent: MindNode, index: number): boolean {
	if (node === root || isAncestor(node, newParent)) return false;
	const oldParent = parentOf(root, node);
	if (!oldParent) return false;
	const from = oldParent.children.indexOf(node);
	let to = index;
	if (oldParent === newParent && from < to) to -= 1;
	if (oldParent === newParent && from === to) return false;
	oldParent.children.splice(from, 1);
	insertChild(newParent, node, to);
	settleCentral(root, newParent, [node]);
	return true;
}

// After a move, decide which moved topics are central topics. Under any other
// parent, none are. Among the root's children: a central topic that lands next
// to another central topic stays central (reordering the centres); an ordinary
// topic becomes central only when it lands between central topics.
function settleCentral(root: MindNode, newParent: MindNode, moved: MindNode[]): void {
	const was = new Map(moved.map((n) => [n, n.central === true] as const));
	for (const n of moved) delete n.central;
	if (newParent !== root) return;
	const kids = root.children;
	const moving = new Set(moved);
	for (const n of moved) {
		const i = kids.indexOf(n);
		let p = i - 1;
		while (p >= 0 && moving.has(kids[p])) p--;
		let q = i + 1;
		while (q < kids.length && moving.has(kids[q])) q++;
		const before = p >= 0 ? kids[p].central === true : null;
		const after = q < kids.length ? kids[q].central === true : null;
		const near = [before, after].filter((v) => v !== null);
		const central = was.get(n) ? near.some((v) => v) : near.length > 0 && near.every((v) => v);
		if (central) n.central = true;
	}
}

// Takes a topic (with its branch) out of the tree and makes it a further
// central topic, written as its own level-1 heading.
export function detachAsCentral(root: MindNode, node: MindNode): boolean {
	if (node === root || (node.central && root.children.includes(node))) return false;
	const parent = parentOf(root, node);
	if (!parent) return false;
	parent.children.splice(parent.children.indexOf(node), 1);
	node.central = true;
	root.children.push(node);
	return true;
}

export function reorder(root: MindNode, node: MindNode, delta: number): boolean {
	const parent = parentOf(root, node);
	if (!parent) return false;
	const i = parent.children.indexOf(node);
	const j = i + delta;
	if (j < 0 || j >= parent.children.length) return false;
	parent.children.splice(i, 1);
	parent.children.splice(j, 0, node);
	return true;
}

// Of a set of selected nodes, the ones not inside another selected node's
// branch. Moving or deleting these moves or deletes the whole selection.
export function topmost(nodes: Iterable<MindNode>): MindNode[] {
	const list = [...nodes];
	return list.filter((n) => !list.some((m) => m !== n && isAncestor(m, n)));
}

// Sorts nodes by where they appear in the outline, so a multi-topic move keeps
// the order the reader sees.
export function inDocumentOrder(root: MindNode, nodes: Iterable<MindNode>): MindNode[] {
	const want = new Set(nodes);
	const out: MindNode[] = [];
	const walk = (n: MindNode) => {
		if (want.has(n)) out.push(n);
		n.children.forEach(walk);
	};
	walk(root);
	return out;
}

// Moves several branches under newParent so they land, in the order given, at
// index (counted in newParent's children before the move). Returns false and
// leaves the tree alone if any move is illegal or nothing would change.
export function moveAll(root: MindNode, nodes: MindNode[], newParent: MindNode, index: number): boolean {
	if (nodes.length === 0) return false;
	if (nodes.some((n) => n === root || isAncestor(n, newParent))) return false;
	const moving = new Set(nodes);
	const parents = nodes.map((n) => parentOf(root, n));
	if (parents.some((p) => !p)) return false;

	// The first unmoved child at or after index is the anchor to insert before;
	// counting from it rather than from index survives removing moved siblings.
	const kids = newParent.children;
	let anchor: MindNode | null = null;
	for (let i = Math.max(0, index); i < kids.length; i++) {
		if (!moving.has(kids[i])) {
			anchor = kids[i];
			break;
		}
	}
	const before = nodes.map((n, i) => [parents[i], parents[i]!.children.indexOf(n)] as const);
	const wasCollapsed = newParent.collapsed;

	nodes.forEach((n, i) => {
		const p = parents[i]!;
		p.children.splice(p.children.indexOf(n), 1);
	});
	const at = anchor ? kids.indexOf(anchor) : kids.length;
	kids.splice(at, 0, ...nodes);

	const unchanged =
		!wasCollapsed &&
		nodes.every((n, i) => before[i][0] === newParent && kids.indexOf(n) === before[i][1]);
	if (unchanged) return false;
	settleCentral(root, newParent, nodes);
	newParent.collapsed = false;
	return true;
}

// Deletes the topmost of the given nodes (never the root) and returns the
// topic to select afterwards, or null when there was nothing to delete.
export function removeAll(root: MindNode, nodes: Iterable<MindNode>): MindNode | null {
	const doomed = inDocumentOrder(root, topmost(nodes)).filter((n) => n !== root);
	if (doomed.length === 0) return null;
	let next: MindNode | null = null;
	for (const n of doomed) next = remove(root, n);
	return next && isAncestor(root, next) ? next : root;
}

// Adds a relationship line. Refuses a link from a topic to itself, and a
// second link in the same direction between the same two topics.
export function addLink(doc: MapDoc, from: MindNode, to: MindNode, label?: string): boolean {
	if (from === to) return false;
	if (doc.links.some((l) => l.from === from && l.to === to)) return false;
	doc.links.push(label ? { from, to, label } : { from, to });
	return true;
}

export function removeLink(doc: MapDoc, link: Link): boolean {
	const i = doc.links.indexOf(link);
	if (i < 0) return false;
	doc.links.splice(i, 1);
	return true;
}

// Adds a summary bracket over the run of siblings the given topics span.
// Refuses topics with different parents, and the root.
export function addSummary(doc: MapDoc, nodes: MindNode[], text: string): boolean {
	if (nodes.length === 0 || nodes.includes(doc.root)) return false;
	const parent = parentOf(doc.root, nodes[0]);
	if (!parent || nodes.some((n) => parentOf(doc.root, n) !== parent)) return false;
	const idx = nodes.map((n) => parent.children.indexOf(n));
	const from = parent.children[Math.min(...idx)];
	const to = parent.children[Math.max(...idx)];
	doc.summaries.push({ from, to, text });
	return true;
}

export function removeSummary(doc: MapDoc, summary: Summary): boolean {
	const i = doc.summaries.indexOf(summary);
	if (i < 0) return false;
	doc.summaries.splice(i, 1);
	return true;
}
