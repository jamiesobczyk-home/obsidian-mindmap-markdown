// Tidy-tree layout. Pure: takes measured node sizes, returns positions, so it
// can be tested without a DOM.
//
// Coordinates are in map space with the root's centre at (0, 0). Each node's
// box is its top-left corner plus the measured size.

import type { Layout, MindNode, Summary } from "./model";

export const H_GAP = 56; // parent edge to child edge
export const V_GAP = 10; // between sibling subtrees
export const DOWN_H_GAP = 24; // org chart: between sibling subtrees
export const DOWN_V_GAP = 48; // org chart: between levels
export const INDENT = 32; // outline: one step of indentation

export type Side = "right" | "left" | "down" | "outline" | "root";

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
	side: Side;
	branch: number; // index of the top-level branch this node sits in; -1 for the root
}

export type Size = { w: number; h: number };

// Space between the main tree and each further central topic's tree.
export const CENTRAL_GAP = 120;

export interface LayoutOptions {
	// Multiplies every gap between topics: below 1 is compact, above is roomy.
	spacing?: number;
}

interface Gaps {
	h: number;
	v: number;
	dh: number;
	dv: number;
	indent: number;
	central: number;
}

const gapsFor = (spacing = 1): Gaps => ({
	h: H_GAP * spacing,
	v: V_GAP * spacing,
	dh: DOWN_H_GAP * spacing,
	dv: DOWN_V_GAP * spacing,
	indent: INDENT,
	central: CENTRAL_GAP * spacing,
});

// Room a boundary needs around its branch, so it never overlaps a neighbour:
// the padding on every side, plus the label band on top when it has a label.
// The tree's own root never gets a boundary.
function boundaryRoom(n: MindNode, isRoot: boolean): { top: number; bottom: number; side: number } {
	if (isRoot || n.boundary === undefined) return { top: 0, bottom: 0, side: 0 };
	const labelled = n.boundary.trim() !== "";
	return { top: BOUNDARY_PAD + (labelled ? BOUNDARY_LABEL_H : 0), bottom: BOUNDARY_PAD, side: BOUNDARY_PAD };
}

export function layoutTree(
	root: MindNode,
	sizeOf: (n: MindNode) => Size,
	layout: Layout,
	options: LayoutOptions = {},
): Map<MindNode, Box> {
	const g = gapsFor(options.spacing);
	const centrals = root.children.filter((c) => c.central);
	if (centrals.length === 0) return layoutOne(root, sizeOf, layout, g);

	// Lay out the main tree without its central topics (a stand-in root keeps
	// the real one's identity out of the way), then each central topic as a
	// tree of its own, placed after the previous one: rightwards, or downwards
	// in the outline layout.
	const main: MindNode = { ...root, children: root.children.filter((c) => !c.central) };
	const boxes = new Map<MindNode, Box>();
	for (const [n, b] of layoutOne(main, (n) => sizeOf(n === main ? root : n), layout, g)) {
		boxes.set(n === main ? root : n, b);
	}
	let branches = main.collapsed ? 0 : main.children.length;
	for (const central of centrals) {
		const sub = layoutOne(central, sizeOf, layout, g);
		const prev = bounds(boxes.values());
		const own = bounds(sub.values());
		const c = sub.get(central)!;
		const dx = layout === "outline" ? prev.minX - own.minX : prev.maxX + g.central - own.minX;
		const dy = layout === "outline" ? prev.maxY + g.central / 2 - own.minY : -(c.y + c.h / 2);
		for (const [n, b] of sub) {
			const branch = n === central ? -1 : b.branch + branches;
			boxes.set(n, { ...b, x: b.x + dx, y: b.y + dy, side: n === central ? "root" : b.side, branch });
		}
		branches += central.collapsed ? 0 : central.children.length;
	}
	return boxes;
}

