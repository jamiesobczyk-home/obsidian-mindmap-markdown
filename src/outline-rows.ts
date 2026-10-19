// The outline pane's rows, worked out from the map's tree. No Obsidian
// imports, so it's unit-tested under Node; src/outline.ts draws the rows.

import { MindNode, countDescendants, pathOf } from "./model";

export interface OutlineRow {
	node: MindNode;
	// 0 for a central topic, 1 for its branches, and so on.
	depth: number;
	// The first heading or a further central topic: drawn as a heading.
	central: boolean;
	hasChildren: boolean;
	// Folded in the map, so its children aren't listed.
	folded: boolean;
	// How many topics the fold hides (0 when not folded).
	hidden: number;
	// The topic's saved outline path ("" is the root), as model.ts writes it.
	path: string;
}

// Every topic the outline lists, in the order the note is written: the first
// centre with its tree, then each further central topic with its own.
export function outlineRows(root: MindNode): OutlineRow[] {
	const rows: OutlineRow[] = [];
	const visit = (n: MindNode, depth: number, path: string, central: boolean) => {
		const hasChildren = n.children.length > 0;
		const folded = hasChildren && n.collapsed;
		rows.push({ node: n, depth, central, hasChildren, folded, hidden: folded ? countDescendants(n) : 0, path });
		if (folded) return;
		n.children.forEach((c, i) => {
			if (n === root && c.central) return;
			visit(c, depth + 1, path ? `${path}.${i}` : String(i), false);
		});
	};
	visit(root, 0, "", true);
	root.children.forEach((c, i) => {
		if (c.central) visit(c, 0, String(i), true);
	});
	return rows;
}

// A string that changes whenever what the rows draw changes, so a re-render
// that would produce the same list can be skipped. JSON keeps any character in
// a topic's text from being mistaken for a separator. A row shows whether its
// topic has a note, but not the note itself.
export function outlineKey(rows: OutlineRow[], extra: string): string {
	return JSON.stringify([
		extra,
		rows.map((r) => [r.depth, r.central ? 1 : 0, r.hasChildren ? 1 : 0, r.hidden, r.folded ? 1 : 0, r.node.note ? 1 : 0, r.node.text]),
	]);
}

// The row to highlight for a topic: its own, or the nearest listed ancestor's
// when the topic sits inside a folded branch. -1 when it isn't in the tree.
export function rowIndexFor(rows: OutlineRow[], root: MindNode, node: MindNode | null): number {
	if (!node) return -1;
	const path = pathOf(root, node);
	if (!path) return -1;
	let best = -1;
	let n: MindNode = root;
	const chain: MindNode[] = [root];
	for (const i of path) chain.push((n = n.children[i]));
	const at = new Map(rows.map((r, i) => [r.node, i]));
	for (const c of chain) {
		const i = at.get(c);
		if (i !== undefined) best = i;
	}
	return best;
}

// Moves a cursor by delta within length rows. With nothing chosen, Down starts
// at the top and Up at the bottom.
export function stepCursor(index: number, delta: number, length: number): number {
	if (length === 0) return -1;
	if (index < 0) return delta > 0 ? 0 : length - 1;
	return Math.max(0, Math.min(length - 1, index + delta));
}

// A topic's text as a reader sees it in the map, without the Markdown marks.
export function plainTopicText(text: string): string {
	// Embedded images show as pictures, so they're left out of the row, unless
	// the topic is nothing but an image: then the row shows the file's name.
	const embeds = [...text.matchAll(/!\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].split("/").pop() ?? "");
	const rest = plainText(text.replace(/!\[\[[^\]]*\]\]/g, " ").replace(/ {2,}/g, " "));
	return rest || embeds.join(", ");
}

function plainText(text: string): string {
	return text
		.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
		.replace(/\[\[([^\]]*)\]\]/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__|~~|==)(.+?)\1/g, "$2")
		.replace(/(^|[^\w*])[*_](?!\s)(.*?\S)[*_](?![\w*])/g, "$1$2")
		.replace(/`([^`]*)`/g, "$1")
		.trim();
}
