import assert from "node:assert/strict";
import { test } from "node:test";
import { centralsOf, parse, serialize } from "../src/model";

const stable = (src: string) => {
	const doc = parse(src);
	assert.equal(doc.unsupported.length, 0, "editable");
	// An edit elsewhere forces a full rewrite; the fence must come back intact.
	doc.root.text = doc.root.text + "!";
	const out = serialize(doc);
	const again = parse(out);
	assert.equal(serialize(again), out, "stable");
	return { doc, out, again };
};

test("a fence in a topic's note keeps its bullets as code, not topics", () => {
	const src = "# R\n\n- A\n\t```yaml\n\t- x: 1\n\t# y\n\t```\n- B\n";
	const { doc, out } = stable(src);
	assert.equal(doc.root.children.length, 2);
	assert.equal(doc.root.children[0].children.length, 0);
	assert.equal(doc.root.children[0].note, "```yaml\n- x: 1\n# y\n```");
	assert.equal(out, "# R!\n\n- A\n\t```yaml\n\t- x: 1\n\t# y\n\t```\n- B\n", "no backslashes added inside the code");
});

test("a fence before the first bullet keeps # lines as code, not central topics", () => {
	const src = "# R\n\n```bash\n# comment\necho hi\n\n\nls\n```\n\n- a\n";
	const { doc, out } = stable(src);
	assert.equal(centralsOf(doc.root).length, 0);
	assert.equal(doc.root.note, "```bash\n# comment\necho hi\n\n\nls\n```");
	assert.ok(out.includes("echo hi\n\n\nls"), "blank lines inside code are kept");
});

test("~~~ and $$ blocks are protected the same way", () => {
	stable("# R\n\n- a\n\t~~~\n\t- not a topic\n\t~~~\n");
	const { doc } = stable("# R\n\n$$\n- x\n# y\n$$\n\n- a\n");
	assert.equal(doc.root.children.length, 1);
});

test("an unclosed fence makes the map read-only instead of swallowing the rest", () => {
	assert.ok(parse("# R\n\n- a\n\t```\n\t- b\n- c\n").unsupported.length > 0);
});

test("an Obsidian %% comment %% before the list stays hidden", () => {
	const { out } = stable("# R\n\n%% private %%\n\n- a\n");
	assert.ok(out.includes("\n%% private %%\n"), out);
	assert.ok(!out.includes("\\%%"));
});

test("a note line sitting between two levels can't be moved above children", () => {
	assert.ok(parse("# R\n\n- A\n\t\t- B\n\t  mid\n").unsupported.length > 0);
});

test("hard line breaks and runs of blank lines in notes are kept", () => {
	const src = "# R\n\n- a\n\tline one  \n\tline two\n\n\n\tafter two blanks\n";
	const doc = parse(src);
	assert.equal(doc.root.children[0].note, "line one  \nline two\n\n\nafter two blanks");
	doc.root.text = "R2";
	assert.equal(serialize(doc), src.replace("# R\n", "# R2\n"));
});