function layoutOne(root: MindNode, sizeOf: (n: MindNode) => Size, layout: Layout, g: Gaps): Map<MindNode, Box> {
	if (layout === "down") return layoutDown(root, sizeOf, g);
	if (layout === "outline") return layoutOutline(root, sizeOf, g);
	const boxes = new Map<MindNode, Box>();
	const subtree = new Map<MindNode, number>();

	const visible = (n: MindNode) => (n.collapsed ? [] : n.children);

	const heightOf = (n: MindNode): number => {
		const cached = subtree.get(n);
		if (cached !== undefined) return cached;
		const kids = visible(n);
		const kidsH = kids.reduce((s, c) => s + heightOf(c), 0) + g.v * Math.max(0, kids.length - 1);
		const room = boundaryRoom(n, n === root);
		const h = Math.max(sizeOf(n).h, kidsH) + room.top + room.bottom;
		subtree.set(n, h);
		return h;
	};

	// edge: the x of the parent's facing edge; for the right side children start
	// there, for the left side they end there.
	const place = (n: MindNode, edge: number, cy: number, side: "right" | "left", branch: number) => {
		const { w, h } = sizeOf(n);
		const x = side === "right" ? edge : edge - w;
		boxes.set(n, { x, y: cy - h / 2, w, h, side, branch });
		const childEdge = side === "right" ? x + w + g.h : x - g.h;
		stack(visible(n), childEdge, cy, side, () => branch);
	};

	const stack = (
		kids: MindNode[],
		edge: number,
		cy: number,
		side: "right" | "left",
		branchOf: (i: number) => number,
	) => {
		const total = kids.reduce((s, c) => s + heightOf(c), 0) + g.v * Math.max(0, kids.length - 1);
		let top = cy - total / 2;
		kids.forEach((c, i) => {
			const sh = heightOf(c);
			// The topic sits in the middle of its branch, inside any boundary room.
			const room = boundaryRoom(c, false);
			place(c, edge, top + room.top + (sh - room.top - room.bottom) / 2, side, branchOf(i));
			top += sh + g.v;
		});
	};

	const rs = sizeOf(root);
	boxes.set(root, { x: -rs.w / 2, y: -rs.h / 2, w: rs.w, h: rs.h, side: "root", branch: -1 });

	const kids = visible(root);
	const split = layout === "balanced" ? balancedSplit(kids.map(heightOf)) : kids.length;
	const right = kids.slice(0, split);
	const left = kids.slice(split);
	stack(right, rs.w / 2 + g.h, 0, "right", (i) => i);
	// Reversed so the map reads clockwise: down the right, then up the left.
	stack([...left].reverse(), -rs.w / 2 - g.h, 0, "left", (i) => kids.length - 1 - i);
	return boxes;
}

const visibleKids = (n: MindNode) => (n.collapsed ? [] : n.children);

// Org chart. Each subtree is treated as a rectangle; sibling rectangles sit
// side by side, so subtrees can't overlap, and the parent is centred over the
// span of its children's boxes. Every level shares one row, sized to its
// tallest topic, so the levels read as clean horizontal bands.
function layoutDown(root: MindNode, sizeOf: (n: MindNode) => Size, g: Gaps): Map<MindNode, Box> {
	type Shape = { l: number; r: number; offsets: number[] }; // relative to the node's centre x
	const shapes = new Map<MindNode, Shape>();
	const rowH: number[] = [];

	const measure = (n: MindNode, depth: number): Shape => {
		const { w, h } = sizeOf(n);
		rowH[depth] = Math.max(rowH[depth] ?? 0, h);
		const kids = visibleKids(n);
		const kidShapes = kids.map((c) => measure(c, depth + 1));
		const offsets: number[] = [];
		let right = 0;
		kidShapes.forEach((ks, i) => {
			offsets.push(i === 0 ? -ks.l : right + g.dh - ks.l);
			right = offsets[i] + ks.r;
		});
		if (kids.length > 0) {
			// Centre the parent on its children's boxes, not their subtrees, so a
			// wide grandchild row on one side doesn't pull it off centre.
			const last = kids.length - 1;
			const mid = (offsets[0] - sizeOf(kids[0]).w / 2 + offsets[last] + sizeOf(kids[last]).w / 2) / 2;
			for (let i = 0; i <= last; i++) offsets[i] -= mid;
		}
		let l = -w / 2, r = w / 2;
		kidShapes.forEach((ks, i) => {
			l = Math.min(l, offsets[i] + ks.l);
			r = Math.max(r, offsets[i] + ks.r);
		});
		// A boundary widens the branch so neighbours keep clear of it.
		const room = boundaryRoom(n, n === root);
		l -= room.side;
		r += room.side;
		const shape = { l, r, offsets };
		shapes.set(n, shape);
		return shape;
	};
	measure(root, 0);

	const rowTop: number[] = [-sizeOf(root).h / 2];
	for (let d = 1; d < rowH.length; d++) rowTop[d] = rowTop[d - 1] + rowH[d - 1] + g.dv;

	const boxes = new Map<MindNode, Box>();
	const place = (n: MindNode, cx: number, depth: number, branch: number) => {
		const { w, h } = sizeOf(n);
		boxes.set(n, { x: cx - w / 2, y: rowTop[depth], w, h, side: depth === 0 ? "root" : "down", branch });
		const { offsets } = shapes.get(n)!;
		visibleKids(n).forEach((c, i) => place(c, cx + offsets[i], depth + 1, depth === 0 ? i : branch));
	};
	place(root, 0, 0, -1);
	return boxes;
}

