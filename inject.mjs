import { readFileSync } from "node:fs";

export const RUNTIME = readFileSync(new URL("./runtime.js", import.meta.url), "utf8");
export const SAVE_TOOL_NAME = "meguru_save";

const USES_FLOW = /\bflow\s*\(/;
const DECLARES_FLOW = /\b(?:function\s+flow|(?:const|let|var)\s+flow)\b/;

// Append the runtime and the saved records (flow name → records) to a codemode script that calls flow().
// Return the script unchanged when it does not call flow() or declares its own flow.
export function injectFlow(code, saved = {}) {
	if (typeof code !== "string" || !USES_FLOW.test(code) || DECLARES_FLOW.test(code)) return code;
	return `${code}\n;\n${RUNTIME}\nfunction __m_saved() { return ${JSON.stringify(saved)} }\n`;
}
