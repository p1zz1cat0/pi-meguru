// pi-meguru: give codemode scripts a flow() function.
// 1. A tool_call hook appends the flow runtime to a codemode script that calls flow().
// 2. A deferred tool keeps the flow checkpoints. The runtime calls it from the script.
//    Each call appends events to the session branch, so a checkpoint follows the branch
//    and stays when the script fails or times out later.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { injectFlow, STATE_ENTRY_TYPE, STATE_TOOL_NAME } from "./inject.mjs";

type StateEntry = { name: string; events: unknown[] };
// Same shape as JsonValue in pi-ai, which pi-coding-agent does not export.
// The events come from JSON tool arguments, so they are JSON.
type Json = null | boolean | number | string | readonly Json[] | { [key: string]: Json };

function isStateEntry(data: unknown): data is StateEntry {
	const d = data as StateEntry | null;
	return typeof d === "object" && d !== null && typeof d.name === "string" && Array.isArray(d.events);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "codemode") return;
		const input = event.input as { code?: unknown };
		if (typeof input.code === "string") input.code = injectFlow(input.code);
	});

	pi.registerTool({
		name: STATE_TOOL_NAME,
		label: STATE_TOOL_NAME,
		description: "Internal checkpoint storage for the pi-meguru flow runtime. Do not call it yourself.",
		parameters: Type.Object({
			op: Type.Union([Type.Literal("load"), Type.Literal("append")]),
			name: Type.String(),
			events: Type.Optional(Type.Array(Type.Unknown())),
		}),
		outputSchema: Type.Object({ events: Type.Array(Type.Unknown()) }),
		exposure: "deferred",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let events: unknown[] = [];
			if (params.op === "append") {
				if (params.events?.length) pi.appendEntry(STATE_ENTRY_TYPE, { name: params.name, events: params.events });
			} else {
				for (const entry of ctx.sessionManager.getBranch()) {
					if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE || !isStateEntry(entry.data)) continue;
					if (entry.data.name === params.name) events = events.concat(entry.data.events);
				}
			}
			return { content: [{ type: "text", text: `${events.length} events` }], structuredContent: { events: events as Json[] }, details: undefined };
		},
	});
}
