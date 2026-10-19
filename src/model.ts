// The map's data model and its Markdown round trip.
//
// A map file is an ordinary note:
//
//   ---
//   mindmap-plugin: basic
//   ---
//
//   # Central topic
//
//   - Branch
//   	- Sub-topic
//
//   %% mindmap-settings
//   {"layout":"balanced","collapsed":["0.1"]}
//   %%
//
// The heading is the root, the bullet list is the tree, and the hidden
// comment holds view settings. Anything else in the note (paragraphs, a second
// heading, code) is content the map cannot represent, so parse() reports it and
// the view refuses to edit rather than silently dropping it on save.
//
// This module has no Obsidian imports so it can be unit-tested under Node.

export const FRONTMATTER_KEY = "mindmap-plugin";
const SETTINGS_OPEN = "%% mindmap-settings";

export const LAYOUTS = ["balanced", "right", "down", "outline"] as const;
export type Layout = (typeof LAYOUTS)[number];

// Branch colours are names, mapped to Obsidian's theme colour variables in CSS.
export const COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"] as const;
export type BranchColor = (typeof COLORS)[number];

export interface MindNode {
	id: number;
	text: string;
	children: MindNode[];
	collapsed: boolean;
	// Set on a topic to colour it and its branch; unset topics inherit.
	color?: BranchColor;
	// A further central topic: another level-1 heading in the note. Stored as a
	// child of the root so every tree operation and saved path still works, but
	// laid out as its own tree beside the main one (like XMind's floating
	// topics). Only meaningful on the root's direct children.
	central?: boolean;
	// Free text kept with the topic: indented lines under its bullet, or a
	// paragraph under a central topic's heading.
	note?: string;
	// Set to draw a boundary around the topic's branch; the string is its label
	// ("" for none).
	boundary?: string;
}

export function isCentral(root: MindNode, n: MindNode): boolean {
	return n.central === true && root.children.includes(n);
}

export function centralsOf(root: MindNode): MindNode[] {
	return root.children.filter((c) => c.central === true);
}

// Central topics are written after the first heading's own list, so keep them
// last among the root's children; saved paths then match the written order.
export function normalizeCentrals(root: MindNode): void {
	const own = root.children.filter((c) => !c.central);
	if (own.length === root.children.length) return;
	root.children = [...own, ...centralsOf(root)];
}

// A relationship line between any two topics, drawn over the tree. It doesn't
// change who belongs to whom.
export interface Link {
	from: MindNode;
	to: MindNode;
	label?: string;
}

// A bracket beside a run of sibling topics, from `from` to `to` inclusive,
// with a short text summing them up.
export interface Summary {
	from: MindNode;
	to: MindNode;
	text: string;
}

export interface SummaryRecord {
	from: string;
	to: string;
	text: string;
}

// A link as saved: the two topics' outline paths ("" is the root).
export interface LinkRecord {
	from: string;
	to: string;
	label?: string;
}

export interface MapSettings {
	layout: Layout;
	// Any keys this version doesn't know about, kept so a newer version's
	// settings survive a save from this one.
	extra: Record<string, unknown>;
}

export interface MapDoc {
	frontmatter: string | null; // raw text between the --- fences
	root: MindNode;
	hasHeading: boolean;
	settings: MapSettings;
	links: Link[];
	// Saved links that don't point at existing topics (say, after a hand edit),
	// written back unchanged so a save never silently deletes them.
	strayLinks: unknown[];
	summaries: Summary[];
	straySummaries: unknown[];
	indentUnit: string;
	bullet: string;
	// Lines the map can't represent. Non-empty means the view is read-only.
	unsupported: { line: number; text: string }[];
}

let nextId = 1;
export function newNode(text = ""): MindNode {
	return { id: nextId++, text, children: [], collapsed: false };
}

const BULLET_RE = /^([ \t]*)([-*+])[ \t]+(.*)$/;
// A closing run of #s only counts when a space separates it, so "# C#" keeps its #.
const HEADING_RE = /^#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

function indentWidth(ws: string): number {
	let w = 0;
	for (const ch of ws) w += ch === "\t" ? 4 : 1;
	return w;
}

