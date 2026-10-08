import { z } from "zod";
import { randomUUID } from "node:crypto";
import { GatewayError, fail, operationalError } from "./errors.js";
import type { ChatInput, Principal } from "./schemas.js";
import { inputBound } from "./schemas.js";
import type { Ledger } from "./ledger.js";
import type { Cloud } from "./cloud.js";

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const providerResponse = z.object({
  id: z.string().min(1).max(200),
  object: z.literal("chat.completion"),
  created: counter,
  model: z.string().min(1).max(200),
  choices: z.array(z.object({
    index: z.literal(0),
    message: z.object({
      role: z.literal("assistant"),
      content: z.string().max(1_000_000),
      tool_calls: z.never().optional(), function_call: z.never().optional(), audio: z.never().optional(),
    }),
    finish_reason: z.enum(["stop", "length", "content_filter"]),
  })).length(1),
  usage: z.object({ prompt_tokens: counter, completion_tokens: counter, total_tokens: counter }).passthrough(),
});
export type CompletionResponse = z.infer<typeof providerResponse>;

export function simulated(input: ChatInput): CompletionResponse {
  const text = "SIMULATED DEMO — no model or Azure was contacted. This response exercises prepaid reservations and settlement.";
  const content = text.slice(0, Math.max(1, input.max_completion_tokens * 3));
  const prompt = Math.max(1, Math.min(inputBound(input), Math.ceil(input.messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0) / 3) + input.messages.length * 8));
  const output = Math.min(input.max_completion_tokens, Math.ceil(content.length / 3));
  return {
    id: `chatcmpl-demo-${randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: input.model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output },
  };
}

export class Inference {
  constructor(private ledger: Ledger, private cloud?: Pick<Cloud, "infer">) {}

  async execute(team: string, principal: Principal, input: ChatInput) {
    const reservation = await this.ledger.reserve(team, { id: principal.id, type: principal.type, clientAppId: principal.clientAppId }, input);
    try {
      const raw = this.cloud ? await this.cloud.infer(input, reservation.snapshot.deploymentName) : simulated(input);
      // Validate usage independently so malformed or excessive counters quarantine instead of releasing.
      const rawUsage = raw && typeof raw === "object" ? (raw as { usage?: unknown }).usage : undefined;
      if (rawUsage === undefined || rawUsage === null) throw new Error("Usage missing.");
      const response = providerResponse.safeParse(raw);
      if (!response.success) {
        const usage = rawUsage as Record<string, unknown>;
        if (![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) {
          await this.ledger.settle(reservation.id, rawUsage);
        }
        throw new Error("Provider response invalid.");
      }
      const settled = await this.ledger.settle(reservation.id, response.data.usage);
      return { response: response.data, settled, reservationId: reservation.id };
    } catch (error) {
      await this.ledger.held(reservation.id).catch(() => {
        operationalError("inference.mark_held", "STORAGE_UNAVAILABLE", reservation.id);
      });
      if (error instanceof GatewayError && error.code === "INVALID_USAGE_RESERVATION_HELD") throw error;
      return fail(502, "RESERVATION_HELD", `Inference outcome is uncertain. Check reservation ${reservation.id} in usage. No funds are automatically released and no automatic retry is permitted.`);
    }
  }
}
