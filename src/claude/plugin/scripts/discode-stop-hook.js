#!/usr/bin/env node
var { asObject, parseLineJson, readTail, extractToolUseBlocks, formatPromptText, readStdin, postToBridge } = require("./discode-hook-lib.js");

function extractTextBlocks(node, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 10 || node === undefined || node === null) return [];

  if (typeof node === "string") {
    return node.trim().length > 0 ? [node] : [];
  }

  if (Array.isArray(node)) {
    return node.flatMap((item) => extractTextBlocks(item, depth + 1));
  }

  const obj = asObject(node);
  if (!obj) return [];

  if (obj.type === "text" && typeof obj.text === "string" && obj.text.trim().length > 0) {
    return [obj.text];
  }

  if (Array.isArray(obj.content) || typeof obj.content === "string") {
    return extractTextBlocks(obj.content, depth + 1);
  }

  if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string" && obj.text.trim().length > 0) {
    return [obj.text];
  }

  return [];
}

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

function extractThinkingBlocks(node, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 10 || node === undefined || node === null) return [];

  if (Array.isArray(node)) {
    return node.flatMap((item) => extractThinkingBlocks(item, depth + 1));
  }

  const obj = asObject(node);
  if (!obj) return [];

  if (obj.type === "thinking" && typeof obj.thinking === "string" && obj.thinking.trim().length > 0) {
    return [obj.thinking];
  }

  if (Array.isArray(obj.content)) {
    return extractThinkingBlocks(obj.content, depth + 1);
  }

  return [];
}

function readAssistantEntry(entry) {
  const obj = asObject(entry);
  if (!obj || obj.type !== "assistant") return null;

  const message = asObject(obj.message) || obj;
  const messageId = typeof message.id === "string" ? message.id : "";
  const textParts = extractTextBlocks(message.content);
  const text = textParts.join("\n").trim();
  const thinkingParts = extractThinkingBlocks(message.content);
  const thinking = thinkingParts.join("\n").trim();
  const toolUse = extractToolUseBlocks(message.content);
  return { messageId, text, thinking, toolUse };
}

/**
 * Detect system-injected user messages that should NOT be treated as turn boundaries.
 * These appear mid-turn when Claude Code injects context (Skill definitions,
 * request interruptions, auto-compact context, etc.).
 */
function isSystemInjectedMessage(text) {
  if (!text) return false;
  var t = text.trim();
  // Skill context injection (e.g. "Base directory for this skill: /path/to/skill")
  if (t.startsWith("Base directory for this skill:")) return true;
  // Request interruption notice
  if (t === "[Request interrupted by user]") return true;
  // System reminder (standalone)
  if (t.startsWith("<system-reminder>")) return true;
  // Command output context
  if (t.startsWith("<command-name>")) return true;
  // Auto-compact / session continuation context
  if (t.startsWith("This session is being continued from a previous conversation")) return true;
  // Local command caveat
  if (t.startsWith("<local-command-caveat>")) return true;
  return false;
}

/**
 * Parse the transcript tail and return:
 * - displayText: text from the latest assistant messageId (for the response message)
 * - turnText: all assistant text from the current turn (for file path extraction)
 *
 * The turn boundary is the last real user message (with text content, not tool_result).
 * System-injected user messages (Skill context, interruptions) are skipped — they appear
 * mid-turn and should not break the scan.
 * This handles the race condition where the Stop hook fires before the final assistant
 * entry is flushed to disk — earlier entries in the turn may still contain file paths.
 */
