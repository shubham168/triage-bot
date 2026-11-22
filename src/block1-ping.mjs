const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:1.5b";

async function pingOllama(prompt) {
  const start = performance.now();

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        {
          role: "system",
          content: "You are a concise Linux systems assistant. Reply in under 3 short sentences.",
        },
        { role: "user", content: prompt },
      ],
      options: {
        temperature: 0,
        num_ctx: 2048,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama HTTP ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const wallMs = (performance.now() - start).toFixed(0);
  const evalSec = (data.eval_duration ?? 0) / 1e9;
  const tokPerSec =
    evalSec > 0 && data.eval_count ? (data.eval_count / evalSec).toFixed(1) : "n/a";

  console.log("--- Reply ---");
  console.log(data.message?.content?.trim());
  console.log("\n--- Metrics ---");
  console.log({
    model: data.model,
    wallMs: `${wallMs}ms`,
    promptTokens: data.prompt_eval_count,
    completionTokens: data.eval_count,
    tokensPerSec: tokPerSec,
  });
}

pingOllama("Why would `ss -tulpn` show a service listening on 127.0.0.1:8080 but not 0.0.0.0:8080?").catch((err) => {
  console.error(err);
  process.exit(1);
});
