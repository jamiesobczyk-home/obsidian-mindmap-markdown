// Pure logic behind direct manipulation: where a dragged topic would land,
// how the selection set changes, and the in-between frames of an animated
// relayout. No DOM and no Obsidian, so all of it is unit-tested.
//
// Nothing here knows which layout is in use. Drop zones come from the boxes
// themselves: the axis siblings are stacked along is measured, so the same
// code serves left/right trees, top-down org charts and outlines.

import type { Box } from "./layout";
import type { MindNode } from "./model";
import { isAncestor } from "./ops";

export type Point = { x: number; y: number };
export type Line = { x1: number; y1: number; x2: number; y2: number };

export interface Drop {
	// "child": becomes target's last child. "before"/"after": a sibling of
	// target, at index in parent's children (counted before the move).
	kind: "child" | "before" | "after";
	target: MindNode;
	parent: MindNode;
	index: number;
	// Where to draw the insertion line, in map coordinates; null for "child".
	line: Line | null;
}

// How far outside a box still counts as pointing at it, so the gaps between
// siblings are targets too.
const HIT_PAD = 12;
// The outer 30% of a box, along the stacking axis, means "insert beside".
const EDGE_ZONE = 0.3;
// An insertion line with no neighbour sits this far outside the box.
const LINE_OFFSET = 5;

const centre = (b: Box, axis: "x" | "y") => (axis === "x" ? b.x + b.w / 2 : b.y + b.h / 2);
const start = (b: Box, axis: "x" | "y") => (axis === "x" ? b.x : b.y);
const size = (b: Box, axis: "x" | "y") => (axis === "x" ? b.w : b.h);

function distance(b: Box, p: Point): number {
	const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
	const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
	return Math.hypot(dx, dy);
}

// The axis a group of siblings runs along. With two or more it's measured;
// an only child falls back on its side, since a top-down layout stacks
// children across the page and every other layout stacks them down it.
function stackAxis(siblings: Box[]): "x" | "y" {
	if (siblings.length >= 2) {
		const spread = (axis: "x" | "y") => {
			const cs = siblings.map((b) => centre(b, axis));
			return Math.max(...cs) - Math.min(...cs);
		};
		return spread("x") > spread("y") ? "x" : "y";
	}
	return (siblings[0]?.side as string) === "down" ? "x" : "y";
}

// Where a drop at map point p would put the dragged topics, or null if p is
// not over a legal target. dragged branches are never targets.
export function resolveDrop(
	centreNode: MindNode,
	boxes: Map<MindNode, Box>,
	p: Point,
	dragged: MindNode[],
): Drop | null {
	let hit: MindNode | null = null;
	let hitDist = Infinity;
	for (const [n, b] of boxes) {
		const d = distance(b, p);
		if (d > HIT_PAD || d >= hitDist) continue;
		if (dragged.some((m) => isAncestor(m, n))) continue;
		hit = n;
		hitDist = d;
	}
	if (!hit) return null;
	const target = hit;
	const tb = boxes.get(target)!;

	const parent = target === centreNode ? null : findParent(centreNode, target);
	const asChild = (): Drop => ({ kind: "child", target, parent: target, index: target.children.length, line: null });
	if (!parent) return asChild();

	// Siblings in the same column: a balanced map splits one parent's
	// children across two sides, and those aren't neighbours.
	const siblings = parent.children.filter((c) => boxes.get(c)?.side === tb.side);
	const sibBoxes = siblings.map((c) => boxes.get(c)!);
	const axis = stackAxis(sibBoxes);
	const t = (axis === "x" ? p.x - tb.x : p.y - tb.y) / Math.max(1, size(tb, axis));
	if (t >= EDGE_ZONE && t <= 1 - EDGE_ZONE) return asChild();
	const low = t < EDGE_ZONE;

	const ordered = siblings
		.map((n, i) => ({ n, b: sibBoxes[i] }))
		.sort((u, v) => centre(u.b, axis) - centre(v.b, axis));
	const at = ordered.findIndex((o) => o.n === target);
	const lowN = ordered[at - 1] ?? null;
	const highN = ordered[at + 1] ?? null;
	const pointed = low ? lowN : highN;
	const other = low ? highN : lowN;

	// Tree order can run against screen order (the left side of a balanced
	// map reads bottom to top), so the index comes from the neighbours.
	const i = parent.children.indexOf(target);
	let index: number;
	if (pointed) index = Math.max(i, parent.children.indexOf(pointed.n));
	else if (other) index = parent.children.indexOf(other.n) < i ? i + 1 : i;
	else index = low ? i : i + 1;

	let pos: number;
	if (pointed) {
		const [a, b] = low ? [pointed.b, tb] : [tb, pointed.b];
		pos = (start(a, axis) + size(a, axis) + start(b, axis)) / 2;
	} else {
		pos = low ? start(tb, axis) - LINE_OFFSET : start(tb, axis) + size(tb, axis) + LINE_OFFSET;
	}
	const line: Line =
		axis === "y"
			? { x1: tb.x, y1: pos, x2: tb.x + tb.w, y2: pos }
			: { x1: pos, y1: tb.y, x2: pos, y2: tb.y + tb.h };
	return { kind: index === i ? "before" : "after", target, parent, index, line };
}

