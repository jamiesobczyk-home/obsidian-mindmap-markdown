// Generates a realistic large map note: a few wide top-level branches, depth
// 3-6, topic texts of varied length (some with Markdown), some notes, and a
// few relationship lines, boundaries and summaries. Deterministic for a seed,
// so runs are comparable.

const WORDS = (
	"plan budget kitchen garden timeline review draft supplier contract quote design meeting notes " +
	"research launch market team hiring onboarding roadmap risk scope estimate testing release " +
	"feedback survey interview report metrics goal idea question decision follow-up invoice " +
	"permit inspection electrics plumbing tiles paint flooring windows doors lighting heating"
).split(" ");

function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function generateMap(count, seed = 7) {
	const r = rng(seed + count);
	const pick = (a) => a[Math.floor(r() * a.length)];
	const text = () => {
		const n = r() < 0.6 ? 1 + Math.floor(r() * 3) : 3 + Math.floor(r() * 10);
		const words = Array.from({ length: n }, () => pick(WORDS));
		words[0] = words[0][0].toUpperCase() + words[0].slice(1);
		let t = words.join(" ");
		const k = r();
		if (k < 0.04) t = `**${t}**`;
		else if (k < 0.07) t = `${t} [[${pick(WORDS)}]]`;
		else if (k < 0.09) t = `${t} \`${pick(WORDS)}\``;
		return t;
	};
	// Breadth-first, so the tree is bushy near the top and deep enough below.
	const root = { text: "Central topic", children: [], depth: 0 };
	const all = [root];
	const queue = [root];
	let made = 1;
	while (made < count && queue.length) {
		const p = queue.shift();
		const kids = p.depth === 0 ? 8 : 2 + Math.floor(r() * 5);
		for (let i = 0; i < kids && made < count; i++) {
			const c = { text: text(), children: [], depth: p.depth + 1 };
			if (r() < 0.05) c.note = `${text()}.\n\n${text()} and ${text().toLowerCase()}.`;
			p.children.push(c);
			all.push(c);
			made++;
			if (c.depth < 6) queue.push(c);
		}
	}
	const lines = ["---", "mindmap-plugin: basic", "---", "", `# ${root.text}`, ""];
	const paths = new Map();
	const walk = (n, depth, path) => {
		n.children.forEach((c, i) => {
			const p = path ? `${path}.${i}` : String(i);
			paths.set(c, p);
			lines.push(`${"\t".repeat(depth)}- ${c.text}`);
			if (c.note) for (const l of c.note.split("\n")) lines.push(l ? `${"\t".repeat(depth + 1)}${l}` : "");
			walk(c, depth + 1, p);
		});
	};
	walk(root, 0, "");
	lines.push("");
	const nodes = all.slice(1);
	const withKids = nodes.filter((n) => n.children.length >= 3);
	const links = [];
	for (let i = 0; i < 6; i++) {
		const a = pick(nodes);
		const b = pick(nodes);
		if (a !== b) links.push({ from: paths.get(a), to: paths.get(b) });
	}
	const boundaries = {};
	for (let i = 0; i < 4; i++) {
		const n = pick(withKids);
		boundaries[paths.get(n)] = i % 2 ? "" : pick(WORDS);
	}
	const summaries = [];
	for (let i = 0; i < 3; i++) {
		const p = pick(withKids);
		summaries.push({ from: paths.get(p.children[0]), to: paths.get(p.children[1]), text: pick(WORDS) });
	}
	lines.push("%% mindmap-settings", JSON.stringify({ boundaries, summaries, links }), "%%", "");
	// The biggest top-level branch, for fold timing.
	let big = 0;
	const size = (n) => n.children.reduce((s, c) => s + 1 + size(c), 0);
	root.children.forEach((c, i) => {
		if (size(c) > size(root.children[big])) big = i;
	});
	const maxDepth = Math.max(...all.map((n) => n.depth));
	return { markdown: lines.join("\n"), topics: all.length, maxDepth, bigBranch: big, bigBranchText: root.children[big].text };
}
