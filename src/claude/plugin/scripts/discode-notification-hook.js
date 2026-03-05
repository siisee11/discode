#!/usr/bin/env node
var { asObject, extractToolUseBlocks, formatPromptText, parseLineJson, readTail, readStdin, postToBridge } = require("./discode-hook-lib.js");


function extractPromptQuestions(toolUseBlocks) {
  const questions = [];
  for (const block of toolUseBlocks) {
    if (block.name !== "AskUserQuestion") continue;
    const input = block.input || {};
    const qs = Array.isArray(input.questions) ? input.questions : [];
    for (const q of qs) {
      const qObj = asObject(q);
      if (!qObj) continue;
      const question = typeof qObj.question === "string" ? qObj.question : "";
      if (!question) continue;
      const header = typeof qObj.header === "string" ? qObj.header : undefined;
      const multiSelect = qObj.multiSelect === true;
      const options = (Array.isArray(qObj.options) ? qObj.options : [])
        .map(function (opt) {
          const optObj = asObject(opt);
          if (!optObj) return null;
          const label = typeof optObj.label === "string" ? optObj.label : "";
          if (!label) return null;
          const description = typeof optObj.description === "string" ? optObj.description : undefined;
          return description ? { label: label, description: description } : { label: label };
        })
        .filter(Boolean);
      if (options.length === 0) continue;
      var entry = { question: question, options: options };
      if (header) entry.header = header;
      if (multiSelect) entry.multiSelect = true;
      questions.push(entry);
    }
  }
  return questions;
}

/**
 * Extract promptText, promptQuestions, and planFilePath from the transcript tail.
 * Scans backwards from the end, collecting tool_use blocks from assistant
 * entries until a real user message (with text content) is reached.
 */
function extractFromTranscript(transcriptPath) {
  if (!transcriptPath) return { promptText: "", promptQuestions: [], planFilePath: "" };

  const tail = readTail(transcriptPath, 65536);
  if (!tail) return { promptText: "", promptQuestions: [], planFilePath: "" };

  const lines = tail.split("\n");
  const allToolUseBlocks = [];
  const allTextParts = [];

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const entry = parseLineJson(line);
    if (!entry) continue;

    const obj = asObject(entry);
    if (!obj) continue;

    // Stop at real user messages (with text content, not tool_result)
    if (obj.type === "user") {
      const message = asObject(obj.message) || obj;
      const content = Array.isArray(message.content) ? message.content : [];
      const hasUserText = content.some((c) => {
        const co = asObject(c);
        return co && co.type === "text";
      });
      if (hasUserText) break;
      continue;
    }

    if (obj.type !== "assistant") continue;

    const message = asObject(obj.message) || obj;
    const toolUse = extractToolUseBlocks(message.content);
    if (toolUse.length > 0) {
      allToolUseBlocks.push(...toolUse);
    }
    // Collect text for plan file path extraction
    const content = Array.isArray(message.content) ? message.content : [];
    for (const c of content) {
      const co = asObject(c);
      if (co && co.type === "text" && typeof co.text === "string") {
        allTextParts.push(co.text);
      }
    }
  }

  allToolUseBlocks.reverse();
  allTextParts.reverse();

  // Extract plan file path when ExitPlanMode is present.
  // Strategy: find the most recent Write tool call targeting a .claude/plans/ path.
  var planFilePath = "";
  var hasExitPlanMode = allToolUseBlocks.some(function (b) { return b.name === "ExitPlanMode"; });
  if (hasExitPlanMode) {
    for (var bi = allToolUseBlocks.length - 1; bi >= 0; bi--) {
      var block = allToolUseBlocks[bi];
      if (block.name === "Write" && typeof (block.input || {}).file_path === "string") {
        var fp = block.input.file_path;
        if (fp.includes(".claude/plans/") && fp.endsWith(".md")) {
          planFilePath = fp;
          break;
        }
      }
    }
    // Fallback: scan assistant text for plan file references
    if (!planFilePath) {
      var allText = allTextParts.join("\n");
      var planMatch = allText.match(/(?:\/[^\s"')\]]+\.claude\/plans\/[^\s"')\]]+\.md)/);
      if (planMatch) planFilePath = planMatch[0].trim();
    }
  }

  return { promptText: formatPromptText(allToolUseBlocks), promptQuestions: extractPromptQuestions(allToolUseBlocks), planFilePath: planFilePath };
}


async function main() {
  const inputRaw = await readStdin();
  let input = {};
  try {
    input = inputRaw ? JSON.parse(inputRaw) : {};
  } catch {
    input = {};
  }

  const projectName = process.env.DISCODE_PROJECT || process.env.AGENT_DISCORD_PROJECT || "";
  if (!projectName) return;

  const agentType = process.env.DISCODE_AGENT || process.env.AGENT_DISCORD_AGENT || "claude";
  const instanceId = process.env.DISCODE_INSTANCE || process.env.AGENT_DISCORD_INSTANCE || "";
  const port = process.env.DISCODE_PORT || process.env.AGENT_DISCORD_PORT || "18470";

  const message = typeof input.message === "string" ? input.message.trim() : "";
  const notificationType = typeof input.notification_type === "string" ? input.notification_type : "unknown";
  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";

  const { promptText, promptQuestions, planFilePath } = extractFromTranscript(transcriptPath);

  console.error(`[discode-notification-hook] project=${projectName} type=${notificationType} message=${message.substring(0, 100)} prompt_len=${promptText.length} questions=${promptQuestions.length} plan=${planFilePath ? "yes" : "no"}`);

  try {
    await postToBridge(port, {
      projectName,
      agentType,
      ...(instanceId ? { instanceId } : {}),
      type: "session.notification",
      notificationType,
      text: message,
      ...(promptText ? { promptText } : {}),
      ...(promptQuestions.length > 0 ? { promptQuestions } : {}),
      ...(planFilePath ? { planFilePath } : {}),
    });
  } catch {
    // ignore bridge delivery failures
  }
}

main().catch(() => {
  // ignore
});
