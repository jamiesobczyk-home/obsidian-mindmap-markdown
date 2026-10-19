import assert from "node:assert/strict";
import { test } from "node:test";
import { stripMarkdown, toMarkdownOutline, toOPML, toSVG } from "../src/export";
import { layoutTree } from "../src/layout";
import { MindNode, parse } from "../src/model";

const MAP = `---
mindmap-plugin: basic
---

# Kitchen & 1 < 2 > 0 "remodel"

- Budget
	- Cabinets **$8k**
	- Counters
- Contractors
	- [[Smith Carpentry]]
	- [[People/Jo|Jo the electrician]]
- Timeline
	- See [plan](https://example.com/a?b=1&c=2)

%% mindmap-settings
{"collapsed":["2"]}
%%
`;

interface XmlEl {
	name: string;
	attrs: Record<string, string>;
	children: XmlEl[];
	text: string;
}

const decode = (s: string) => {
	assert.doesNotMatch(s, /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i, `bare & in ${s}`);
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&amp;/g, "&");
};

// A strict little XML reader: enough to prove the output is well formed
// (balanced tags, quoted attributes, no stray < or &) and to walk its tree.
function readXml(xml: string): XmlEl {
	const body = xml.replace(/^<\?xml[^?]*\?>\s*/, "");
	const top: XmlEl = { name: "#doc", attrs: {}, children: [], text: "" };
	const stack = [top];
	const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body))) {
		const [, close, name, attrSrc, selfClose, text, stray] = m;
		assert.equal(stray, undefined, `stray < at ${m.index}`);
		const cur = stack[stack.length - 1];
		if (text !== undefined) {
			cur.text += decode(text);
		} else if (close) {
			assert.equal(cur.name, name, `mismatched </${name}>`);
			stack.pop();
		} else {
			const attrs: Record<string, string> = {};
			for (const a of attrSrc.matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
			const el: XmlEl = { name, attrs, children: [], text: "" };
			cur.children.push(el);
			if (!selfClose) stack.push(el);
		}
	}
	assert.equal(stack.length, 1, "unclosed elements");
	assert.equal(top.children.length, 1, "exactly one document element");
	return top.children[0];
}

const find = (el: XmlEl, name: string): XmlEl[] =>
	el.children.flatMap((c) => (c.name === name ? [c, ...find(c, name)] : find(c, name)));

type Tree = { text: string; children: Tree[] };
const treeOf = (n: MindNode): Tree => ({ text: n.text, children: n.children.map(treeOf) });
const outlineTree = (el: XmlEl): Tree[] =>
	el.children.filter((c) => c.name === "outline").map((c) => ({ text: c.attrs.text, children: outlineTree(c) }));

test("OPML is well formed, nests the whole tree and escapes text", () => {
	const doc = parse(MAP);
	const xml = toOPML(doc);
	assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
	const opml = readXml(xml);
	assert.equal(opml.name, "opml");
	assert.equal(opml.attrs.version, "2.0");
	const title = find(opml, "title")[0];
	assert.equal(title.text, 'Kitchen & 1 < 2 > 0 "remodel"');
	const body = find(opml, "body")[0];
	// Folded branches are still part of the outline.
	assert.deepEqual(outlineTree(body), treeOf(doc.root).children);
	assert.match(xml, /&amp;/);
	assert.match(xml, /1 &lt; 2 &gt; 0/);
	assert.match(xml, /&quot;remodel&quot;/);
});

test("OPML drops characters XML 1.0 forbids", () => {
	const doc = parse("# R\n\n- a\u0001b\n");
	const opml = readXml(toOPML(doc));
	assert.equal(find(opml, "outline")[0].attrs.text, "ab");
});

