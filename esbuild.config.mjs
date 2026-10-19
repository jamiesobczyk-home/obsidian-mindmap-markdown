import esbuild from "esbuild";
import { readdirSync } from "node:fs";

const mode = process.argv[2];

if (mode === "test") {
	// Tests cover the Obsidian-free modules only, bundled for Node's test runner.
	await esbuild.build({
		entryPoints: readdirSync("tests").filter((f) => f.endsWith(".test.ts")).map((f) => `tests/${f}`),
		bundle: true,
		platform: "node",
		format: "esm",
		outdir: ".test-build",
		outExtension: { ".js": ".mjs" },
		logLevel: "warning",
	});
} else {
	const prod = mode === "production";
	const ctx = await esbuild.context({
		entryPoints: ["src/main.ts"],
		bundle: true,
		external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
		format: "cjs",
		target: "es2020",
		sourcemap: prod ? false : "inline",
		treeShaking: true,
		minify: prod,
		outfile: "main.js",
		logLevel: "info",
	});
	if (prod) {
		await ctx.rebuild();
		await ctx.dispose();
	} else {
		await ctx.watch();
	}
}
