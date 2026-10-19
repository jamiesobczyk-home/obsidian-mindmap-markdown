// Launches the real Obsidian app on a throwaway vault, for tests/real and
// tests/perf. Linux only (it runs Obsidian's Linux build, under xvfb-run when
// there is no display). It downloads a pinned Obsidian once into
// OBSIDIAN_CACHE (default: <tmp>/obsidian-real-test), builds a vault holding
// just this plugin and the files given, and uses its own Obsidian settings
// folder, so it never touches a real vault or a real Obsidian profile.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "1.14.4";
export const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// files: vault-relative path -> string or Buffer. build: the folder whose
// main.js, manifest.json and styles.css are installed (this plugin's own by
// default).
export async function launchObsidian({ files = {}, screen = "1400x900", build = plugin } = {}) {
	const PORT = 9300 + Math.floor(Math.random() * 600);

	// --- Obsidian itself, downloaded once ---------------------------------------
	const cache = process.env.OBSIDIAN_CACHE ?? join(tmpdir(), "obsidian-real-test");
	const appDir = join(cache, `obsidian-${VERSION}`);
	const binary = join(appDir, "obsidian");
	if (!existsSync(binary)) {
		mkdirSync(cache, { recursive: true });
		const tarball = join(cache, `obsidian-${VERSION}.tar.gz`);
		const url = `https://github.com/obsidianmd/obsidian-releases/releases/download/v${VERSION}/obsidian-${VERSION}.tar.gz`;
		console.log(`downloading Obsidian ${VERSION} (about 130 MB, once)…`);
		// curl rather than fetch: it honours the HTTPS proxy settings fetch ignores.
		execFileSync("curl", ["-sSL", "--fail", "-o", tarball, url], { stdio: "inherit" });
		execFileSync("tar", ["xzf", tarball, "-C", cache]);
	}

	// --- A throwaway vault and settings folder -----------------------------------
	const work = mkdtempSync(join(tmpdir(), "mindmap-real-"));
	const vault = join(work, "vault");
	const profile = join(work, "profile");
	const installed = join(vault, ".obsidian", "plugins", "mindmap-markdown");
	mkdirSync(installed, { recursive: true });
	mkdirSync(profile, { recursive: true });
	for (const f of ["main.js", "manifest.json", "styles.css"]) cpSync(join(build, f), join(installed, f));
	writeFileSync(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["mindmap-markdown"]));
	for (const [p, content] of Object.entries(files)) {
		mkdirSync(dirname(join(vault, p)), { recursive: true });
		writeFileSync(join(vault, p), content);
	}
	writeFileSync(
		join(profile, "obsidian.json"),
		JSON.stringify({ vaults: { realtest: { path: vault, ts: Date.now(), open: true } }, updateDisabled: true }),
	);

	// --- Launch -------------------------------------------------------------------
	const args = ["--no-sandbox", "--disable-gpu", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`];
	const child = process.env.DISPLAY
		? spawn(binary, args, { detached: true, stdio: "ignore" })
		: spawn("xvfb-run", ["-a", "-s", `-screen 0 ${screen}x24`, binary, ...args], { detached: true, stdio: "ignore" });
	const stop = () => {
		process.off("exit", stop);
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			// Already gone.
		}
	};
	process.on("exit", stop);

	const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright").catch(
		() => import("/opt/node-tools/node_modules/playwright/index.mjs"),
	);
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	let browser;
	for (let i = 0; i < 60 && !browser; i++) {
		browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
		if (!browser) await sleep(500);
	}
	if (!browser) return { browser: null, page: null, stop, vault, work };
	let page;
	for (let i = 0; i < 60 && !page; i++) {
		page = browser.contexts()[0]?.pages().find((p) => p.url().includes("index.html"));
		if (!page) await sleep(500);
	}
	await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 30000 });
	return { browser, page, stop, vault, work };
}
