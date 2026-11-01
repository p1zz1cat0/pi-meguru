// pi-meguru: give codemode scripts ptc(), pause() and flow().
// 1. A tool_call hook appends the flow runtime and the saved records to a codemode script that calls flow().
// 2. A deferred tool saves the records. The runtime calls it after each node, so the records
//    stay when the script fails or times out later.
// The records are in memory only. They are cleared when the session or its branch changes.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { injectFlow, SAVE_TOOL_NAME } from "./inject.mjs";

type Calls = { calls?: { name?: string }[] } | undefined;

const FLOW_HINT = `Meguru — composable PTC workflows. Ordinary codemode scripts still work; no setup needed.

Records are in-memory only; cleared on completion, session changes, or tree navigation.

* ptc(name, fn) creates an async node that accepts JSON arguments and returns JSON. Nodes can batch, chain, and process tool calls, but cannot invoke nodes, groups, or pauses.
* flow(name, asyncFn, { watch?, fresh? }) composes nodes using ordinary async JavaScript: branches, loops, aggregation, retries, and fallbacks. Inside flows, tools must be called through nodes. Keep orchestration deterministic and side-effect-free; it reruns on continuation.
* group(name, fn) creates a nested flow with scoped identities. node.map(items, { key }) and group.map(items, { key }) execute sequentially, preserving input order. Unique stable keys preserve identity across reordering.
* await pause(name) pauses for model judgment. Resubmit the flow to continue. Completed nodes are reused when their identity, source, and JSON arguments match. Pass dependencies explicitly as arguments; closures and external state are not tracked. Use a new pause name for another review, or fresh: true to restart. Rethrow isFlowStop(error) before handling other errors.
* watch: { key: n => expr } tracks outputs without stopping (n.name, n.all.name). Expressions must be synchronous and side-effect-free.

flow() returns { status, at, reason, trace, value?, error? } with status done, paused, or error. It prints nothing; return a concise result preserving pause/error details. Keep node outputs bounded.`;

// Return the record without the save calls, or the same record when it has none.
function withoutSaves(record: Calls): Calls {
	if (!Array.isArray(record?.calls) || !record.calls.some((c) => c.name === SAVE_TOOL_NAME)) return record;
	return { ...record, calls: record.calls.filter((c) => c.name !== SAVE_TOOL_NAME) };
}

export default function (pi: ExtensionAPI) {
	pi.on("context_with_system", (event) => ({
		messages: event.messages.map((message) => message.role === "system" && message.toolsAdded
			? { ...message, toolsAdded: message.toolsAdded.map((tool) => tool.name === "codemode" && !tool.description.includes(FLOW_HINT)
				? { ...tool, description: `${FLOW_HINT}\n\n${tool.description}` }
				: tool) }
			: message),
	}));

	// Flow name → records. One Pi process has one active session, so the flow name is the key.
	const saved = new Map<string, Record<string, unknown>>();
	const clear = () => saved.clear();
	pi.on("session_start", clear);
	pi.on("session_tree", clear);

	pi.on("tool_call", (event) => {
		if (event.toolName !== "codemode") return;
		const input = event.input as { code?: unknown };
		if (typeof input.code === "string") input.code = injectFlow(input.code, Object.fromEntries(saved));
	});

	// The codemode result message keeps the arguments of each tool call twice: in details.calls
	// (codemode) and in nestedCalls.calls (Pi). Remove the save calls before the message goes
	// into the session file, so the records stay in memory only.
	pi.on("message_end", (event) => {
		const m = event.message as { role: string; toolName?: string; details?: Calls; nestedCalls?: Calls };
		if (m.role !== "toolResult" || m.toolName !== "codemode") return;
		const details = withoutSaves(m.details), nestedCalls = withoutSaves(m.nestedCalls);
		if (details === m.details && nestedCalls === m.nestedCalls) return;
		return { message: { ...m, details, nestedCalls } as typeof event.message };
	});

	pi.registerTool({
		name: SAVE_TOOL_NAME,
		label: SAVE_TOOL_NAME,
		description: "Internal checkpoint storage for the pi-meguru flow runtime. Do not call it yourself.",
		parameters: Type.Object({
			name: Type.String(),
			at: Type.Optional(Type.String()),
			rec: Type.Optional(Type.Unknown()),
		}),
		exposure: "deferred",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params) {
			if (params.at === undefined) saved.delete(params.name);
			else {
				const records = saved.get(params.name) ?? Object.create(null);
				if (params.rec === undefined) delete records[params.at];
				else records[params.at] = params.rec;
				if (Object.keys(records).length) saved.set(params.name, records);
				else saved.delete(params.name);
			}
			return { content: [{ type: "text", text: "saved" }], details: undefined };
		},
	});
}
