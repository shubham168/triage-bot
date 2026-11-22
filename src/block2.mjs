import { z } from "zod";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:1.5b";

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
  missing_info: z.array(z.string()),
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
    missing_info: { type: "array", items: { type: "string" } },
  },
  required: [
    "intent",
    "confidence",
    "service",
    "port",
    "resource",
    "error_text",
    "missing_info",
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a strict intent and slot extractor for a Linux homelab triage bot.
Return ONLY valid JSON matching the schema. Never invent values not present or clearly implied.
Intents:
- check_service: user asks about a systemd/background service status or logs (extract "service" if named; if missing, add "service" to missing_info).
- check_port: user asks what is listening or failing on a network port (extract "port" if given; if missing, add "port" to missing_info).
- system_health: user asks about CPU, memory/RAM, or disk space (set "resource" to "disk", "ram", or "all").
- explain_log: user pastes an error/log or asks what an error message means (put snippet/error in "error_text").
- unsupported_or_unsafe: anything destructive (delete, stop, kill, restart, modify config, firewall changes) or unrelated to Linux triage.

Set unused slot fields to null.`;

async function extractIntent(userInput) {
  const start = performance.now();

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
      options: {
        temperature: 0,
        num_ctx: 2048,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const elapsedMs = (performance.now() - start).toFixed(0);
  const rawContent = data.message?.content ?? "";

  let parsedJson;
  try {
    parsedJson = JSON.parse(rawContent);
  } catch (err) {
    return {
      ok: false,
      elapsedMs,
      rawContent,
      error: `JSON.parse failed: ${err.message}`,
    };
  }

  const validated = ExtractionSchema.safeParse(parsedJson);
  if (!validated.success) {
    return {
      ok: false,
      elapsedMs,
      rawContent,
      error: `Zod validation failed: ${validated.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }

  return {
    ok: true,
    elapsedMs,
    data: validated.data,
  };
}

const SAMPLE_INPUTS = [
  "is docker running properly?",
  "what is using port 11434?",
  "check my disk space",
  "delete all old docker images and prune volumes",
  "check port status",
];

for (const input of SAMPLE_INPUTS) {
  const result = await extractIntent(input);
  console.log(`\nInput: "${input}" (${result.elapsedMs}ms)`);
  console.log(result.ok ? result.data : `ERROR: ${result.error}\nRaw: ${result.rawContent}`);
}