export function parse(markdown: string, fallbackTitle = "Central topic"): MapDoc {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	let i = 0;
	let frontmatter: string | null = null;

	if (lines[0] === "---") {
		const end = lines.indexOf("---", 1);
		if (end > 0) {
			frontmatter = lines.slice(1, end).join("\n");
			i = end + 1;
		}
	}

	const root = newNode(fallbackTitle);
	let hasHeading = false;
	const unsupported: MapDoc["unsupported"] = [];
	let settingsJson: string | null = null;
	let settingsLine = 0;
	let indentUnit: string | null = null;
	let bullet: string | null = null;

	// Stack of [indent width, node]; the root sits below every list item.
	const stack: [number, MindNode][] = [[-1, root]];
	let sawList = false;

	const noteLines = new Map<MindNode, string[]>();
	let section: MindNode = root;
	let sectionHasItems = false;
	let blankCount = 0;
	// An open code or maths block inside a note: every line until it closes is
	// note text, never a bullet or heading. target null means the block isn't
	// in a note, so its lines can't be kept and make the map read-only.
	let fence: { marker: string; target: MindNode | null; line: number } | null = null;
	const addNoteLine = (target: MindNode, text: string) => {
		const lines0 = noteLines.get(target) ?? [];
		if (lines0.length > 0) for (; blankCount > 0; blankCount--) lines0.push("");
		blankCount = 0;
		lines0.push(text);
		noteLines.set(target, lines0);
	};
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (fence) {
			if (fence.target) {
				const lines0 = noteLines.get(fence.target)!;
				lines0.push(line.trim() === "" ? "" : line);
			} else if (line.trim() !== "") unsupported.push({ line: i + 1, text: line });
			if (closesFence(line, fence.marker)) fence = null;
			continue;
		}
		if (line.trim() === "") {
			blankCount++;
			continue;
		}

		if (line.startsWith(SETTINGS_OPEN)) {
			const end = lines.indexOf("%%", i + 1);
			// A second block would be dropped on save, so it counts as content
			// the map can't represent.
			if (end < 0) {
				unsupported.push({ line: i + 1, text: line });
				continue;
			}
			if (settingsJson !== null) {
				unsupported.push({ line: i + 1, text: line });
				i = end;
				continue;
			}
			settingsJson = lines.slice(i + 1, end).join("\n");
			settingsLine = i + 1;
			i = end;
			continue;
		}

		const heading = HEADING_RE.exec(line);
		if (heading) {
			if (!hasHeading && !sawList) {
				root.text = heading[1];
				section = root;
			} else {
				// Each later level-1 heading starts another central topic, and the
				// bullets under it are its tree.
				const central = newNode(heading[1]);
				central.central = true;
				root.children.push(central);
				stack.length = 0;
				stack.push([-1, central]);
				section = central;
			}
			hasHeading = true;
			sectionHasItems = false;
			blankCount = 0;
			continue;
		}

		const item = BULLET_RE.exec(line);
		if (item) {
			sawList = true;
			const [, ws, mark, text] = item;
			const width = indentWidth(ws);
			bullet ??= mark;
			if (indentUnit === null && ws.length > 0) indentUnit = ws;
			while (stack.length > 1 && stack[stack.length - 1][0] >= width) stack.pop();
			const node = newNode(text);
			stack[stack.length - 1][1].children.push(node);
			stack.push([width, node]);
			sectionHasItems = true;
			blankCount = 0;
			continue;
		}

		// Any other line is a note: indented under a bullet, it belongs to the
		// nearest topic it's indented past; before a section's first bullet, it
		// belongs to the section's central topic. Anything else would be lost on
		// save, so it makes the note read-only.
		const width = indentWidth(/^[ \t]*/.exec(line)![0]);
		let target: MindNode | null = null;
		if (!sectionHasItems) target = section;
		else {
			for (let k = stack.length - 1; k >= 1; k--) {
				if (stack[k][0] < width) {
					target = stack[k][1];
					break;
				}
			}
		}
		// Notes are written before a topic's children, so text after them
		// (indented between two levels) would move on save.
		if (target && target !== section && target.children.length > 0) target = null;
		const opens = opensFence(line);
		if (!target) {
			unsupported.push({ line: i + 1, text: line });
			if (opens) fence = { marker: opens, target: null, line: i + 1 };
			continue;
		}
		addNoteLine(target, line);
		if (opens) fence = { marker: opens, target, line: i + 1 };
	}
	if (fence) unsupported.push({ line: fence.line, text: "a code block that never closes" });

	for (const [node, raw] of noteLines) node.note = dedent(raw);

	const settings = parseSettings(settingsJson);
	// Unreadable settings may have swallowed list lines up to the closing %%;
	// saving would lose them, so the note opens read-only instead.
	if (!settings.ok) unsupported.push({ line: settingsLine, text: "%% mindmap-settings (not valid JSON)" });
	const doc: MapDoc = {
		frontmatter,
		root,
		hasHeading,
		settings: settings.settings,
		links: [],
		strayLinks: [],
		summaries: [],
		straySummaries: [],
		indentUnit: indentUnit ?? "\t",
		bullet: bullet ?? "-",
		unsupported,
	};
	for (const p of settings.collapsed) {
		const node = nodeAtPath(root, p);
		if (node && node.children.length > 0) node.collapsed = true;
	}
	for (const [p, color] of settings.colors) {
		const node = nodeAtPath(root, p);
		if (node) node.color = color;
	}
	for (const [p, label] of settings.boundaries) {
		const node = nodeAtPath(root, p);
		if (node) node.boundary = label;
	}
	for (const raw of settings.summaries) {
		const sum = isSummaryRecord(raw) ? recordsToSummaries(root, [raw])[0] : undefined;
		if (sum) doc.summaries.push(sum);
		else doc.straySummaries.push(raw);
	}
	for (const raw of settings.links) {
		const link = isLinkRecord(raw) ? recordsToLinks(root, [raw])[0] : undefined;
		if (link) doc.links.push(link);
		else doc.strayLinks.push(raw);
	}
	return doc;
}

