# Local Linux Triage Bot (Read-Only)

A lightweight, read-only CLI assistant in Node.js that pairs a local small language model (via [Ollama](https://ollama.com/)) with a deterministic decision router, Zod schema validation, and multi-turn slot filling for inspecting Linux system state.

Rather than letting a local model freestyle shell commands, the LLM is restricted to **intent/slot extraction** and **error explanation**, while Node.js enforces **allow-lists, safety guardrails, slot state, and read-only system checks**.

## How It Works

1. **Pre-LLM Safety Guardrail:** Blocks destructive or state-modifying keywords (`delete`, `remove`, `kill`, `stop`, `restart`, `prune`, `chmod`, etc.) in code before routing.
2. **Structured Intent & Slot Extraction:** Calls `http://localhost:11434/api/chat` with a JSON schema and validates the response with `zod`:
   - `check_service` — checks active status for allow-listed services (`docker`, `nginx`, `ssh`, `ollama`, `postgresql`)
   - `check_port` — inspects listening sockets via `ss -tulpn`
   - `system_health` — checks disk (`df -h /`), RAM (`free -h`), or both
   - `explain_log` — explains error messages or log snippets and suggests read-only diagnostics
   - `unsupported_or_unsafe` — refuses unsafe or out-of-scope requests
3. **Multi-Turn Slot Filling:** When a required slot (such as `port` or `service`) is missing, the bot enters an `awaitingSlot` state and prompts for the missing value, resolving subsequent slot replies directly in code.
4. **Session Audit Logging:** Appends each turn's timestamp, latency, input, slot state, and reply to `logs/triage-YYYY-MM-DD.jsonl`.

## Prerequisites

- **Node.js** (v20+ or v22+ recommended)
- **Ollama** running locally on `http://localhost:11434` with at least one model pulled (e.g., `qwen2.5-coder:1.5b` or `qwen2.5:3b`)
- **Linux** with standard utilities (`systemctl`, `ss`, `df`, `free`)

## Setup

```bash
npm install