// Indented tree, like a file browser: one topic per row in document order,
// each indented one step right of its parent.
function layoutOutline(root: MindNode, sizeOf: (n: MindNode) => Size, g: Gaps): Map<MindNode, Box> {
	const boxes = new Map<MindNode, Box>();
	const rs = sizeOf(root);
	const left = -rs.w / 2;
	let top = -rs.h / 2;
	const place = (n: MindNode, depth: number, branch: number) => {
		const { w, h } = sizeOf(n);
		const room = boundaryRoom(n, depth === 0);
		top += room.top;
		boxes.set(n, { x: left + depth * g.indent, y: top, w, h, side: depth === 0 ? "root" : "outline", branch });
		top += h + g.v;
		visibleKids(n).forEach((c, i) => place(c, depth + 1, depth === 0 ? i : branch));
		top += room.bottom;
	};
	place(root, 0, -1);
	return boxes;
}

// The first k children go right, the rest left.
// Pick the k that makes the two sides closest in height.
export function balancedSplit(heights: number[]): number {
	if (heights.length <= 1) return heights.length;
	const total = heights.reduce((a, b) => a + b, 0);
	let best = heights.length;
	let bestDiff = Infinity;
	let acc = 0;
	for (let k = 1; k <= heights.length; k++) {
		acc += heights[k - 1];
		const diff = Math.abs(acc - (total - acc));
		if (diff < bestDiff) {
			bestDiff = diff;
			best = k;
		}
	}
	return best;
}

export function bounds(boxes: Iterable<Box>): { minX: number; minY: number; maxX: number; maxY: number } {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const b of boxes) {
		minX = Math.min(minX, b.x);
		minY = Math.min(minY, b.y);
		maxX = Math.max(maxX, b.x + b.w);
		maxY = Math.max(maxY, b.y + b.h);
	}
	return { minX, minY, maxX, maxY };
}

