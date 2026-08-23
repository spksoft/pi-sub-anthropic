#!/usr/bin/env node
/**
 * Zero-install dev setup: point this project's `node_modules` at the
 * `node_modules` of an already-installed pi, so `@earendil-works/*` imports
 * resolve without downloading anything.
 *
 * This is a convenience for people who already run pi globally. The ordinary
 * path is plain `npm install`, which creates a real `node_modules` and is what
 * you want if you also intend to type-check (the compiler is a devDependency
 * and is NOT present in pi's tree).
 *
 *   npm run link:dev
 *   npm run link:dev -- /path/to/@earendil-works/pi-coding-agent
 *
 * The pi install is located at runtime — nothing about the author's machine,
 * home directory, node version or version manager is baked in.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PKG = "@earendil-works/pi-coding-agent";
const PROJECT = path.resolve(import.meta.dirname, "..");
const LINK = path.join(PROJECT, "node_modules");
const WINDOWS = process.platform === "win32";

/** True when `dir` is the root of the pi package itself. */
function isPiPackageDir(dir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === PKG;
	} catch {
		return false;
	}
}

/** Follow the `pi` executable on PATH back to the package that owns it. */
function fromPathLookup() {
	const exts = WINDOWS ? [".cmd", ".exe", ".ps1", ""] : [""];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const bin = path.join(dir, `pi${ext}`);
			let current;
			try {
				current = path.dirname(fs.realpathSync(bin));
			} catch {
				continue;
			}
			for (let previous = ""; current !== previous; previous = current, current = path.dirname(current)) {
				if (isPiPackageDir(current)) return current;
			}
		}
	}
	return undefined;
}

/** Whatever npm considers the global root for the node currently running. */
function fromNpmGlobalRoot() {
	try {
		const root = execFileSync("npm", ["root", "-g"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			shell: WINDOWS,
		}).trim();
		return root ? path.join(root, PKG) : undefined;
	} catch {
		return undefined;
	}
}

/** Default layout for a node installed under its own prefix. */
function fromNodePrefix() {
	return path.join(path.dirname(process.execPath), "..", "lib", "node_modules", PKG);
}

const piDir = [process.argv[2], fromPathLookup(), fromNpmGlobalRoot(), fromNodePrefix()]
	.filter(Boolean)
	.map((candidate) => path.resolve(candidate))
	.find(isPiPackageDir);

if (!piDir) {
	console.error(`link:dev: could not locate ${PKG}.`);
	console.error("  - install pi globally:  npm install -g " + PKG);
	console.error("  - or just run:          npm install");
	console.error(`  - or point at it:       npm run link:dev -- /path/to/${PKG}`);
	process.exit(1);
}

const target = path.join(piDir, "node_modules");
console.log(`link:dev: found pi at ${piDir}`);

if (!fs.existsSync(path.join(target, "@earendil-works", "pi-ai"))) {
	console.error(`link:dev: ${target} has no @earendil-works/pi-ai — that install looks incomplete.`);
	process.exit(1);
}

const existing = fs.lstatSync(LINK, { throwIfNoEntry: false });
if (existing) {
	const where = existing.isSymbolicLink() ? fs.readlinkSync(LINK) : "(real directory)";
	console.log(`link:dev: node_modules already exists -> ${where}; nothing to do.`);
	linkPiItself();
	process.exit(0);
}

fs.symlinkSync(target, LINK, WINDOWS ? "junction" : "dir");
console.log(`link:dev: node_modules -> ${target}`);
linkPiItself();

/**
 * pi's own `node_modules` contains its dependencies but not pi itself — a
 * package cannot contain itself. So `import type { ExtensionAPI } from
 * "@earendil-works/pi-coding-agent"` stays unresolvable, and `npm run typecheck`
 * reports TS2307 plus knock-on implicit-any errors.
 *
 * pi ships its own `dist/index.d.ts`, so linking the package directory into the
 * scope folder makes the type-only import resolve with no download. Runtime is
 * unaffected either way: pi injects these modules into extensions itself.
 */
function linkPiItself() {
	const scopeDir = path.join(LINK, "@earendil-works");
	const selfLink = path.join(scopeDir, "pi-coding-agent");
	if (fs.lstatSync(selfLink, { throwIfNoEntry: false })) {
		console.log("link:dev: pi types already resolvable; nothing to do.");
		return;
	}
	try {
		fs.symlinkSync(piDir, selfLink, WINDOWS ? "junction" : "dir");
		console.log(`link:dev: ${PKG} -> ${piDir} (enables npm run typecheck)`);
	} catch (error) {
		// pi's tree may be root-owned or read-only; typecheck simply keeps
		// reporting TS2307 in that case. Never fail the whole setup for it.
		console.warn(`link:dev: could not link ${PKG} types (${error.code ?? "error"}).`);
		console.warn("link:dev: runtime is unaffected; `npm install` also fixes typecheck.");
	}
}
