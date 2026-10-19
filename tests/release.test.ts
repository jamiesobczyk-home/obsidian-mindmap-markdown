// Release rules that the type checker can't see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

test("no regex lookbehind in the source: older iOS can't parse it, and the whole plugin would fail to load", () => {
	for (const f of readdirSync("src")) {
		const text = readFileSync(`src/${f}`, "utf8");
		assert.doesNotMatch(text, /\(\?<[=!]/, `src/${f}`);
	}
});

test("manifest: the version has a matching entry in versions.json", () => {
	const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
	const versions = JSON.parse(readFileSync("versions.json", "utf8"));
	assert.equal(versions[manifest.version], manifest.minAppVersion);
	assert.equal(JSON.parse(readFileSync("package.json", "utf8")).version, manifest.version);
});
