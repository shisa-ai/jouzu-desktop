import { packageRootFromConsumer } from "./package-root.mjs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export function assertFlowAgent(agent) {
	if (typeof agent?.inspectQueuedMessages !== "function") {
		throw new Error("Starter contains unpatched Pi agent-core: flow queue checkpoints are missing");
	}
}

export async function verifyRuntime(app) {
	const coding = packageRootFromConsumer(join(resolve(app), "node_modules", "jouzu"), "@earendil-works/pi-coding-agent");
    const core = packageRootFromConsumer(coding, "@earendil-works/pi-agent-core");
    const { Agent } = await import(pathToFileURL(join(core, "dist", "index.js")));
    assertFlowAgent(new Agent({ streamFn: () => { throw new Error("Verification must not call a provider"); } }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await verifyRuntime(process.argv[2]);
	console.log("Starter flow runtime contract verified");
}
