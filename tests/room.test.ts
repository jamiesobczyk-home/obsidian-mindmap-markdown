import assert from "node:assert/strict";
import { test } from "node:test";
import { decorations, layoutTree } from "../src/layout";
import { LAYOUTS, parse } from "../src/model";

const MAP = `# R

- a
	- a1
	- a2
- b
	- b1
- c
- d
	- d1

%% mindmap-settings
{"boundaries":{"1":"Middle label","2":"Third","3.0":"inner"}}
%%
`;

const overlaps = (r: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
	r.x < b.x + b.w && b.x < r.x + r.w && r.y < b.y + b.h && b.y < r.y + r.h;

for (const layout of LAYOUTS) {
	test(`${layout}: a boundary never overlaps a topic outside its branch`, () => {
		const doc = parse(MAP);
		const boxes = layoutTree(doc.root, (n) => ({ w: 60 + n.text.length * 6, h: 26 }), layout);
		const { boundaries } = decorations(doc.root, doc.root, boxes, doc.summaries);
		assert.ok(boundaries.length >= 2);
		const inBranch = (top: typeof doc.root) => {
			const s = new Set([top]);
			const add = (n: typeof doc.root): void => n.children.forEach((c) => (s.add(c), add(c)));
			add(top);
			return s;
		};
		for (const r of boundaries) {
			const mine = inBranch(r.node);
			for (const [n, b] of boxes) {
				if (mine.has(n)) continue;
				// The parent's own box may touch the edge leading into the branch.
				assert.ok(!overlaps(r, b), `${layout}: boundary of ${r.node.text} overlaps ${n.text}`);
			}
		}
	});
}

test("spacing scales the gaps between topics", () => {
	const doc = parse("# R\n\n- a\n- b\n");
	const size = () => ({ w: 80, h: 26 });
	const normal = layoutTree(doc.root, size, "right");
	const roomy = layoutTree(doc.root, size, "right", { spacing: 1.5 });
	const gap = (m: typeof normal) => m.get(doc.root.children[1])!.y - (m.get(doc.root.children[0])!.y + 26);
	const reach = (m: typeof normal) => m.get(doc.root.children[0])!.x;
	assert.ok(gap(roomy) > gap(normal));
	assert.ok(reach(roomy) > reach(normal));
});
