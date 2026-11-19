import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The draft is built by Jouzu's own reporter, so the app and the payload cannot drift apart. The
// module is the one the installed slot carries, found by what it exports rather than by a path a release
// may move; when no module is there, nothing is invented and the answer says so.

const [app, factsPath] = process.argv.slice(2);
if (!app || !factsPath) {
	console.error("usage: bug-report.mjs <app> <factsFile>");
	process.exit(2);
}
const facts = JSON.parse(readFileSync(factsPath, "utf8"));

/** The installed reporter, wherever this release keeps it. */
async function reporter() {
	const candidates = [
		join(app, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "interactive", "bug-report.js"),
	];
	const sources = join(app, "sources");
	if (existsSync(sources)) {
		for (const name of readdirSync(sources).filter((entry) => entry.includes("pi-coding-agent"))) {
			candidates.push(join(sources, name, "dist", "modes", "interactive", "bug-report.js"));
		}
	}
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		const module = await import(pathToFileURL(path).href);
		if (typeof module.buildBugReportDraft === "function") return module;
	}
	return null;
}

const reporter_ = await reporter();
if (!reporter_) {
	// A release whose reporter moved is reported as such, and the user still gets the form and the facts
	// the app collected; the app keeps no second description of the draft.
	console.log(JSON.stringify({ available: false, issueUrl: "https://github.com/shisa-ai/jouzu/issues/new", facts }));
} else {
	const draft = reporter_.buildBugReportDraft({
		description: facts.description ?? "",
		expected: facts.expected ?? "",
		actual: facts.actual ?? "",
		reproduction: facts.reproduction ?? "",
		runtimeIdentity: facts.runtimeIdentity ?? "",
	});
	console.log(JSON.stringify({ available: true, title: draft.title, body: draft.body, issueUrl: reporter_.ISSUE_NEW_URL, issuesUrl: reporter_.ISSUES_URL, facts }));
}
