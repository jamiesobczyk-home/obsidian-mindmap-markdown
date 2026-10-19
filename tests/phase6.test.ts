import assert from "node:assert/strict";
import { test } from "node:test";
import { centralsOf, linksToRecords, parse, recordsToLinks, restore, serialize, snapshot } from "../src/model";
import { addSummary, move, removeAll, removeSummary } from "../src/ops";

// ---- Notes on topics ---------------------------------------------------------

const NOTES = `# House

The whole-house plan for 2027.

- Kitchen
	Budget is about $30k.

	Quotes due in March.
	- Fridge
		36-inch, French door.
- Garage

# Garden

Raised beds first.

- Beds
`;

test("indented lines under a bullet are that topic's note, and it round-trips", () => {
	const doc = parse(NOTES);
	assert.equal(doc.unsupported.length, 0);
	assert.equal(doc.root.note, "The whole-house plan for 2027.");
	const kitchen = doc.root.children[0];
	assert.equal(kitchen.note, "Budget is about $30k.\n\nQuotes due in March.");
	assert.equal(kitchen.children[0].note, "36-inch, French door.");
	assert.equal(doc.root.children[1].note, undefined);
	assert.equal(centralsOf(doc.root)[0].note, "Raised beds first.");
	assert.equal(serialize(doc), NOTES);
});

test("note lines keep their relative indentation", () => {
	const src = "# R\n\n- a\n\t```\n\tif x:\n\t    y()\n\t```\n";
	const doc = parse(src);
	assert.equal(doc.root.children[0].note, "```\nif x:\n    y()\n```");
	assert.equal(serialize(doc), src);
});

test("a new note is written indented under its topic, with paragraph breaks", () => {
	const doc = parse("# R\n\n- a\n\t- b\n");
	doc.root.children[0].children[0].note = "first\n\nsecond";
	doc.root.note = "about R";
	const out = serialize(doc);
	assert.equal(out, "# R\n\nabout R\n\n- a\n\t- b\n\t\tfirst\n\n\t\tsecond\n");
	assert.equal(parse(out).root.children[0].children[0].note, "first\n\nsecond");
});

test("note lines that would read as bullets, headings or settings are escaped", () => {
	const doc = parse("# R\n\n- a\n");
	doc.root.children[0].note = "- milk\n* eggs\n1. bread";
	doc.root.note = "# not a heading\n%% mindmap-settings";
	const out = serialize(doc);
	const again = parse(out);
	assert.equal(again.unsupported.length, 0);
	assert.equal(again.root.children.length, 1, "no stray topics");
	assert.equal(again.root.children[0].children.length, 0);
	assert.equal(serialize(again), out, "stable after the first save");
});

test("an unindented paragraph after the list still makes the note read-only", () => {
	assert.equal(parse("# R\n\n- a\n\nLoose text.\n").unsupported.length, 1);
});

test("notes survive undo snapshots and moves", () => {
	const doc = parse(NOTES);
	const copy = restore(snapshot(doc.root));
	assert.equal(copy.children[0].note, "Budget is about $30k.\n\nQuotes due in March.");
	const garage = doc.root.children[1];
	garage.note = "Two cars";
	move(doc.root, garage, doc.root.children[0], 0);
	assert.match(serialize(doc), /\t- Garage\n\t\tTwo cars\n/);
});

// ---- Boundaries --------------------------------------------------------------

test("boundaries are saved by path with an optional label and follow moves", () => {
	const src = '# R\n\n- a\n\t- a1\n- b\n\n%% mindmap-settings\n{"boundaries":{"0":"Phase one","1":""}}\n%%\n';
	const doc = parse(src);
	assert.equal(doc.root.children[0].boundary, "Phase one");
	assert.equal(doc.root.children[1].boundary, "");
	assert.equal(serialize(doc), src);
	move(doc.root, doc.root.children[1], doc.root, 0);
	assert.match(serialize(doc), /"boundaries":\{"0":"","1":"Phase one"\}/);
	delete doc.root.children[0].boundary;
	assert.match(serialize(doc), /"boundaries":\{"1":"Phase one"\}/);
	assert.equal(restore(snapshot(doc.root)).children[1].boundary, "Phase one");
});

// ---- Summary brackets --------------------------------------------------------

