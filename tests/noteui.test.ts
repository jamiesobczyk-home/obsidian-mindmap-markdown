import assert from "node:assert/strict";
import { test } from "node:test";
import { appendToTopic, imageEmbed, isImageFile, normaliseNote, placePopover } from "../src/note-helpers";
import { outlineKey, outlineRows, plainTopicText } from "../src/outline-rows";
import { toSVG } from "../src/export";
import { MindNode, parse } from "../src/model";
import type { Box } from "../src/layout";

test("image files are recognised by extension, in any case, with or without a path", () => {
	for (const p of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.svg", "g.bmp", "h.avif", "dir/x y.PNG", "png", ".webp"]) {
		assert.ok(isImageFile(p), p);
	}
	for (const p of ["a.md", "b.pdf", "c.png.md", "d.mp4", "pngs/readme", "", "notes.canvas"]) {
		assert.ok(!isImageFile(p), p);
	}
});

test("a picked image becomes an embed at the end of the topic's text", () => {
	assert.equal(imageEmbed("Attachments/plan.png"), "![[Attachments/plan.png]]");
	assert.equal(appendToTopic("Kitchen", "![[plan.png]]"), "Kitchen ![[plan.png]]");
	assert.equal(appendToTopic("Kitchen  ", "![[plan.png]]"), "Kitchen ![[plan.png]]");
	assert.equal(appendToTopic("", "![[plan.png]]"), "![[plan.png]]");
	assert.equal(appendToTopic("   ", "![[plan.png]]"), "![[plan.png]]");
});

test("typed notes are tidied: CRLF, trailing spaces and outer blank lines go, the rest stays", () => {
	assert.equal(normaliseNote("  \n\nFirst line  \r\n\r\n    indented\tcode\n\n"), "First line\n\n    indented\tcode");
	assert.equal(normaliseNote("- a list\n- in a note"), "- a list\n- in a note");
	assert.equal(normaliseNote(""), null);
	assert.equal(normaliseNote(" \n\t\n  "), null);
});

test("the popover goes below the topic, above when there's no room, and stays inside the view", () => {
	const area = { left: 0, top: 0, width: 800, height: 600 };
	const size = { width: 300, height: 200 };
	assert.deepEqual(placePopover({ left: 100, top: 100, width: 80, height: 30 }, size, area), { left: 100, top: 138 });
	assert.deepEqual(placePopover({ left: 100, top: 500, width: 80, height: 30 }, size, area), { left: 100, top: 292 });
	// Too near the right edge: pulled back in.
	assert.equal(placePopover({ left: 700, top: 100, width: 80, height: 30 }, size, area).left, 492);
	// Off the left of the view (the map is panned): pulled in too.
	assert.equal(placePopover({ left: -50, top: 100, width: 80, height: 30 }, size, area).left, 8);
	// Taller than either side: clamped to the area.
	const tall = placePopover({ left: 10, top: 290, width: 80, height: 30 }, { width: 300, height: 900 }, area);
	assert.equal(tall.top, 8);
});

test("the outline redraws when a topic gains or loses a note", () => {
	const doc = parse("# A\n\n- x\n");
	const before = outlineKey(outlineRows(doc.root), "");
	doc.root.children[0].note = "hello";
	const withNote = outlineKey(outlineRows(doc.root), "");
	assert.notEqual(withNote, before);
	doc.root.children[0].note = "hello, edited";
	assert.equal(outlineKey(outlineRows(doc.root), ""), withNote, "the note's text isn't shown, so editing it doesn't redraw");
});

test("outline rows leave embedded images out of a topic's words, or name the image if that's all it is", () => {
	assert.equal(plainTopicText("Appliances ![[plan.png]]"), "Appliances");
	assert.equal(plainTopicText("![[Attachments/plan.png]]"), "plan.png");
	assert.equal(plainTopicText("![[a.png|200]] and ![[b.png]] **bold**"), "and bold");
	assert.equal(plainTopicText("See [[Smith]]"), "See Smith");
});

test("SVG export marks a topic with a note with a small glyph", () => {
	const doc = parse("# A\n\n- x\n\tNote text\n- y\n");
	const [x, y] = doc.root.children;
	const box = (bx: number, by: number): Box => ({ x: bx, y: by, w: 80, h: 28, side: "right", branch: 0 });
	const boxes = new Map<MindNode, Box>([
		[doc.root, { x: 0, y: 0, w: 60, h: 40, side: "root", branch: -1 }],
		[x, box(100, -20)],
		[y, box(100, 30)],
	]);
	const svg = toSVG(doc, boxes);
	assert.equal(svg.match(/class="note-glyph"/g)?.length, 1);
	assert.doesNotMatch(svg, /Note text/, "the note's text isn't drawn");
});