// The SVG path for the line from a parent to a child. depth is the parent's
// depth (root = 0). Root and first-level topics are boxes, so lines meet their
// middle; deeper topics are underlined, so lines run into the underline.
export function edgePath(parent: Box, child: Box, depth: number): string {
	const anchorY = (b: Box, d: number) => (d <= 1 ? b.y + b.h / 2 : b.y + b.h);
	if (child.side === "down") {
		// Bottom centre to top centre, leaving and arriving vertically.
		const x1 = parent.x + parent.w / 2;
		const y1 = parent.y + parent.h;
		const x2 = child.x + child.w / 2;
		const y2 = child.y;
		const mid = (y1 + y2) / 2;
		return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
	}
	if (child.side === "outline") {
		// Elbow: down from under the parent's left end, then across. The trunk
		// sits half an indent in, left of every child, so it never crosses one.
		const x1 = parent.x + Math.min(INDENT / 2, parent.w / 2);
		const y1 = parent.y + parent.h;
		const x2 = child.x;
		const y2 = anchorY(child, depth + 1);
		const r = Math.max(0, Math.min(6, y2 - y1, x2 - x1));
		return `M ${x1} ${y1} L ${x1} ${y2 - r} Q ${x1} ${y2}, ${x1 + r} ${y2} L ${x2} ${y2}`;
	}
	const right = child.side !== "left";
	const x1 = right ? parent.x + parent.w : parent.x;
	const x2 = right ? child.x : child.x + child.w;
	const y1 = anchorY(parent, depth);
	const y2 = anchorY(child, depth + 1);
	const mid = (x1 + x2) / 2;
	return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

export type Direction = "up" | "down" | "left" | "right";

// Arrow-key navigation that works for any layout: the nearest topic whose
// centre lies in that direction, favouring topics in line with this one.
// Pass the topic's parent, children and siblings as `related` to try them
// first: pure geometry can jump to a cousin or grandchild that happens to be
// closer (org chart, outline), which feels wrong when a relative lies that way.
export function nearestInDirection<T>(boxes: Map<T, Box>, from: T, dir: Direction, related?: T[]): T | null {
	if (related) {
		const near = new Map<T, Box>();
		for (const n of [from, ...related]) {
			const b = boxes.get(n);
			if (b) near.set(n, b);
		}
		const hit = nearestInDirection(near, from, dir);
		if (hit !== null) return hit;
	}
	const a = boxes.get(from);
	if (!a) return null;
	const ax = a.x + a.w / 2;
	const ay = a.y + a.h / 2;
	let best: T | null = null;
	let bestScore = Infinity;
	for (const [n, b] of boxes) {
		if (n === from) continue;
		const dx = b.x + b.w / 2 - ax;
		const dy = b.y + b.h / 2 - ay;
		const along = dir === "right" ? dx : dir === "left" ? -dx : dir === "down" ? dy : -dy;
		const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
		if (along <= 1) continue;
		const score = along + across * 3;
		if (score < bestScore) {
			bestScore = score;
			best = n;
		}
	}
	return best;
}

// A relationship line: a curve from the edge of one box to the edge of the
// other, bowed to one side so it doesn't run along the tree's own lines.
// Returns the SVG path and a point near its middle for the label.
export function linkPath(from: Box, to: Box): { d: string; labelX: number; labelY: number } {
	const ax = from.x + from.w / 2;
	const ay = from.y + from.h / 2;
	const bx = to.x + to.w / 2;
	const by = to.y + to.h / 2;
	const exit = (box: Box, cx: number, cy: number, dx: number, dy: number) => {
		// Where the ray from the centre towards (dx, dy) leaves the box.
		if (dx === 0 && dy === 0) return { x: cx, y: box.y };
		const sx = dx === 0 ? Infinity : box.w / 2 / Math.abs(dx);
		const sy = dy === 0 ? Infinity : box.h / 2 / Math.abs(dy);
		const k = Math.min(sx, sy);
		return { x: cx + dx * k, y: cy + dy * k };
	};
	const dx = bx - ax;
	const dy = by - ay;
	const p1 = exit(from, ax, ay, dx, dy);
	const p2 = exit(to, bx, by, -dx, -dy);
	const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
	// Bow by a fifth of the length (at least 40px) to the right of travel.
	const bow = Math.max(40, len * 0.2);
	const nx = len === 0 ? 0 : -(p2.y - p1.y) / len;
	const ny = len === 0 ? -1 : (p2.x - p1.x) / len;
	const c1x = p1.x + (p2.x - p1.x) / 3 + nx * bow;
	const c1y = p1.y + (p2.y - p1.y) / 3 + ny * bow;
	const c2x = p1.x + ((p2.x - p1.x) * 2) / 3 + nx * bow;
	const c2y = p1.y + ((p2.y - p1.y) * 2) / 3 + ny * bow;
	const r = (v: number) => Math.round(v * 10) / 10;
	return {
		d: `M ${r(p1.x)} ${r(p1.y)} C ${r(c1x)} ${r(c1y)}, ${r(c2x)} ${r(c2y)}, ${r(p2.x)} ${r(p2.y)}`,
		// The curve's midpoint (t = 0.5 of the cubic).
		labelX: r((p1.x + 3 * c1x + 3 * c2x + p2.x) / 8),
		labelY: r((p1.y + 3 * c1y + 3 * c2y + p2.y) / 8),
	};
}

// ---- Boundaries and summary brackets -----------------------------------------
//
// Decorations drawn around the laid-out boxes. Worked out from whatever boxes
// are passed in (a frame mid-glide, or the final layout), so they move with
// the topics and never disagree with them.

export const BOUNDARY_PAD = 10; // boundary edge to the nearest thing inside it
export const BOUNDARY_LABEL_H = 18; // band at a labelled boundary's top for its label
export const BRACE_GAP = 8; // furthest topic to the brace
export const BRACE_DEPTH = 12; // brace base to its tip
export const BRACE_LABEL_GAP = 8; // brace tip to its label
export const DECOR_LABEL_H = 18; // height allowed for one line of label
// A folded topic's count badge sits just outside its box.
const BADGE_ROOM = 32;

export type Extent = { minX: number; minY: number; maxX: number; maxY: number };

// Rough width of a label in the 13px italic used for both labels; callers
// that can measure text pass their own.
export const estimateLabelWidth = (text: string) => text.length * 7;

const r1 = (v: number) => Math.round(v * 10) / 10;

const unite = (a: Extent, b: Extent): Extent => ({
	minX: Math.min(a.minX, b.minX),
	minY: Math.min(a.minY, b.minY),
	maxX: Math.max(a.maxX, b.maxX),
	maxY: Math.max(a.maxY, b.maxY),
});

// The side of a run of siblings a summary brace goes on: away from the parent.
export type BraceSide = "right" | "left" | "down";
export const braceSide = (side: Side): BraceSide | null =>
	side === "root" ? null : side === "left" ? "left" : side === "down" ? "down" : "right";

// A curly brace along one edge of an extent, its tip pointing away from it,
// and where its label goes: past the tip, anchored so it reads outwards.
export function bracePath(
	ext: Extent,
	side: BraceSide,
): { d: string; labelX: number; labelY: number; anchor: "start" | "end" | "middle" } {
	const down = side === "down";
	// a runs along the brace, o outwards from its base.
	const a1 = down ? ext.minX : ext.minY;
	const a2 = down ? ext.maxX : ext.maxY;
	const base = side === "right" ? ext.maxX + BRACE_GAP : side === "left" ? ext.minX - BRACE_GAP : ext.maxY + BRACE_GAP;
	const dir = side === "left" ? -1 : 1;
	const pt = (a: number, o: number) => {
		const out = base + dir * o;
		return down ? `${r1(a)} ${r1(out)}` : `${r1(out)} ${r1(a)}`;
	};
	const am = (a1 + a2) / 2;
	const half = BRACE_DEPTH / 2;
	const q = Math.min(half, (a2 - a1) / 4);
	const d =
		`M ${pt(a1, 0)} Q ${pt(a1, half)}, ${pt(a1 + q, half)} L ${pt(am - q, half)} ` +
		`Q ${pt(am, half)}, ${pt(am, BRACE_DEPTH)} Q ${pt(am, half)}, ${pt(am + q, half)} ` +
		`L ${pt(a2 - q, half)} Q ${pt(a2, half)}, ${pt(a2, 0)}`;
	const out = base + dir * (BRACE_DEPTH + BRACE_LABEL_GAP);
	if (down) return { d, labelX: r1(am), labelY: r1(out + DECOR_LABEL_H / 2), anchor: "middle" };
	return { d, labelX: r1(out), labelY: r1(am), anchor: side === "left" ? "end" : "start" };
}

export interface BoundaryShape {
	node: MindNode;
	x: number;
	y: number;
	w: number;
	h: number;
	// Left end and vertical middle of the label, inside the top band.
	labelX: number;
	labelY: number;
}

export interface BraceShape {
	summary: Summary;
	d: string;
	labelX: number;
	labelY: number;
	anchor: "start" | "end" | "middle";
	color: MindNode; // the topic whose branch colour the brace takes
}

// Boundaries and summary braces for the topics laid out in boxes, walking
// from top (the shown centre). Worked out bottom-up, so each boundary takes in
// the boundaries and braces inside it, and each brace sits past the
// boundaries and braces in its run: nested ones never touch. Boundaries come
// outermost first, so inner ones draw on top. root is the whole map's root:
// its further central topics are trees of their own, not part of its branch.
// A summary whose ends are no longer siblings in order is skipped.
export function decorations(
	root: MindNode,
	top: MindNode,
	boxes: Map<MindNode, Box>,
	summaries: Summary[],
	labelWidth: (text: string) => number = estimateLabelWidth,
): { boundaries: BoundaryShape[]; braces: BraceShape[] } {
	const boundaries: BoundaryShape[] = [];
	const braces: BraceShape[] = [];
	const byParent = new Map<MindNode, Summary[]>();
	if (summaries.length > 0) {
		const parents = new Map<MindNode, MindNode>();
		const index = (n: MindNode): void => n.children.forEach((c) => (parents.set(c, n), index(c)));
		index(root);
		for (const sm of summaries) {
			const p = parents.get(sm.from);
			if (!p || parents.get(sm.to) !== p) continue;
			byParent.set(p, [...(byParent.get(p) ?? []), sm]);
		}
	}

	// Runs for every topic on every animation frame, so it grows its own
	// extent in place and keeps children's extents only where a summary needs
	// them, rather than allocating per topic.
	const extentOf = (n: MindNode): Extent => {
		const b = boxes.get(n)!;
		let e: Extent = { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h };
		if (n !== top && n.collapsed && n.children.length > 0) {
			if (b.side === "left") e.minX -= BADGE_ROOM;
			else if (b.side === "down") e.maxY += BADGE_ROOM;
			else e.maxX += BADGE_ROOM;
		}
		const sums = byParent.get(n);
		const kids = sums ? new Map<MindNode, Extent>() : null;
		for (const c of n.children) {
			if (!boxes.has(c)) continue;
			const ce = extentOf(c);
			// A further central topic stands on its own.
			if (n === root && c.central) continue;
			kids?.set(c, ce);
			// e is still this call's own object here, so it can grow in place.
			if (ce.minX < e.minX) e.minX = ce.minX;
			if (ce.minY < e.minY) e.minY = ce.minY;
			if (ce.maxX > e.maxX) e.maxX = ce.maxX;
			if (ce.maxY > e.maxY) e.maxY = ce.maxY;
		}
		for (const sm of sums ?? []) {
			if (!kids) break;
			const i = n.children.indexOf(sm.from);
			const j = n.children.indexOf(sm.to);
			const fb = boxes.get(sm.from);
			const side = fb && kids.has(sm.from) ? braceSide(fb.side) : null;
			if (i < 0 || j < i || !side || !kids.has(sm.to)) continue;
			// In the balanced layout a run can straddle both sides; the brace
			// goes with its first topic, over the topics on that side.
			let run: Extent | null = null;
			for (const c of n.children.slice(i, j + 1)) {
				const ce = kids.get(c);
				if (ce && braceSide(boxes.get(c)!.side) === side) run = run ? unite(run, ce) : ce;
			}
			if (!run) continue;
			const g = bracePath(run, side);
			braces.push({ summary: sm, ...g, color: sm.from });
			const w = sm.text ? labelWidth(sm.text) : 0;
			const lx = g.anchor === "start" ? g.labelX : g.anchor === "end" ? g.labelX - w : g.labelX - w / 2;
			const tip = side === "down"
				? { minX: run.minX, minY: run.maxY, maxX: run.maxX, maxY: run.maxY + BRACE_GAP + BRACE_DEPTH }
				: side === "left"
					? { minX: run.minX - BRACE_GAP - BRACE_DEPTH, minY: run.minY, maxX: run.minX, maxY: run.maxY }
					: { minX: run.maxX, minY: run.minY, maxX: run.maxX + BRACE_GAP + BRACE_DEPTH, maxY: run.maxY };
			e = unite(e, tip);
			if (w > 0) e = unite(e, { minX: lx, minY: g.labelY - DECOR_LABEL_H / 2, maxX: lx + w, maxY: g.labelY + DECOR_LABEL_H / 2 });
		}
		if (n.boundary !== undefined && n !== root) {
			const label = n.boundary.trim();
			const x = e.minX - BOUNDARY_PAD;
			const y = e.minY - BOUNDARY_PAD - (label ? BOUNDARY_LABEL_H : 0);
			const w = Math.max(e.maxX + BOUNDARY_PAD - x, label ? labelWidth(label) + 2 * BOUNDARY_PAD : 0);
			const h = e.maxY + BOUNDARY_PAD - y;
			boundaries.push({ node: n, x: r1(x), y: r1(y), w: r1(w), h: r1(h), labelX: r1(x + BOUNDARY_PAD), labelY: r1(y + 4 + BOUNDARY_LABEL_H / 2) });
			e = { minX: x, minY: y, maxX: x + w, maxY: y + h };
		}
		return e;
	};
	if (boxes.has(top)) extentOf(top);
	boundaries.reverse();
	return { boundaries, braces };
}

// Everything boundaries and braces cover, as boxes, so "fit to window" can
// include them: each boundary, each brace's path points and its label.
export function decorationExtents(
	shapes: { boundaries: BoundaryShape[]; braces: BraceShape[] },
	labelWidth: (text: string) => number = estimateLabelWidth,
): Box[] {
	const out: Box[] = [];
	const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h, side: "right", branch: -1 });
	for (const b of shapes.boundaries) out.push(box(b.x, b.y, b.w, b.h));
	for (const br of shapes.braces) {
		const pts = br.d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
		for (let i = 0; i + 1 < pts.length; i += 2) out.push(box(pts[i], pts[i + 1], 0, 0));
		const w = br.summary.text ? labelWidth(br.summary.text) : 0;
		const left = br.anchor === "start" ? br.labelX : br.anchor === "end" ? br.labelX - w : br.labelX - w / 2;
		out.push(box(left, br.labelY - 10, w, 20));
	}
	return out;
}