const PATH_RE = /^\d+(\.\d+)*$/;
const toPath = (p: string) => p.split(".").map(Number);

function parseSettings(json: string | null): {
	settings: MapSettings;
	collapsed: number[][];
	colors: [number[], BranchColor][];
	links: unknown[];
	boundaries: [number[], string][];
	summaries: unknown[];
	ok: boolean;
} {
	const settings: MapSettings = { layout: "balanced", extra: {} };
	const collapsed: number[][] = [];
	const colors: [number[], BranchColor][] = [];
	const links: unknown[] = [];
	const boundaries: [number[], string][] = [];
	const summaries: unknown[] = [];
	const done = (ok: boolean) => ({ settings, collapsed, colors, links, boundaries, summaries, ok });
	if (!json) return done(true);
	try {
		const raw = JSON.parse(json) as Record<string, unknown>;
		for (const [k, v] of Object.entries(raw)) {
			if (k === "layout" && (LAYOUTS as readonly unknown[]).includes(v)) settings.layout = v as Layout;
			else if (k === "collapsed" && Array.isArray(v)) {
				for (const p of v) if (typeof p === "string" && PATH_RE.test(p)) collapsed.push(toPath(p));
			} else if (k === "colors" && v && typeof v === "object" && !Array.isArray(v)) {
				for (const [p, c] of Object.entries(v)) {
					if ((p === "" || PATH_RE.test(p)) && (COLORS as readonly unknown[]).includes(c)) {
						colors.push([p === "" ? [] : toPath(p), c as BranchColor]);
					}
				}
			} else if (k === "links" && Array.isArray(v)) links.push(...(v as unknown[]));
			else if (k === "summaries" && Array.isArray(v)) summaries.push(...(v as unknown[]));
			else if (k === "boundaries" && v && typeof v === "object" && !Array.isArray(v)) {
				for (const [p, label] of Object.entries(v)) {
					if ((p === "" || PATH_RE.test(p)) && typeof label === "string") {
						boundaries.push([p === "" ? [] : toPath(p), label]);
					}
				}
			}
			else settings.extra[k] = v;
		}
	} catch {
		return done(false);
	}
	return done(true);
}

