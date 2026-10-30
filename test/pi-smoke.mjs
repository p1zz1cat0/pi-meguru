// Run real Pi turns with a local fake model. No model API request is sent.
// Check: the runtime is injected, a break stops and the next call continues, the checkpoint
// tool is reachable from the script but not shown to the model, and the runtime text does not
// stay in the session file or in later model requests.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const piPackage = process.env.PI_PACKAGE_PATH ?? fileURLToPath(new URL("../../../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const url = (relative) => pathToFileURL(path.join(piPackage, relative)).href;
const { ModelRuntime, DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession, createCodemodeExtension } = await import(url("dist/index.js"));
const { AuthStorage } = await import(url("dist/core/auth-storage.js"));
const { createAssistantMessageEventStream } = await import(url("../pi-ai/dist/utils/event-stream.js"));

const SCRIPT = `
const r = await flow("smoke", {
  graph: { a: ["b"], b: [] },
  actions: { a: () => 41, b: ({ a }) => a + 1 },
  break: { b: true },
})
return { status: r.status, at: r.at, value: r.value }
`;

const root = await mkdtemp(path.join(tmpdir(), "pi-meguru-smoke-"));
let session;
try {
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: { mode: "off" } });
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: path.join(root, "agent"), settingsManager,
		noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [createCodemodeExtension({ models: false })],
		additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const manager = SessionManager.create(root, path.join(root, "sessions"));
	({ session } = await createAgentSession({
		cwd: root, agentDir: path.join(root, "agent"), settingsManager, sessionManager: manager, resourceLoader: loader,
		modelRuntime: await ModelRuntime.create({ refreshOnCreate: false, credentials: AuthStorage.inMemory({ openai: { type: "api_key", key: "local-test-only" } }), modelsPath: path.join(root, "models.json") }),
	}));
	const model = { id: "test", name: "Test", provider: "openai", api: "openai-responses", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 };
	session.agent.state.model = model;
	session.setActiveToolsByName([...session.agent.state.tools.map((t) => t.name), "codemode"]);

	let calls = 0;
	const requests = [];
	session.agent.streamFunction = (_model, context) => {
		requests.push(structuredClone(context.messages));
		calls++;
		// Turn 1: call 1 runs the script, call 2 ends. Turn 2: call 3 runs it again, call 4 ends.
		const tool = calls % 2 === 1 ? { name: "codemode", arguments: { code: SCRIPT } } : undefined;
		const message = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: tool ? [{ type: "toolCall", id: `tool-${calls}`, ...tool }] : [{ type: "text", text: "done" }],
			stopReason: tool ? "toolUse" : "stop", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason, message });
		stream.end(message);
		return stream;
	};

	const results = () => requests.at(-1).filter((m) => m.role === "toolResult" && m.toolName === "codemode").map((m) => JSON.stringify(m.content));

	await session.prompt("Run the flow.");
	assert.equal(calls, 2);
	assert.match(results()[0], /\\"status\\":\\"paused\\",\\"at\\":\\"b\\"/);

	await session.prompt("Continue.");
	assert.equal(calls, 4);
	assert.match(results()[1], /\\"status\\":\\"done\\",\\"at\\":\\"b\\",\\"value\\":42/);

	const file = await readFile(manager.getSessionFile(), "utf8");
	assert.match(file, /"customType":"meguru-state"/);
	const declared = session.agent.state.tools;
	assert.ok(declared.some((t) => t.name === "codemode"), "the model sees codemode");
	assert.ok(!declared.some((t) => t.name === "meguru_state"), "the checkpoint tool is not declared to the model");
	assert.ok(!declared.find((t) => t.name === "codemode").description.includes("meguru_state"), "codemode does not list the checkpoint tool");
	const leaks = {
		sessionFile: file.includes("__flow_run"),
		laterRequest: JSON.stringify(requests.at(-1)).includes("__flow_run"),
	};
	console.log("runtime text found in:", leaks);
	assert.deepEqual(leaks, { sessionFile: false, laterRequest: false });
	console.log("pi-meguru smoke ok");
} finally {
	await session?.dispose?.();
	await rm(root, { recursive: true, force: true });
}