function parseTurnTexts(tail) {
  if (!tail) return { displayText: "", intermediateText: "", turnText: "", thinking: "", promptText: "", promptQuestions: [], planFilePath: "" };

  const lines = tail.split("\n");
  let latestMessageId = "";
  const latestTextParts = [];
  const intermediateTextParts = [];
  const allTextParts = [];
  const allThinkingParts = [];
  const allToolUseBlocks = [];

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

      // Claude Code may store content as a plain string (not array of blocks).
      // Treat string content as a real user message — it's a turn boundary.
      if (typeof message.content === "string" && message.content.trim().length > 0) {
        if (!isSystemInjectedMessage(message.content)) break;
        continue;
      }

      const hasUserText = content.some((c) => {
        const co = asObject(c);
        return co && co.type === "text";
      });
      if (hasUserText) {
        // Skip system-injected messages (Skill context, interruptions, etc.)
        // that appear mid-turn — only break at genuine user prompts.
        // Check each text block individually because Claude Code often wraps
        // user messages with <system-reminder> tags — if ANY text block is
        // genuine user input, this is a real turn boundary.
        const textBlocks = content
          .filter((c) => { const co = asObject(c); return co && co.type === "text"; })
          .map((c) => { const co = asObject(c); return co && typeof co.text === "string" ? co.text : ""; });
        const hasRealUserText = textBlocks.some((t) => t.trim().length > 0 && !isSystemInjectedMessage(t));
        if (!hasRealUserText) continue;
        break;
      }
      // tool_result entries — skip and continue scanning
      continue;
    }

    // Skip non-assistant entries (progress, system, etc.)
    if (obj.type !== "assistant") continue;

    const assistant = readAssistantEntry(entry);
    if (!assistant) continue;

    // Track latest messageId for display text
    if (!latestMessageId && assistant.messageId) {
      latestMessageId = assistant.messageId;
    }

    if (assistant.text.length > 0) {
      // Collect ALL assistant text in the turn
      allTextParts.push(assistant.text);

      // Collect text from the latest messageId for display
      if (!latestMessageId || assistant.messageId === latestMessageId) {
        latestTextParts.push(assistant.text);
      } else {
        // Text from earlier messageIds (intermediate text before tool calls)
        intermediateTextParts.push(assistant.text);
      }
    }

    // Collect ALL thinking from the turn (thinking appears in earlier messageIds
    // before tool calls, not in the final messageId that has the response text)
    if (assistant.thinking.length > 0) {
      allThinkingParts.push(assistant.thinking);
    }

    // Collect tool_use blocks from the turn
    if (assistant.toolUse.length > 0) {
      allToolUseBlocks.push(...assistant.toolUse);
    }
  }

  latestTextParts.reverse();
  intermediateTextParts.reverse();
  allTextParts.reverse();
  allThinkingParts.reverse();
  allToolUseBlocks.reverse();

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
      var allText = allTextParts.join("\n") + "\n" + allThinkingParts.join("\n");
      var planMatch = allText.match(/(?:\/[^\s"')\]]+\.claude\/plans\/[^\s"')\]]+\.md)/);
      if (planMatch) planFilePath = planMatch[0].trim();
    }
  }

  return {
    displayText: latestTextParts.join("\n").trim(),
    intermediateText: intermediateTextParts.join("\n").trim(),
    turnText: allTextParts.join("\n").trim(),
    thinking: allThinkingParts.join("\n").trim(),
    promptText: formatPromptText(allToolUseBlocks),
    promptQuestions: extractPromptQuestions(allToolUseBlocks),
    planFilePath: planFilePath,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read assistant text from the transcript with retry to handle the race condition
 * where the Stop hook fires before the final assistant entry is flushed to disk.
 */
async function readTurnTexts(transcriptPath) {
  if (!transcriptPath) return { displayText: "", intermediateText: "", turnText: "", thinking: "", promptText: "", promptQuestions: [], planFilePath: "" };

  // Retry up to 3 times with 150ms delay to let the transcript writer flush
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(150);

    const tail = readTail(transcriptPath, 131072);
    const result = parseTurnTexts(tail);

    // If we found display text, check if the last real entry is an assistant text.
    // If the tail ends with a non-assistant entry (tool_result, progress, system),
    // the final response may not have been written yet — retry.
    if (result.displayText) {
      const lines = tail.split("\n");
      let lastRealType = "";
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const l = lines[i].trim();
        if (!l) continue;
        const e = parseLineJson(l);
        if (!e) continue;
        const o = asObject(e);
        if (!o) continue;
        // Skip progress/system entries — they appear after the final response
        if (o.type === "progress" || o.type === "system") continue;
        lastRealType = o.type;
        break;
      }
      // If the last real entry is an assistant entry, the transcript is likely complete
      if (lastRealType === "assistant") return result;
      // Otherwise, the final assistant entry hasn't been written yet — retry
      continue;
    }
  }

  // Final attempt without retry check
  const tail = readTail(transcriptPath, 131072);
  return parseTurnTexts(tail);
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
  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";

  const { displayText, intermediateText, turnText, thinking, promptText, promptQuestions, planFilePath } = await readTurnTexts(transcriptPath);
  let text = displayText;
  if (!text && typeof input.message === "string" && input.message.trim().length > 0) {
    text = input.message;
  }
  console.error(`[discode-stop-hook] project=${projectName} text_len=${text.length} intermediate_len=${intermediateText.length} turn_text_len=${turnText.length} thinking_len=${thinking.length} prompt_len=${promptText.length} questions=${promptQuestions.length}`);

  if (!text && !turnText && !promptText && promptQuestions.length === 0) return;

  try {
    await postToBridge(port, {
      projectName,
      agentType,
      ...(instanceId ? { instanceId } : {}),
      type: "session.idle",
      text: text || "",
      turnText: turnText || "",
      ...(intermediateText ? { intermediateText } : {}),
      ...(thinking ? { thinking } : {}),
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