export function serialize(doc: MapDoc): string {
	normalizeCentrals(doc.root);
	const out: string[] = [];
	if (doc.frontmatter !== null) {
		out.push("---");
		if (doc.frontmatter !== "") out.push(doc.frontmatter);
		out.push("---", "");
	}
	out.push(`# ${oneLine(doc.root.text)}`, "");

	const walk = (node: MindNode, depth: number) => {
		for (const child of node.children) {
			out.push(`${doc.indentUnit.repeat(depth)}${doc.bullet} ${oneLine(child.text)}`);
			if (child.note) {
				for (const l of escapeNote(child.note, false)) out.push(l === "" ? "" : doc.indentUnit.repeat(depth + 1) + l);
			}
			walk(child, depth + 1);
		}
	};
	const sectionNote = (n: MindNode) => {
		if (!n.note) return;
		out.push(...escapeNote(n.note, true), "");
	};
	const own = doc.root.children.filter((c) => !c.central);
	sectionNote(doc.root);
	walk({ ...doc.root, children: own }, 0);
	if (own.length > 0) out.push("");
	for (const central of centralsOf(doc.root)) {
		out.push(`# ${oneLine(central.text)}`, "");
		sectionNote(central);
		walk(central, 0);
		if (central.children.length > 0) out.push("");
	}

	const collapsed: string[] = [];
	const colors: Record<string, BranchColor> = {};
	const boundaries: Record<string, string> = {};
	const collect = (node: MindNode, path: number[]) => {
		if (node.color) colors[path.join(".")] = node.color;
		if (node.boundary !== undefined) boundaries[path.join(".")] = node.boundary;
		node.children.forEach((c, i) => {
			const p = [...path, i];
			if (c.collapsed && c.children.length > 0) collapsed.push(p.join("."));
			collect(c, p);
		});
	};
	collect(doc.root, []);

	const settings: Record<string, unknown> = {};
	if (doc.settings.layout !== "balanced") settings.layout = doc.settings.layout;
	if (collapsed.length > 0) settings.collapsed = collapsed;
	if (Object.keys(colors).length > 0) settings.colors = colors;
	if (Object.keys(boundaries).length > 0) settings.boundaries = boundaries;
	const summaries = [...summariesToRecords(doc.root, doc.summaries), ...doc.straySummaries];
	if (summaries.length > 0) settings.summaries = summaries;
	const links = [...linksToRecords(doc.root, doc.links), ...doc.strayLinks];
	if (links.length > 0) settings.links = links;
	Object.assign(settings, doc.settings.extra);
	if (Object.keys(settings).length > 0) {
		out.push(SETTINGS_OPEN, JSON.stringify(settings), "%%", "");
	}
	return out.join("\n");
}

function oneLine(text: string): string {
	return text.replace(/\s*\n\s*/g, " ").trim();
}

export function nodeAtPath(root: MindNode, path: number[]): MindNode | null {
	let node: MindNode | undefined = root;
	for (const i of path) {
		node = node?.children[i];
		if (!node) return null;
	}
	return node ?? null;
}

export function pathOf(root: MindNode, target: MindNode): number[] | null {
	if (root === target) return [];
	for (let i = 0; i < root.children.length; i++) {
		const sub = pathOf(root.children[i], target);
		if (sub) return [i, ...sub];
	}
	return null;
}

export function parentOf(root: MindNode, target: MindNode): MindNode | null {
	for (const child of root.children) {
		if (child === target) return root;
		const found = parentOf(child, target);
		if (found) return found;
	}
	return null;
}

export function countDescendants(node: MindNode): number {
	return node.children.reduce((n, c) => n + 1 + countDescendants(c), 0);
}

// Plain-data copy of a tree, used for undo snapshots.
export interface TreeSnapshot {
	text: string;
	collapsed: boolean;
	color?: BranchColor;
	central?: boolean;
	note?: string;
	boundary?: string;
	children: TreeSnapshot[];
}

export function snapshot(node: MindNode): TreeSnapshot {
	return {
		text: node.text,
		collapsed: node.collapsed,
		color: node.color,
		central: node.central,
		note: node.note,
		boundary: node.boundary,
		children: node.children.map(snapshot),
	};
}

export function restore(snap: TreeSnapshot): MindNode {
	const node = newNode(snap.text);
	node.collapsed = snap.collapsed;
	if (snap.color) node.color = snap.color;
	if (snap.central) node.central = true;
	if (snap.note) node.note = snap.note;
	if (snap.boundary !== undefined) node.boundary = snap.boundary;
	node.children = snap.children.map(restore);
	return node;
}

export function newMapTemplate(title: string): string {
	return `---\n${FRONTMATTER_KEY}: basic\n---\n\n# ${title}\n\n- First idea\n- Second idea\n`;
}

function isLinkRecord(v: unknown): v is LinkRecord {
	if (!v || typeof v !== "object") return false;
	const r = v as Record<string, unknown>;
	const isPath = (p: unknown) => p === "" || (typeof p === "string" && PATH_RE.test(p));
	return isPath(r.from) && isPath(r.to) && (r.label === undefined || typeof r.label === "string");
}