test("the Markdown outline has no frontmatter or settings and round-trips the tree", () => {
	const doc = parse(MAP);
	const md = toMarkdownOutline(doc);
	assert.doesNotMatch(md, /mindmap-plugin|mindmap-settings|---|%%/);
	assert.match(md, /^# Kitchen & 1 < 2 > 0 "remodel"\n\n- Budget\n\t- Cabinets \*\*\$8k\*\*\n/);
	const back = parse(md);
	assert.equal(back.unsupported.length, 0);
	assert.deepEqual(treeOf(back.root), treeOf(doc.root));
	assert.equal(back.root.children[2].collapsed, false);
});

test("stripMarkdown turns inline Markdown into plain label text", () => {
	assert.equal(stripMarkdown("[[a|b]]"), "b");
	assert.equal(stripMarkdown("see [[Note#Part]]"), "see Note#Part");
	assert.equal(stripMarkdown("**bold** and __strong__"), "bold and strong");
	assert.equal(stripMarkdown("*em* and _em_"), "em and em");
	assert.equal(stripMarkdown("`code` ~~gone~~ ==mark=="), "code gone mark");
	assert.equal(stripMarkdown("[text](https://x.y/z?a=1)"), "text");
	assert.equal(stripMarkdown("snake_case_name stays"), "snake_case_name stays");
	assert.equal(stripMarkdown("2 * 3 * 4"), "2 * 3 * 4");
	assert.equal(stripMarkdown("a <b>bold</b> <br/> 1 < 2"), "a bold 1 < 2");
});

const size = (n: MindNode) => ({ w: 40 + n.text.length * 7, h: n.children.length ? 34 : 26 });

function svgFor(src: string, layout: "balanced" | "right" = "balanced") {
	const doc = parse(src);
	const boxes = layoutTree(doc.root, size, layout);
	const svg = toSVG(doc, boxes, { fontFamily: "Inter, sans-serif", fontSize: 16 });
	return { doc, boxes, svg, xml: readXml(svg) };
}

const labels = (xml: XmlEl) =>
	find(xml, "text")
		.filter((t) => t.attrs.class === "label")
		.map((t) => (t.children.length ? t.children.map((s) => s.text).join(" ") : t.text));

test("SVG draws one path per visible edge and one label per visible node", () => {
	const { boxes, xml } = svgFor(MAP);
	assert.equal(xml.name, "svg");
	assert.equal(xml.attrs.xmlns, "http://www.w3.org/2000/svg");
	// 9 topics with Timeline folded: 8 visible, 7 edges.
	assert.equal(boxes.size, 8);
	assert.equal(find(xml, "path").length, 7);
	assert.equal(labels(xml).length, 8);
});

test("SVG escapes text and strips Markdown from labels", () => {
	const { svg, xml } = svgFor(MAP);
	const ls = labels(xml);
	assert.ok(ls.includes('Kitchen & 1 < 2 > 0 "remodel"'), ls.join("|"));
	assert.ok(ls.includes("Smith Carpentry"));
	assert.ok(ls.includes("Jo the electrician"));
	assert.ok(ls.includes("Cabinets $8k"));
	assert.doesNotMatch(svg, /\[\[|\*\*|People\/Jo/);
});

test("SVG leaves out folded children and badges the fold with its count", () => {
	const { xml, svg } = svgFor(MAP);
	assert.ok(!labels(xml).some((l) => l.includes("plan")));
	assert.doesNotMatch(svg, /example\.com/);
	const badges = find(xml, "text").filter((t) => t.attrs.class === "badge");
	assert.deepEqual(
		badges.map((b) => b.text),
		["1"],
	);
});

test("SVG viewBox and background enclose every box with padding", () => {
	const { boxes, xml } = svgFor(MAP);
	const [vx, vy, vw, vh] = xml.attrs.viewBox.split(/\s+/).map(Number);
	for (const b of boxes.values()) {
		assert.ok(b.x > vx && b.y > vy, "box inside top-left");
		assert.ok(b.x + b.w < vx + vw && b.y + b.h < vy + vh, "box inside bottom-right");
	}
	assert.equal(Number(xml.attrs.width), vw);
	assert.equal(Number(xml.attrs.height), vh);
	const bg = find(xml, "rect")[0];
	assert.deepEqual([bg.attrs.x, bg.attrs.y, bg.attrs.width, bg.attrs.height].map(Number), [vx, vy, vw, vh]);
});

test("SVG edges follow the screen geometry and thin out with depth", () => {
	const { xml } = svgFor("# R\n\n- a\n\t- b\n\t\t- c\n", "right");
	const widths = find(xml, "path").map((p) => p.attrs["stroke-width"]);
	assert.deepEqual(widths, ["3", "2", "1.5"]);
	for (const p of find(xml, "path")) assert.match(p.attrs.d, /^M [-\d.]+ [-\d.]+ C /);
});

test("SVG uses the colours it is given", () => {
	const doc = parse("# R\n\n- a\n- b\n");
	const boxes = layoutTree(doc.root, size, "right");
	const svg = toSVG(doc, boxes, {
		background: "#101010",
		accent: "#abcdef",
		branchColors: ["#111111", "#999999"],
		nodeColors: new Map([[doc.root.children[1], "rgb(1, 2, 3)"]]),
	});
	assert.match(svg, /fill="#101010"/);
	assert.match(svg, /fill="#abcdef"/);
	assert.match(svg, /stroke="#111111"/);
	assert.match(svg, /stroke="rgb\(1, 2, 3\)"/);
	assert.doesNotMatch(svg, /#999999/);
});

test("SVG falls back to defaults for colours left unset", () => {
	const doc = parse("# R\n\n- a\n");
	const boxes = layoutTree(doc.root, size, "right");
	const svg = toSVG(doc, boxes, { background: undefined, accent: "", fontSize: undefined });
	assert.doesNotMatch(svg, /undefined|NaN|=""/);
});

test("SVG export draws relationship lines with their labels", async () => {
	const { parse } = await import("../src/model");
	const { layoutTree } = await import("../src/layout");
	const { toSVG } = await import("../src/export");
	const doc = parse(
		'# R\n\n- a\n\t- a1\n- b\n\n%% mindmap-settings\n{"links":[{"from":"0.0","to":"1","label":"x & y"}]}\n%%\n',
	);
	let svg = toSVG(doc, layoutTree(doc.root, () => ({ w: 80, h: 24 }), "balanced"));
	assert.equal((svg.match(/class="link"/g) ?? []).length, 1);
	assert.match(svg, />x &amp; y</);
	assert.match(svg, /<marker id="mm-arrow"/);
	doc.root.children[0].collapsed = true;
	svg = toSVG(doc, layoutTree(doc.root, () => ({ w: 80, h: 24 }), "balanced"));
	assert.equal((svg.match(/class="link"/g) ?? []).length, 1, "a folded end attaches to its fold");
});

test("SVG export embeds topic images where they sat on screen, and drops the embed text", async () => {
	const doc = parse("# R\n\n- Plan ![[Attachments/plan.png]]\n- Other\n");
	const boxes = layoutTree(doc.root, (n) => (n.text.includes("plan") ? { w: 200, h: 150 } : { w: 80, h: 24 }), "right");
	const plan = doc.root.children[0];
	const href = "data:image/png;base64,iVBORw0KGgo=";
	const svg = toSVG(doc, boxes, { images: new Map([[plan, [{ href, x: 8, y: 30, w: 180, h: 110 }]]]) });
	const b = boxes.get(plan)!;
	assert.match(svg, new RegExp(`<image href="${href.replace(/[+/=]/g, "\\$&")}" x="${b.x + 8}" y="${b.y + 30}" width="180" height="110"`));
	assert.match(svg, />Plan</);
	assert.doesNotMatch(svg, /plan\.png/);
	// Without image data the embed falls back to its name, as before.
	assert.match(toSVG(doc, boxes), /Attachments/);
});
