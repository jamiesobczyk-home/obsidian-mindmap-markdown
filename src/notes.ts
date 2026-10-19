// Bridges between maps and ordinary notes: building a map from a note's
// headings, and naming a note made from a topic. Pure, so it's unit-tested.

import { FRONTMATTER_KEY, MindNode, newNode, parse, serialize } from "./model";

const ATX = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
// Lines that open and close an Obsidian comment or a maths block.
const BLOCK = /^[ \t]*(%%|\$\$)[ \t]*$/;
// Characters that break a [[Note#Heading|Text]] link, so such headings stay plain.
const UNLINKABLE = /[[\]|#^]/;

interface Heading {
	level: number;
	text: string;
}

function headingsOf(markdown: string): Heading[] {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	let i = 0;
	if (lines[0] === "---") {
		const end = lines.indexOf("---", 1);
		if (end > 0) i = end + 1;
	}
	const out: Heading[] = [];
	let fence: string | null = null;
	let block: string | null = null;
	for (; i < lines.length; i++) {
		const line = lines[i];
		const b = fence === null ? BLOCK.exec(line) : null;
		if (b) {
			if (block === null) block = b[1];
			else if (block === b[1]) block = null;
			continue;
		}
		if (block !== null) continue;
		const f = FENCE.exec(line);
		if (f) {
			// A fence closes only with the same character, at least as long.
			if (fence === null) fence = f[1];
			else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
			continue;
		}
		if (fence !== null) continue;
		const h = ATX.exec(line);
		if (h && h[2].trim() !== "") out.push({ level: h[1].length, text: h[2].trim() });
	}
	return out;
}

// A new map note from a note's headings, each topic linking to its section.
// Several level-1 headings become several central topics; with none, the
// note's name is the centre. Returns null when there are no headings.
export function headingsToMap(markdown: string, noteName: string, linkPath: string): string | null {
	const headings = headingsOf(markdown);
	if (headings.length === 0) return null;
	const label = (text: string) => (UNLINKABLE.test(text) ? text : `[[${linkPath}#${text}|${text}]]`);

	const doc = parse(`---\n${FRONTMATTER_KEY}: basic\n---\n\n# x\n`);
	const tops = headings.filter((h) => h.level === 1);
	let root: MindNode;
	let rest = headings;
	if (tops.length > 0 && headings[0].level === 1) {
		root = newNode(label(headings[0].text));
		rest = headings.slice(1);
	} else {
		root = newNode(`[[${linkPath}|${noteName}]]`);
	}
	doc.root = root;

	// Stack of [level, node]: each heading nests under the nearest shallower one.
	let stack: [number, MindNode][] = [[tops.length > 0 && headings[0].level === 1 ? 1 : 0, root]];
	for (const h of rest) {
		const node = newNode(label(h.text));
		if (h.level === 1) {
			node.central = true;
			root.children.push(node);
			stack = [[1, node]];
			continue;
		}
		while (stack.length > 1 && stack[stack.length - 1][0] >= h.level) stack.pop();
		stack[stack.length - 1][1].children.push(node);
		stack.push([h.level, node]);
	}
	return serialize(doc);
}

// A file name for a note made from a topic: the text a reader sees, without
// Markdown or the characters file names and links can't hold.
export function noteNameFor(text: string): string {
	const shown = text
		.replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
		.replace(/!?\[\[([^\]]*)\]\]/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`~=]/g, "")
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		// Obsidian hides files whose names start with a dot.
		.replace(/^[.\s]+/, "");
	const name = (shown || "Untitled topic").slice(0, 100).trim();
	// Names Windows reserves: a phone could create them, but the PC couldn't
	// check them out, which would stall syncing.
	return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) ? `${name}_` : name;
}

// The link target when a topic is exactly one wiki-link, else null.
export function linkedNote(text: string): string | null {
	const m = /^\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$/.exec(text);
	return m ? m[1] : null;
}