test("summaries span a run of siblings, round-trip, and follow their topics", () => {
	const src = '# R\n\n- a\n- b\n- c\n- d\n\n%% mindmap-settings\n{"summaries":[{"from":"1","to":"2","text":"Middle two"}]}\n%%\n';
	const doc = parse(src);
	assert.equal(doc.summaries.length, 1);
	const s = doc.summaries[0];
	assert.equal(s.from.text, "b");
	assert.equal(s.to.text, "c");
	assert.equal(s.text, "Middle two");
	assert.equal(serialize(doc), src);
	move(doc.root, doc.root.children[0], doc.root, 4);
	assert.match(serialize(doc), /"summaries":\[\{"from":"0","to":"1","text":"Middle two"\}\]/);
});

test("addSummary takes a run of siblings in order and refuses mixed parents", () => {
	const doc = parse("# R\n\n- a\n\t- a1\n- b\n- c\n");
	const [a, b, c] = doc.root.children;
	assert.equal(addSummary(doc, [c, a], "All"), true);
	assert.equal(doc.summaries[0].from, a);
	assert.equal(doc.summaries[0].to, c);
	assert.equal(addSummary(doc, [a.children[0], b], "x"), false);
	assert.equal(addSummary(doc, [doc.root], "x"), false);
	assert.equal(removeSummary(doc, doc.summaries[0]), true);
	assert.equal(doc.summaries.length, 0);
});

test("a summary whose ends are deleted or split apart stops being saved", () => {
	const doc = parse("# R\n\n- a\n- b\n- c\n");
	const [a, b, c] = doc.root.children;
	addSummary(doc, [a, c], "s");
	removeAll(doc.root, [c]);
	assert.doesNotMatch(serialize(doc), /summaries/);
	const doc2 = parse("# R\n\n- a\n- b\n- c\n");
	const [x, , z] = doc2.root.children;
	addSummary(doc2, [x, z], "s");
	move(doc2.root, z, doc2.root.children[1], 0);
	assert.doesNotMatch(serialize(doc2), /summaries/, "ends no longer share a parent");
	void b;
});

test("summaries that don't resolve are kept verbatim", () => {
	const src = '# R\n\n- a\n\n%% mindmap-settings\n{"summaries":[{"from":"4","to":"5","text":"gone"}]}\n%%\n';
	assert.equal(serialize(parse(src)), src);
});

test("link records still convert alongside the new fields", () => {
	const doc = parse(NOTES);
	assert.deepEqual(recordsToLinks(doc.root, linksToRecords(doc.root, doc.links)), []);
});

test("random maps with awkward notes save, reload and save again unchanged", async () => {
	const { newNode } = await import("../src/model");
	let seed = 42;
	const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
	const bits = ["- dash", "* star", "+ plus", "# hash", "%% mindmap-settings", "1. one", "  indented", "\tcode", "> quote", "[[Link]]", "plain words", "ends with #", "---"];
	const note = () => Array.from({ length: 1 + rnd(4) }, () => (rnd(5) === 0 ? "" : bits[rnd(bits.length)])).join("\n").replace(/^\n+|\n+$/g, "");
	for (let round = 0; round < 500; round++) {
		const doc = parse("# Root\n");
		const grow = (n: ReturnType<typeof newNode>, depth: number) => {
			const k = depth > 3 ? 0 : rnd(4);
			for (let i = 0; i < k; i++) {
				const c = newNode(`topic ${round}.${depth}.${i}`);
				if (rnd(2) === 0) {
					const t = note();
					if (t.trim()) c.note = t;
				}
				n.children.push(c);
				grow(c, depth + 1);
			}
		};
		grow(doc.root, 0);
		if (rnd(2) === 0) {
			const t = note();
			if (t.trim()) doc.root.note = t;
		}
		const once = serialize(doc);
		const back = parse(once);
		assert.equal(back.unsupported.length, 0, `round ${round} read-only:\n${once}`);
		const shape = (n: { text: string; children: { text: string; children: unknown[] }[] }): unknown => [n.text, n.children.map((c) => shape(c as never))];
		assert.deepEqual(shape(back.root as never), shape(doc.root as never), `round ${round} tree changed:\n${once}`);
		assert.equal(serialize(back), once, `round ${round} not stable`);
	}
});