// Links whose topics are both still in the tree, as saved records. A link to a
// deleted topic simply stops being written, so deleting cleans up its links.
export function linksToRecords(root: MindNode, links: Link[]): LinkRecord[] {
	const out: LinkRecord[] = [];
	for (const l of links) {
		const from = pathOf(root, l.from);
		const to = pathOf(root, l.to);
		if (!from || !to) continue;
		const rec: LinkRecord = { from: from.join("."), to: to.join(".") };
		if (l.label) rec.label = l.label;
		out.push(rec);
	}
	return out;
}

export function recordsToLinks(root: MindNode, records: LinkRecord[]): Link[] {
	const out: Link[] = [];
	for (const r of records) {
		const from = nodeAtPath(root, r.from === "" ? [] : toPath(r.from));
		const to = nodeAtPath(root, r.to === "" ? [] : toPath(r.to));
		if (!from || !to || from === to) continue;
		out.push(r.label ? { from, to, label: r.label } : { from, to });
	}
	return out;
}

// Strips the indentation the note lines share, keeping any deeper indentation
// (code blocks, nested quotes) intact.
function dedent(lines: string[]): string {
	const lead = (l: string) => /^[ \t]*/.exec(l)![0].length;
	const min = Math.min(...lines.filter((l) => l.trim() !== "").map(lead));
	// Trailing spaces stay: two of them are a Markdown line break.
	return lines.map((l) => (l.trim() === "" ? "" : l.slice(min))).join("\n");
}

// A note line that would read back as a bullet (or, under a heading, as a
// heading or the settings block) gets a backslash, which Markdown renders
// away, so it can't turn into a topic on the next load.
function escapeNote(note: string, underHeading: boolean): string[] {
	// Indentation every line shares can't survive a reload (it's indistinguishable
	// from the indent that places the note), so it's dropped on write too.
	// Lines inside a code or maths block are code: they read back as note text
	// anyway (the parser follows fences), so they're never escaped.
	let open: string | null = null;
	return dedent(note.split("\n")).split("\n").map((l) => {
		if (open) {
			if (closesFence(l, open)) open = null;
			return l;
		}
		const opens = opensFence(l);
		if (opens) {
			open = opens;
			return l;
		}
		const risky =
			/^[ \t]*[-*+][ \t]/.test(l) || (underHeading && (/^#[ \t]/.test(l) || l.startsWith("%% mindmap-settings")));
		return risky ? l.replace(/^([ \t]*)/, "$1\\") : l;
	});
}

function isSummaryRecord(v: unknown): v is SummaryRecord {
	if (!v || typeof v !== "object") return false;
	const r = v as Record<string, unknown>;
	return typeof r.from === "string" && PATH_RE.test(r.from) && typeof r.to === "string" && PATH_RE.test(r.to) && typeof r.text === "string";
}

// Summaries whose ends are still siblings, in order, as saved records.
export function summariesToRecords(root: MindNode, summaries: Summary[]): SummaryRecord[] {
	const out: SummaryRecord[] = [];
	for (const sm of summaries) {
		const a = pathOf(root, sm.from);
		const b = pathOf(root, sm.to);
		if (!a || !b || a.length === 0 || a.length !== b.length) continue;
		if (a.slice(0, -1).join(".") !== b.slice(0, -1).join(".") || a[a.length - 1] > b[b.length - 1]) continue;
		out.push({ from: a.join("."), to: b.join("."), text: sm.text });
	}
	return out;
}

export function recordsToSummaries(root: MindNode, records: SummaryRecord[]): Summary[] {
	const out: Summary[] = [];
	for (const r of records) {
		const from = nodeAtPath(root, toPath(r.from));
		const to = nodeAtPath(root, toPath(r.to));
		if (!from || !to) continue;
		const sm = { from, to, text: r.text };
		if (summariesToRecords(root, [sm]).length === 1) out.push(sm);
	}
	return out;
}

// The marker that opens a fenced code block (``` or ~~~) or a maths block
// ($$ on its own line), or null.
function opensFence(line: string): string | null {
	const m = /^[ \t]*(`{3,}|~{3,})/.exec(line);
	if (m) return m[1];
	return /^[ \t]*\$\$[ \t]*$/.test(line) ? "$$" : null;
}

// A fence closes with the same character, at least as many, and nothing after.
function closesFence(line: string, marker: string): boolean {
	if (marker === "$$") return /^[ \t]*\$\$[ \t]*$/.test(line);
	const m = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
	return !!m && m[1][0] === marker[0] && m[1].length >= marker.length;
}
