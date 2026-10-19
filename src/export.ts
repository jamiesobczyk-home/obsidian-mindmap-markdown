// Export a map as OPML, a plain Markdown outline, or a standalone SVG.
//
// Pure string building with no Obsidian or DOM imports, so it is unit-tested
// under Node. The SVG mirrors styles.css: the view hands over the boxes it laid
// out and the colours the theme resolved to, and this draws the same picture.

import { Box, bounds, decorations, edgePath, linkPath } from "./layout";
import { MapDoc, MindNode, countDescendants } from "./model";

// ---- XML ------------------------------------------------------------------

// Characters XML 1.0 can't hold at all, even escaped.
// eslint-disable-next-line no-control-regex -- XML's allowed set is defined by code point, starting at tab, newline and carriage return
const XML_INVALID = /[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu;

export function escapeXml(s: string): string {
	return s
		.replace(XML_INVALID, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;")
		.replace(/\n/g, "&#10;");
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

// ---- OPML and Markdown --------------------------------------------------

// Folded branches are included: export is of the map, not of the viewport.
// Text stays as Markdown so outliners that understand it keep the links.
export function toOPML(doc: MapDoc): string {
	const out = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<opml version="2.0">',
		"\t<head>",
		`\t\t<title>${escapeXml(oneLine(doc.root.text))}</title>`,
		"\t</head>",
		"\t<body>",
	];
	const walk = (n: MindNode, depth: number) => {
		const pad = "\t".repeat(depth);
		const attr = `text="${escapeXml(oneLine(n.text))}"`;
		if (n.children.length === 0) {
			out.push(`${pad}<outline ${attr}/>`);
			return;
		}
		out.push(`${pad}<outline ${attr}>`);
		for (const c of n.children) walk(c, depth + 1);
		out.push(`${pad}</outline>`);
	};
	for (const c of doc.root.children) walk(c, 2);
	out.push("\t</body>", "</opml>", "");
	return out.join("\n");
}

// The note's heading and list only, for pasting into another note or app.
export function toMarkdownOutline(doc: MapDoc): string {
	const out: string[] = [];
	const walk = (kids: MindNode[], depth: number) => {
		for (const c of kids) {
			out.push(`${doc.indentUnit.repeat(depth)}${doc.bullet} ${oneLine(c.text)}`);
			walk(c.children, depth + 1);
		}
	};
	// One heading per central topic, as in the note itself.
	const section = (title: string, kids: MindNode[]) => {
		out.push(`# ${oneLine(title)}`, "");
		walk(kids, 0);
		if (kids.length === 0) out.pop();
		out.push("");
	};
	section(doc.root.text, doc.root.children.filter((c) => !c.central));
	for (const c of doc.root.children.filter((c) => c.central)) section(c.text, c.children);
	return out.join("\n");
}

// Inline Markdown to the text a reader sees. Links keep their display text.
export function stripMarkdown(s: string): string {
	return oneLine(s)
		.replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
		.replace(/!?\[\[([^\]]*)\]\]/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		// Inline HTML renders as markup on screen, not as visible text.
		.replace(/<\/?[A-Za-z][\w-]*(\s[^<>]*)?\/?>/g, "")
		.replace(/\*\*(?!\s)(.+?)\*\*/g, "$1")
		.replace(/__(?!\s)(.+?)__/g, "$1")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/==(.+?)==/g, "$1")
		.replace(/\*(?!\s)([^*]*?[^\s*])\*/g, "$1")
		// Only a whole-word _x_: snake_case names stay as they are.
		.replace(/(^|\W)_(?!\s)([^_]*?[^\s_])_(?!\w)/g, "$1$2")
		.replace(/\\([\\`*_[\]()#+\-.!~=|<>])/g, "$1")
		.replace(/ {2,}/g, " ")
		.trim();
}

// ---- SVG ------------------------------------------------------------------

export interface ExportStyle {
	fontFamily?: string;
	fontSize?: number; // px, the theme's text size
	background?: string;
	text?: string;
	accent?: string; // root fill
	textOnAccent?: string;
	faint?: string; // edges with no branch colour
	// Branch colours by top-level branch index, as .mm-c0 ... .mm-c7.
	branchColors?: string[];
	// Colours read off the rendered nodes; these win over branchColors so a
	// per-topic colour on screen comes out the same in the file.
	nodeColors?: Map<MindNode, string>;
	// Rendered widths of fold badges, since theme CSS decides their sizing.
	badgeWidths?: Map<MindNode, number>;
	// Text width in px for a CSS font string. Without it widths are estimated,
	// which only matters for labels that wrap.
	measure?: (text: string, font: string) => number;
	// Images shown in topics, as data URIs placed relative to the topic's box.
	// A topic with images drops its embed text and draws the pictures instead.
	images?: Map<MindNode, ExportImage[]>;
}

export interface ExportImage {
	href: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

const EMBED = /!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g;

// Obsidian's default light theme, used for anything the caller leaves out.
const DEFAULTS = {
	fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif",
	fontSize: 16,
	background: "#ffffff",
	text: "#222222",
	accent: "#7852ee",
	textOnAccent: "#ffffff",
	faint: "#ababab",
	branchColors: ["#086ddd", "#ec7500", "#08b94e", "#7852ee", "#e93147", "#00bfbc", "#e0ac00", "#d53984"],
};

const PAD = 32;
const LINE_HEIGHT = 1.4;
const BADGE_H = 20;
const BADGE_GAP = 6;
const BADGE_FONT = 11;
const DECOR_FONT = 13; // boundary and summary labels, as in styles.css

// Per-depth box metrics from styles.css: padding plus border, in px.
interface Shape {
	top: number;
	bottom: number;
	left: number;
	right: number;
	scale: number; // font size relative to the theme's
	weight: number;
}
const ROOT: Shape = { top: 10, bottom: 10, left: 20, right: 20, scale: 1.25, weight: 600 };
const BRANCH: Shape = { top: 7, bottom: 7, left: 14, right: 14, scale: 1, weight: 500 };
const LEAF: Shape = { top: 2, bottom: 5, left: 4, right: 4, scale: 1, weight: 400 };
const shapeAt = (depth: number) => (depth === 0 ? ROOT : depth === 1 ? BRANCH : LEAF);

const num = (n: number) => String(Math.round(n * 100) / 100);

// Greedy word wrap into lines no wider than max; words longer than a line
// break anywhere, as overflow-wrap: anywhere does on screen.
function wrap(text: string, max: number, width: (s: string) => number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		const next = line ? `${line} ${word}` : word;
		if (width(next) <= max || !line) {
			line = next;
		} else {
			lines.push(line);
			line = word;
		}
		while (width(line) > max && line.length > 1) {
			let cut = line.length - 1;
			while (cut > 1 && width(line.slice(0, cut)) > max) cut--;
			lines.push(line.slice(0, cut));
			line = line.slice(cut);
		}
	}
	lines.push(line);
	return lines;
}

export function toSVG(doc: MapDoc, boxes: Map<MindNode, Box>, style: ExportStyle = {}): string {
	// Skip unset and empty values so a colour the theme didn't resolve falls
	// back to the default instead of becoming fill="undefined".
	const given = Object.fromEntries(Object.entries(style).filter(([, v]) => v !== undefined && v !== ""));
	const s = { ...DEFAULTS, ...given } as typeof DEFAULTS & ExportStyle;
	const palette = s.branchColors.length > 0 ? s.branchColors : DEFAULTS.branchColors;
	const colorOf = (n: MindNode, b: Box) =>
		style.nodeColors?.get(n) ?? (b.branch >= 0 ? palette[b.branch % palette.length] : s.faint);
	const font = (size: number, weight: number) => `${weight} ${size}px ${s.fontFamily}`;
	const widthOf = (text: string, size: number, weight: number) =>
		s.measure ? s.measure(text, font(size, weight)) : text.length * size * 0.56;

	// Visible topics with their depth, in tree order.
	const visible: { n: MindNode; b: Box; depth: number; parent: MindNode | null }[] = [];
	const walk = (n: MindNode, depth: number, parent: MindNode | null) => {
		const b = boxes.get(n);
		if (!b) return;
		visible.push({ n, b, depth, parent });
		// Further central topics are drawn as centres: depth restarts, no line back.
		if (!n.collapsed)
			for (const c of n.children) {
				if (n === doc.root && c.central) walk(c, 0, null);
				else walk(c, depth + 1, n);
			}
	};
	walk(doc.root, 0, null);

	const edges: string[] = [];
	const nodes: string[] = [];
	const extents: Box[] = visible.map((v) => v.b);

	for (const { n, b, depth, parent } of visible) {
		const color = colorOf(n, b);
		if (parent) {
			const pb = boxes.get(parent)!;
			const sw = depth === 1 ? 3 : depth === 2 ? 2 : 1.5;
			edges.push(
				`<path d="${edgePath(pb, b, depth - 1)}" fill="none" stroke="${escapeXml(color)}" ` +
					`stroke-width="${sw}" stroke-linecap="round"/>`,
			);
		}

		const shape = shapeAt(depth);
		const size = s.fontSize * shape.scale;
		const lh = size * LINE_HEIGHT;
		const g: string[] = [];
		let textFill = s.text;
		if (depth === 0) {
			g.push(`<rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(b.h)}" rx="12" fill="${escapeXml(s.accent)}"/>`);
			textFill = s.textOnAccent;
		} else if (depth === 1) {
			// The 2px border sits inside the measured box, so inset the stroke by 1.
			g.push(
				`<rect x="${num(b.x + 1)}" y="${num(b.y + 1)}" width="${num(b.w - 2)}" height="${num(b.h - 2)}" rx="7" ` +
					`fill="${escapeXml(s.background)}" stroke="${escapeXml(color)}" stroke-width="2"/>`,
			);
		} else {
			g.push(
				`<line x1="${num(b.x)}" y1="${num(b.y + b.h - 1)}" x2="${num(b.x + b.w)}" y2="${num(b.y + b.h - 1)}" ` +
					`stroke="${escapeXml(color)}" stroke-width="2"/>`,
			);
		}

		// Take the line count from the measured height, so a label wraps here
		// exactly when it wrapped on screen.
		const pictures = style.images?.get(n) ?? [];
		const label = stripMarkdown(pictures.length > 0 ? n.text.replace(EMBED, " ") : n.text);
		const inner = b.w - shape.left - shape.right;
		// With pictures the box's height is mostly image, so the text takes one
		// line at the top rather than a line count read from the height.
		const rows = pictures.length > 0 ? 1 : Math.max(1, Math.round((b.h - shape.top - shape.bottom) / lh));
		const lines = rows === 1 ? [label] : wrap(label, inner + 1, (t) => widthOf(t, size, shape.weight));
		const centred = depth === 0;
		const tx = centred ? b.x + b.w / 2 : b.x + shape.left;
		const top =
			pictures.length > 0
				? b.y + shape.top
				: b.y + shape.top + (b.h - shape.top - shape.bottom - lh * lines.length) / 2;
		for (const im of pictures) {
			g.push(
				`<image href="${escapeXml(im.href)}" x="${num(b.x + im.x)}" y="${num(b.y + im.y)}" width="${num(im.w)}" ` +
					`height="${num(im.h)}" preserveAspectRatio="xMidYMid meet"/>`,
			);
		}
		const attrs =
			`class="label" x="${num(tx)}" font-size="${num(size)}" font-weight="${shape.weight}" ` +
			`fill="${escapeXml(textFill)}"${centred ? ' text-anchor="middle"' : ""}`;
		const y = (i: number) => num(top + lh * (i + 0.5));
		if (lines.length === 1) {
			g.push(`<text ${attrs} y="${y(0)}" dy="0.35em">${escapeXml(lines[0])}</text>`);
		} else {
			const spans = lines.map((l, i) => `<tspan x="${num(tx)}" y="${y(i)}" dy="0.35em">${escapeXml(l)}</tspan>`);
			g.push(`<text ${attrs}>${spans.join("")}</text>`);
		}

		// Notes and images: a topic with a note gets a small note glyph where the
		// marker sits on screen, in the room styles.css leaves for it.
		if (n.note) {
			const gx = b.x + b.w - (depth === 0 ? 10 : depth === 1 ? 6 : 3) - 15;
			const gy = b.y + b.h / 2 - 6;
			const ink = escapeXml(depth === 0 ? s.textOnAccent : color);
			g.push(
				`<path class="note-glyph" d="M${num(gx + 2)} ${num(gy)}h7l4 4v8h-11z M${num(gx + 9)} ${num(gy)}v4h4" ` +
					`fill="none" stroke="${ink}" stroke-width="1.5" stroke-linejoin="round"/>`,
			);
		}

		if (n.collapsed && n.children.length > 0 && n !== doc.root) {
			const count = String(countDescendants(n));
			const bw = style.badgeWidths?.get(n) || Math.max(BADGE_H, widthOf(count, BADGE_FONT, 600) + 10);
			const bx = b.side === "left" ? b.x - BADGE_GAP - bw : b.x + b.w + BADGE_GAP;
			// Leaves carry the badge on their underline, boxes at their middle.
			const cy = depth > 1 ? b.y + b.h : b.y + b.h / 2;
			g.push(
				`<rect x="${num(bx)}" y="${num(cy - BADGE_H / 2)}" width="${num(bw)}" height="${BADGE_H}" ` +
					`rx="${BADGE_H / 2}" fill="${escapeXml(color)}"/>`,
				`<text class="badge" x="${num(bx + bw / 2)}" y="${num(cy)}" dy="0.35em" text-anchor="middle" ` +
					`font-size="${BADGE_FONT}" font-weight="600" fill="${escapeXml(s.background)}">${count}</text>`,
			);
			extents.push({ x: bx, y: cy - BADGE_H / 2, w: bw, h: BADGE_H, side: b.side, branch: b.branch });
		}
		nodes.push(`<g>${g.join("")}</g>`);
	}

	// Relationship lines, as on screen: an end inside a folded branch attaches
	// to the nearest visible topic above it; a line whose ends meet is skipped.
	const parents = new Map<MindNode, MindNode>();
	const index = (n: MindNode): void => n.children.forEach((c) => (parents.set(c, n), index(c)));
	index(doc.root);
	const shownEnd = (n: MindNode) => {
		let cur: MindNode | undefined = n;
		while (cur && !boxes.has(cur)) cur = parents.get(cur);
		return cur ?? null;
	};
	const links: string[] = [];
	for (const link of doc.links) {
		const a = shownEnd(link.from);
		const b = shownEnd(link.to);
		if (!a || !b || a === b) continue;
		const geo = linkPath(boxes.get(a)!, boxes.get(b)!);
		links.push(
			`<path class="link" d="${geo.d}" fill="none" stroke="${escapeXml(s.faint)}" stroke-width="1.5" ` +
				`stroke-dasharray="6 4" marker-end="url(#mm-arrow)"/>`,
		);
		if (link.label) {
			links.push(
				`<text class="link-label" x="${num(geo.labelX)}" y="${num(geo.labelY)}" dy="0.35em" text-anchor="middle" ` +
					`font-size="12" font-style="italic" fill="${escapeXml(s.faint)}" stroke="${escapeXml(s.background)}" ` +
					`stroke-width="4" stroke-linejoin="round" paint-order="stroke">${escapeXml(link.label)}</text>`,
			);
			const w = widthOf(link.label, 12, 400);
			extents.push({ x: geo.labelX - w / 2, y: geo.labelY - 8, w, h: 16, side: "right", branch: -1 });
		}
		// The curve bows outside the boxes, so its control points count toward the frame.
		const pts = geo.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
		for (let i = 0; i + 1 < pts.length; i += 2) {
			extents.push({ x: pts[i], y: pts[i + 1], w: 0, h: 0, side: "right", branch: -1 });
		}
	}

	// Boundaries and summary braces, worked out as on screen. Boundaries go
	// behind everything; braces and their text sit beside the topics.
	const decor = decorations(doc.root, doc.root, boxes, doc.summaries, (t) => widthOf(t, DECOR_FONT, 500));
	const behind: string[] = [];
	const braces: string[] = [];
	for (const r of decor.boundaries) {
		const color = escapeXml(colorOf(r.node, boxes.get(r.node)!));
		behind.push(
			`<rect class="boundary" x="${num(r.x)}" y="${num(r.y)}" width="${num(r.w)}" height="${num(r.h)}" rx="10" ` +
				`fill="${color}" fill-opacity="0.06" stroke="${color}" stroke-opacity="0.8" stroke-width="1.5"/>`,
		);
		const label = (r.node.boundary ?? "").trim();
		if (label) {
			behind.push(
				`<text class="boundary-label" x="${num(r.labelX)}" y="${num(r.labelY)}" dy="0.35em" font-size="${DECOR_FONT - 1}" ` +
					`font-weight="600" fill="${color}">${escapeXml(label)}</text>`,
			);
		}
		extents.push({ x: r.x, y: r.y, w: r.w, h: r.h, side: "right", branch: -1 });
	}
	for (const br of decor.braces) {
		const color = escapeXml(colorOf(br.color, boxes.get(br.color)!));
		braces.push(
			`<path class="summary" d="${br.d}" fill="none" stroke="${color}" stroke-width="2" ` +
				`stroke-linecap="round" stroke-linejoin="round"/>`,
		);
		const pts = br.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
		for (let i = 0; i + 1 < pts.length; i += 2) {
			extents.push({ x: pts[i], y: pts[i + 1], w: 0, h: 0, side: "right", branch: -1 });
		}
		const text = br.summary.text.trim();
		if (!text) continue;
		braces.push(
			`<text class="summary-label" x="${num(br.labelX)}" y="${num(br.labelY)}" dy="0.35em" text-anchor="${br.anchor}" ` +
				`font-size="${DECOR_FONT}" font-style="italic" font-weight="500" fill="${color}">${escapeXml(text)}</text>`,
		);
		const w = widthOf(text, DECOR_FONT, 500);
		const x = br.anchor === "start" ? br.labelX : br.anchor === "end" ? br.labelX - w : br.labelX - w / 2;
		extents.push({ x, y: br.labelY - DECOR_FONT, w, h: DECOR_FONT * 2, side: "right", branch: -1 });
	}

	const box = extents.length > 0 ? bounds(extents) : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	const vx = Math.floor(box.minX - PAD);
	const vy = Math.floor(box.minY - PAD);
	const vw = Math.ceil(box.maxX + PAD) - vx;
	const vh = Math.ceil(box.maxY + PAD) - vy;
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="${vx} ${vy} ${vw} ${vh}" ` +
			`font-family="${escapeXml(s.fontFamily)}">`,
		`<title>${escapeXml(stripMarkdown(doc.root.text))}</title>`,
		`<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${escapeXml(s.background)}"/>`,
		`<defs><marker id="mm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" ` +
			`orient="auto-start-reverse"><polygon points="0,0 10,5 0,10" fill="${escapeXml(s.faint)}"/></marker></defs>`,
		...(behind.length > 0 ? [`<g>${behind.join("")}</g>`] : []),
		`<g>${edges.join("")}</g>`,
		...nodes,
		...(braces.length > 0 ? [`<g>${braces.join("")}</g>`] : []),
		`<g>${links.join("")}</g>`,
		"</svg>",
		"",
	].join("\n");
}
