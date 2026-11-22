import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const ROUTER_MODEL = process.env.OLLAMA_ROUTER_MODEL ?? process.env.OLLAMA_MODEL ?? "qwen2.5-coder:1.5b";
const EXPLAIN_MODEL = process.env.OLLAMA_EXPLAIN_MODEL ?? ROUTER_MODEL;

const ALLOWED_SERVICES = new Set(["docker", "nginx", "ssh", "ollama", "postgresql"]);

const DESTRUCTIVE_PATTERN =
  /\b(delete|remove|rm|prune|kill|pkill|stop|restart|reboot|shutdown|drop|truncate|wipe|format|chmod|chown|systemctl\s+(stop|restart|disable|mask))\b/i;

const ExtractionSchema = z.object({
  intent: z.enum([
    "check_service",
    "check_port",
    "system_health",
    "explain_log",
    "unsupported_or_unsafe",
  ]),
  confidence: z.number().min(0).max(1),
  service: z.string().nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  resource: z.enum(["all", "disk", "ram"]).nullable(),
  error_text: z.string().nullable(),
});

const OLLAMA_JSON_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: [
        "check_service",
        "check_port",
        "system_health",
        "explain_log",
        "unsupported_or_unsafe",
      ],
    },
    confidence: { type: "number" },
    service: { type: ["string", "null"] },
    port: { type: ["integer", "null"] },
    resource: { type: ["string", "null"], enum: ["all", "disk", "ram", null] },
    error_text: { type: ["string", "null"] },
  },
  required: ["intent", "confidence", "service", "port", "resource", "error_text"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a strict intent and slot extractor for a read-only Linux triage bot.
Output ONLY valid JSON matching the schema. Do NOT guess or invent values not stated in the input.

Rules:
1. "check_service": User asks whether a background service/daemon is active/running or asks its status. Set "service" to the lowercase name ONLY if explicitly named (e.g. "docker", "nginx", "ssh", "ollama", "postgresql"). Otherwise "service": null.
2. "check_port": User asks what process/socket is listening or using a specific port number. Set "port" Only if a numeric port (like 80, 443, 5432, 11434) is explicitly written in the user's message. Never infer or guess a port number from a service name; if NO port number appears, set "port": null.
3. "system_health": User asks about disk space, storage, RAM/memory, or overall system health. Set "resource" to "disk", "ram", or "all". Keep "service": null.
4. "explain_log": User asks what an error message, exit code, or log line means. Put the error/log in "error_text".
5. "unsupported_or_unsafe": Any request to delete, remove, prune, kill, stop, restart, modify configs/files/firewall, or off-topic requests.

Examples:
- Input: "is docker running properly?" -> {"intent":"check_service","confidence":0.95,"service":"docker","port":null,"resource":null,"error_text":null}
- Input: "check port status" -> {"intent":"check_port","confidence":0.9,"service":null,"port":null,"resource":null,"error_text":null}
- Input: "what is using port 11434?" -> {"intent":"check_port","confidence":0.95,"service":null,"port":11434,"resource":null,"error_text":null}
- Input: "check my disk space" -> {"intent":"system_health","confidence":0.95,"service":null,"port":null,"resource":"disk","error_text":null}
- Input: "check port of ollama service" -> {"intent":"check_port","confidence":0.9,"service":"ollama","port":null,"resource":null,"error_text":null}
- Input: "delete old docker containers" -> {"intent":"unsupported_or_unsafe","confidence":1.0,"service":null,"port":null,"resource":null,"error_text":null}`;

async function callOllamaChat({ model, messages, format = null, numCtx = 2048 }) {
  const body = {
    model,
    stream: false,
    messages,
    options: {
      temperature: 0,
      num_ctx: numCtx,
    },
  };
  if (format) {
    body.format = format;
  }

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return data.message?.content ?? "";
}

async function extractWithRetry(userInput) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userInput },
  ];

  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callOllamaChat({
      model: ROUTER_MODEL,
      messages,
      format: OLLAMA_JSON_SCHEMA,
      numCtx: 2048,
    });

    try {
      const parsed = JSON.parse(raw);
      return ExtractionSchema.parse(parsed);
    } catch (err) {
      lastError = err.message;
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `Invalid output (${lastError}). Return ONLY valid JSON matching the schema with null for missing slots.`,
      });
    }
  }

  throw new Error(`Extraction failed after retry: ${lastError}`);
}

async function explainErrorText(errorText) {
  const content = await callOllamaChat({
    model: EXPLAIN_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You explain Linux/networking/container error messages clearly and concisely in up to 4 bullet points. State only what the error typically means and safe read-only diagnostic commands to inspect it. Never suggest destructive commands.",
      },
      { role: "user", content: errorText },
    ],
    numCtx: 2048,
  });
  return content.trim();
}

async function runSafeCheck(action, args = []) {
  try {
    const { stdout, stderr } = await execFileAsync(action, args, { timeout: 4000 });
    return (stdout || stderr || "(no output)").trim();
  } catch (err) {
    return ((err.stdout || "") + "\n" + (err.stderr || "") || err.message).trim();
  }
}

async function executeDecision(plan) {
  switch (plan.intent) {
    case "check_service": {
      const svc = plan.service?.toLowerCase();
      if (!svc || !ALLOWED_SERVICES.has(svc)) {
        return `Service "${plan.service ?? "unknown"}" is not on the read-only allow-list (${[...ALLOWED_SERVICES].join(", ")}).`;
      }
      const active = await runSafeCheck("systemctl", ["is-active", svc]);
      return `[Service: ${svc}] systemctl is-active -> ${active}`;
    }

    case "check_port": {
      const targetPort = String(plan.port);
      const out = await runSafeCheck("ss", ["-tulpn"]);
      const matchingLines = out
        .split("\n")
        .filter((line) => line.includes(`:${targetPort} `) || line.endsWith(`:${targetPort}`));
      return matchingLines.length > 0
        ? `[Port ${targetPort}] Active sockets:\n${matchingLines.join("\n")}`
        : `[Port ${targetPort}] No listening socket found matching :${targetPort}.`;
    }

    case "system_health": {
      if (plan.resource === "disk") {
        return `[Disk /]\n${await runSafeCheck("df", ["-h", "/"])}`;
      }
      if (plan.resource === "ram") {
        return `[Memory]\n${await runSafeCheck("free", ["-h"])}`;
      }
      const [df, mem] = await Promise.all([
        runSafeCheck("df", ["-h", "/"]),
        runSafeCheck("free", ["-h"]),
      ]);
      return `[Disk /]\n${df}\n\n[Memory]\n${mem}`;
    }

    case "explain_log": {
      const explanation = await explainErrorText(plan.error_text);
      return `[Log Explanation]\n${explanation}`;
    }

    case "unsupported_or_unsafe":
    default:
      return "[Blocked] Action is unsupported or unsafe for automatic execution.";
  }
}

function getMissingSlot(extracted) {
  if (extracted.intent === "check_service" && !extracted.service) return "service";
  if (extracted.intent === "check_port" && !extracted.port) return "port";
  if (extracted.intent === "explain_log" && !extracted.error_text) return "error_text";
  return null;
}

function applyPendingSlot(state, rawInput) {
  const { pendingIntent, missingSlot, draft } = state.awaitingSlot;
  const trimmed = rawInput.trim();

  if (missingSlot === "port") {
    const match = trimmed.match(/\b(\d{1,5})\b/);
    const portNum = match ? Number(match[1]) : NaN;
    if (Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535) {
      return { ...draft, intent: pendingIntent, port: portNum };
    }
    return null;
  }

  if (missingSlot === "service") {
    const cleaned = trimmed.replace(/^(service|daemon)\s+/i, "").toLowerCase();
    return { ...draft, intent: pendingIntent, service: cleaned };
  }

  if (missingSlot === "error_text") {
    return { ...draft, intent: pendingIntent, error_text: trimmed };
  }

  return null;
}

export async function handleTurn(userInput, state = { awaitingSlot: null }) {
  const trimmed = userInput.trim();
  if (!trimmed) {
    return { reply: "Empty input.", nextState: state };
  }

  if (state.awaitingSlot && /^(cancel|abort|nevermind)$/i.test(trimmed)) {
    return { reply: "Cancelled pending prompt.", nextState: { awaitingSlot: null } };
  }

  if (state.awaitingSlot) {
    const filled = applyPendingSlot(state, trimmed);
    if (!filled) {
      return {
        reply: `Still waiting for a valid ${state.awaitingSlot.missingSlot}. Enter it or type "cancel".`,
        nextState: state,
      };
    }
    const output = await executeDecision(filled);
    return { reply: output, nextState: { awaitingSlot: null } };
  }

  // Deterministic pre-check before calling LLM router
  if (DESTRUCTIVE_PATTERN.test(trimmed)) {
    return {
      reply: "[Blocked] Destructive or state-modifying actions are not allowed.",
      nextState: { awaitingSlot: null },
    };
  }

  const extracted = await extractWithRetry(trimmed);

  if (extracted.intent === "unsupported_or_unsafe" || extracted.confidence < 0.6) {
    if (extracted.intent === "unsupported_or_unsafe") {
      return {
        reply: await executeDecision(extracted),
        nextState: { awaitingSlot: null },
      };
    }
    return {
      reply:
        "Not sure what you need—ask about a service status, a port, disk/RAM health, or an error log.",
      nextState: { awaitingSlot: null },
    };
  }

  const normalized = {
    ...extracted,
    resource:
      extracted.intent === "system_health"
        ? (extracted.resource ?? "all")
        : extracted.resource,
    error_text:
      extracted.intent === "explain_log"
        ? (extracted.error_text ?? trimmed)
        : extracted.error_text,
  };

  const missingSlot = getMissingSlot(normalized);
  if (missingSlot) {
    const prompts = {
      service: "Which service should I check? (docker, nginx, ssh, ollama, postgresql)",
      port: "Which port number (1–65535) should I check?",
      error_text: "Paste the error message or log line you want explained.",
    };
    return {
      reply: prompts[missingSlot],
      nextState: {
        awaitingSlot: {
          pendingIntent: normalized.intent,
          missingSlot,
          draft: normalized,
        },
      },
    };
  }

  const output = await executeDecision(normalized);
  return { reply: output, nextState: { awaitingSlot: null } };
}

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isMain) {
  let state = { awaitingSlot: null };
  const turns = [
    "check port status",
    "11434",
    "check my disk space",
    "delete old docker containers",
    "bind: address already in use on port 8080",
  ];

  for (const msg of turns) {
    console.log(`\n> ${msg}`);
    const res = await handleTurn(msg, state);
    state = res.nextState;
    console.log(res.reply);
  }
}