function findParent(root: MindNode, target: MindNode): MindNode | null {
	for (const c of root.children) {
		if (c === target) return root;
		const found = findParent(c, target);
		if (found) return found;
	}
	return null;
}

// How fast to pan, per frame, when a drag nears the viewport edge. Positive
// dx moves the map right (revealing what's off the left edge).
export function edgePan(
	p: Point,
	view: { w: number; h: number },
	margin = 40,
	max = 14,
): { dx: number; dy: number } {
	const speed = (dist: number) => (dist >= margin ? 0 : max * Math.min(1, 1 - dist / margin));
	const dx = speed(p.x) - speed(view.w - p.x);
	const dy = speed(p.y) - speed(view.h - p.y);
	return { dx: dx + 0, dy: dy + 0 };
}

// ---- Animated relayout ------------------------------------------------------

export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export interface Frame {
	box: Box;
	opacity: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// One frame between two layouts, at progress t (0..1, already eased). Topics
// new to the layout grow out of a point at their nearest pre-existing
// ancestor's centre and fade in. Nodes and edges are both drawn from these
// boxes, so lines never disagree with the topics they join.
//
// only, when given, limits the glide to those topics; the rest are put
// straight at their final boxes (a large map animates just what's on screen).
export function interpolateLayout<T>(
	from: Map<T, Box>,
	to: Map<T, Box>,
	t: number,
	parentOf: (n: T) => T | null,
	only?: Set<T>,
): Map<T, Frame> {
	const out = new Map<T, Frame>();
	for (const [n, b] of to) {
		if (only && !only.has(n)) {
			out.set(n, { box: b, opacity: 1 });
			continue;
		}
		let a = from.get(n);
		let opacity = 1;
		if (!a) {
			let anc = parentOf(n);
			while (anc && !from.has(anc) && !to.has(anc)) anc = parentOf(anc);
			const ab = anc ? from.get(anc) ?? to.get(anc) : undefined;
			const cx = ab ? ab.x + ab.w / 2 : b.x + b.w / 2;
			const cy = ab ? ab.y + ab.h / 2 : b.y + b.h / 2;
			a = { ...b, x: cx, y: cy, w: 0, h: 0 };
			opacity = t;
		}
		out.set(n, {
			box: { ...b, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) },
			opacity,
		});
	}
	return out;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

// The part of the map the viewport shows, in map coordinates, grown by margin
// screen pixels on every side. tx, ty and scale are the canvas transform.
export function visibleMapRect(
	view: { w: number; h: number },
	tx: number,
	ty: number,
	scale: number,
	margin = 0,
): Rect {
	return {
		x: (-tx - margin) / scale,
		y: (-ty - margin) / scale,
		w: (view.w + 2 * margin) / scale,
		h: (view.h + 2 * margin) / scale,
	};
}

// Whether a box overlaps a rect (touching edges don't count).
export const meetsRect = (b: Rect, r: Rect) => b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;

// The topics worth animating between two layouts: those that start or end
// inside rect. Topics wholly off screen at both ends can jump, since nobody
// sees them move.
export function onScreenTopics<T>(from: Map<T, Box>, to: Map<T, Box>, rect: Rect): Set<T> {
	const out = new Set<T>();
	for (const [n, b] of to) {
		const a = from.get(n);
		if (meetsRect(b, rect) || (a && meetsRect(a, rect))) out.add(n);
	}
	return out;
}

// ---- Selection ----------------------------------------------------------------

// The primary topic is the focused one (arrow keys, editing, Tab); the set is
// everything selected and always contains the primary.
export interface Selection<T> {
	primary: T;
	set: Set<T>;
}

export const singleSelection = <T>(n: T): Selection<T> => ({ primary: n, set: new Set([n]) });

// Shift/Cmd/Ctrl-click: add a topic, or take it out. The last topic stays.
export function toggleSelection<T>(s: Selection<T>, n: T): Selection<T> {
	const set = new Set(s.set);
	if (!set.has(n)) {
		set.add(n);
		return { primary: n, set };
	}
	if (set.size === 1) return s;
	set.delete(n);
	return { primary: n === s.primary ? [...set][set.size - 1] : s.primary, set };
}

// Shift+arrow: keep the selection and move focus onto the next topic too.
export function extendSelection<T>(s: Selection<T>, n: T): Selection<T> {
	const set = new Set(s.set);
	set.delete(n); // re-add so the set keeps the order topics were picked in
	set.add(n);
	return { primary: n, set };
}

export const collapseSelection = <T>(s: Selection<T>): Selection<T> => singleSelection(s.primary);

// Drops topics that no longer exist or are hidden in a fold.
export function pruneSelection<T>(s: Selection<T>, alive: (n: T) => boolean, fallback: T): Selection<T> {
	const set = new Set([...s.set].filter(alive));
	if (set.size === 0) return singleSelection(fallback);
	return { primary: set.has(s.primary) ? s.primary : [...set][set.size - 1], set };
}
