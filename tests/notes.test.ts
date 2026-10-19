import assert from "node:assert/strict";
import { test } from "node:test";
import { headingsToMap, linkedNote, noteNameFor } from "../src/notes";
import { centralsOf, parse } from "../src/model";

const map = (...a: Parameters<typeof headingsToMap>) => headingsToMap(...a)!;

const NOTE = `---
tags: [house]
---

# Kitchen remodel

Some intro text.

## Budget

### Cabinets
Body.

\`\`\`
# not a heading inside code
\`\`\`

## Contractors
#### Skipped a level
## Timeline ##
`;

test("headings become a map whose topics link back to their sections", () => {
	const out = map(NOTE, "Kitchen remodel", "Kitchen remodel");
	const doc = parse(out);
	assert.equal(doc.unsupported.length, 0);
	assert.match(out, /^---\nmindmap-plugin: basic\n---\n/);
	assert.equal(doc.root.text, "[[Kitchen remodel#Kitchen remodel|Kitchen remodel]]");
	assert.deepEqual(
		doc.root.children.map((c) => c.text),
		[
			"[[Kitchen remodel#Budget|Budget]]",
			"[[Kitchen remodel#Contractors|Contractors]]",
			"[[Kitchen remodel#Timeline|Timeline]]",
		],
	);
	assert.equal(doc.root.children[0].children[0].text, "[[Kitchen remodel#Cabinets|Cabinets]]");
	assert.equal(doc.root.children[1].children[0].text, "[[Kitchen remodel#Skipped a level|Skipped a level]]", "a skipped level nests under the nearest shallower heading");
	assert.doesNotMatch(out, /not a heading/, "headings inside code blocks are ignored");
});

test("several level-1 headings become several central topics", () => {
	const doc = parse(map("# A\n## a1\n# B\n## b1\n", "Note", "Note"));
	assert.equal(doc.root.text, "[[Note#A|A]]");
	assert.deepEqual(centralsOf(doc.root).map((c) => c.text), ["[[Note#B|B]]"]);
	assert.equal(centralsOf(doc.root)[0].children[0].text, "[[Note#b1|b1]]");
});

test("with no level-1 heading the note's name is the centre", () => {
	const doc = parse(map("## One\n## Two\n### Two a\n", "Ideas", "Folder/Ideas"));
	assert.equal(doc.root.text, "[[Folder/Ideas|Ideas]]");
	assert.deepEqual(doc.root.children.map((c) => c.text), ["[[Folder/Ideas#One|One]]", "[[Folder/Ideas#Two|Two]]"]);
});

test("headings that can't be linked safely stay plain text", () => {
	const doc = parse(map("# R\n## Q&A [draft]\n## Use | pipes\n## C# notes\n", "N", "N"));
	assert.deepEqual(doc.root.children.map((c) => c.text), ["Q&A [draft]", "Use | pipes", "C# notes"]);
});

test("a note with no headings gives null", () => {
	assert.equal(headingsToMap("Just text.\n", "N", "N"), null);
	assert.equal(headingsToMap("```\n# code\n```\n", "N", "N"), null);
});

test("noteNameFor strips what a file name or link can't hold", () => {
	assert.equal(noteNameFor("**New fridge**: 36\" / French door?"), "New fridge 36 French door");
	assert.equal(noteNameFor("[[Already linked|Shown]] plus"), "Shown plus");
	assert.equal(noteNameFor("   "), "Untitled topic");
	assert.equal(noteNameFor("x".repeat(200)).length, 100);
});

test("linkedNote spots a topic that is just one wiki-link", () => {
	assert.equal(linkedNote("[[Smith Carpentry]]"), "Smith Carpentry");
	assert.equal(linkedNote("[[Folder/Note#Part|Shown]]"), "Folder/Note#Part");
	assert.equal(linkedNote("Call [[Smith Carpentry]] Monday"), null);
	assert.equal(linkedNote("plain"), null);
});

test("note names never start with a dot or use a name Windows reserves", () => {
	assert.equal(noteNameFor(".env"), "env");
	assert.equal(noteNameFor("...later"), "later");
	assert.equal(noteNameFor("Con"), "Con_");
	assert.equal(noteNameFor("lpt1"), "lpt1_");
	assert.equal(noteNameFor("Console"), "Console");
	assert.equal(noteNameFor("..."), "Untitled topic");
});

test("headings inside %% comments and $$ math blocks are skipped", () => {
	const doc = parse(map("# R\n%%\n# hidden\n%%\n$$\n# maths\n$$\n## Shown\n", "N", "N"));
	assert.deepEqual(doc.root.children.map((c) => c.text), ["[[N#Shown|Shown]]"]);
});
