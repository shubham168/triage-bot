import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { handleTurn } from "./block4-workflow.mjs";

const LOG_DIR = path.resolve(process.cwd(), "logs");

function getLogFilePath() {
  const dateStr = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `triage-${dateStr}.jsonl`);
}

async function logEvent(entry) {
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(getLogFilePath(), JSON.stringify(entry) + "\n", "utf8");
}

async function main() {
  const rl = readline.createInterface({ input, output });
  let state = { awaitingSlot: null };

  console.log("Local Linux Triage Bot (read-only). Type '/help' for commands or 'exit' to quit.\n");

  try {
    while (true) {
      const promptLabel = state.awaitingSlot
        ? `triage [${state.awaitingSlot.missingSlot}]> `
        : "triage> ";

      const line = await rl.question(promptLabel);
      const trimmed = line.trim();

      if (!trimmed) continue;

      if (/^(exit|quit)$/i.test(trimmed)) {
        console.log("Bye.");
        break;
      }

      if (trimmed === "/help") {
        console.log(
          [
            "Commands:",
            "  /help   - show this help",
            "  /state  - print current conversation slot state",
            "  /reset  - clear pending slot state",
            "  exit    - quit CLI",
            "",
            "Try asking:",
            "  - is ollama running?",
            "  - check port status",
            "  - check ram or disk",
            "  - what does EACCES mean on port 80?",
          ].join("\n")
        );
        continue;
      }

      if (trimmed === "/state") {
        console.log(JSON.stringify(state, null, 2));
        continue;
      }

      if (trimmed === "/reset") {
        state = { awaitingSlot: null };
        console.log("State reset.");
        continue;
      }

      const start = performance.now();
      const { reply, nextState } = await handleTurn(trimmed, state);
      const elapsedMs = Math.round(performance.now() - start);

      state = nextState;
      console.log(`\n${reply}\n(${elapsedMs}ms)\n`);

      await logEvent({
        ts: new Date().toISOString(),
        elapsedMs,
        input: trimmed,
        awaitingSlotAfter: state.awaitingSlot?.missingSlot ?? null,
        reply,
      });
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
