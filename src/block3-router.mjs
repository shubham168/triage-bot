import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:1.5b";

const ALLOWED_SERVICES = new Set(["docker", "nginx", "ssh", "ollama", "postgresql"]);

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

const SYSTEM_PROMPT = `Extract intent and slots for a Linux homelab triage bot as strict JSON.
Intents:
- check_service: status/logs of a named service -> set "service" (lowercase) if mentioned.
- check_port: inspecting a network port -> set "port" (1-65535) if mentioned.
- system_health: disk space, RAM/memory, or general system health -> set "resource" ("disk", "ram", or "all").
- explain_log: explaining an error message or log snippet -> set "error_text".
- unsupported_or_unsafe: deleting/stopping/restarting/modifying files, services, or firewall rules, or off-topic requests.

Use null for any slot not clearly present.`;

async function extract(userInput) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: OLLAMA_JSON_SCHEMA,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userInput },
      ],
      options: { temperature: 0, num_ctx: 2048 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const parsed = JSON.parse(data.message?.content ?? "{}");
  return ExtractionSchema.parse(parsed);
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
        return `Service "${plan.service}" is not on the read-only allow-list (${[...ALLOWED_SERVICES].join(", ")}).`;
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
        const df = await runSafeCheck("df", ["-h", "/"]);
        return `[Disk /]\n${df}`;
      }
      if (plan.resource === "ram") {
        const mem = await runSafeCheck("free", ["-h"]);
        return `[Memory]\n${mem}`;
      }
      const [df, mem] = await Promise.all([
        runSafeCheck("df", ["-h", "/"]),
        runSafeCheck("free", ["-h"]),
      ]);
      return `[Disk /]\n${df}\n\n[Memory]\n${mem}`;
    }

    case "explain_log":
      return `[Explain Error] Ready to pass "${plan.error_text}" to summary/explanation model in Block 4/5.`;

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
  if (state.awaitingSlot) {
    const filled = applyPendingSlot(state, userInput);
    if (!filled) {
      return {
        reply: `Still waiting for a valid ${state.awaitingSlot.missingSlot}. Try again or type "cancel".`,
        nextState: state,
      };
    }
    const output = await executeDecision(filled);
    return { reply: output, nextState: { awaitingSlot: null } };
  }

  const extracted = await extract(userInput);

  if (extracted.intent === "unsupported_or_unsafe" || extracted.confidence < 0.6) {
    if (extracted.intent === "unsupported_or_unsafe") {
      return {
        reply: await executeDecision(extracted),
        nextState: { awaitingSlot: null },
      };
    }
    return {
      reply: "Not quite sure what you need—ask about a service status, a port, disk/RAM health, or an error log.",
      nextState: { awaitingSlot: null },
    };
  }

  const normalized = {
    ...extracted,
    resource: extracted.intent === "system_health" ? (extracted.resource ?? "all") : extracted.resource,
    error_text: extracted.intent === "explain_log" ? (extracted.error_text ?? userInput) : extracted.error_text,
  };

  const missingSlot = getMissingSlot(normalized);
  if (missingSlot) {
    const prompts = {
      service: "Which service should I check? (e.g. docker, nginx, ssh, ollama, postgresql)",
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

// --- Demo multi-turn test script ---
if (import.meta.main) {
  let state = { awaitingSlot: null };
  const turns = [
    "check port status",
    "11434",
    "check my disk space",
    "delete old docker containers",
  ];

  for (const msg of turns) {
    console.log(`\n> ${msg}`);
    const res = await handleTurn(msg, state);
    state = res.nextState;
    console.log(res.reply);
  }
}
