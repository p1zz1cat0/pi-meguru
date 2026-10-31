// pi-meguru: give codemode scripts ptc(), pause() and flow().
// 1. A tool_call hook appends the flow runtime and the saved records to a codemode script that calls flow().
// 2. A deferred tool saves the records. The runtime calls it after each node, so the records
//    stay when the script fails or times out later.
// The records are in memory only. They are cleared when the session or its branch changes.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { injectFlow, SAVE_TOOL_NAME } from "./inject.mjs";

type Calls = { calls?: { name?: string }[] } | undefined;

// Return the record without the save calls, or the same record when it has none.
function withoutSaves(record: Calls): Calls {
	if (!Array.isArray(record?.calls) || !record.calls.some((c) => c.name === SAVE_TOOL_NAME)) return record;
	return { ...record, calls: record.calls.filter((c) => c.name !== SAVE_TOOL_NAME) };
}

export default function (pi: ExtensionAPI) {
	// Flow name → records. One Pi process has one active session, so the flow name is the key.
	const saved = new Map<string, unknown[]>();
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
			at: Type.Integer({ minimum: 0 }),
			rec: Type.Optional(Type.Unknown()),
		}),
		exposure: "deferred",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params) {
			const list = (saved.get(params.name) ?? []).slice(0, params.at);
			if (params.rec !== undefined) list.push(params.rec);
			if (list.length) saved.set(params.name, list);
			else saved.delete(params.name);
			return { content: [{ type: "text", text: `${list.length} records` }], details: undefined };
		},
	});
}
