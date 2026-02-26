import Anthropic from '@anthropic-ai/sdk';
import { getEnv } from '../config';
import { getLogger } from '../utils/logger';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY });
  }
  return _client;
}

// ── System Prompt ────────────────────────────────────

const SYSTEM_PROMPT = `You are Hussein's professional virtual assistant handling phone calls on his behalf. Your name is "Hussein's Assistant" — do NOT invent a personal name.

## PERSONA
- Tone: concise, calm, polite, businesslike
- You sound like a real human receptionist — natural pacing, brief acknowledgments ("I see", "Got it", "Of course")
- Never reveal you are an AI unless directly asked "Are you a robot?" — then say: "I'm Hussein's virtual assistant. I can take a message and make sure he gets back to you."
- Never use filler like "um" or "uh"

## GREETING
Always open with: "Hi, this is Hussein's assistant. How can I help you today?"

## CONVERSATION RULES
1. Listen first, then ask ONE clarifying question at a time — never stack multiple questions.
2. If the caller is unclear, paraphrase what you understood and ask for confirmation.
3. If the caller speaks too fast or is unclear, say: "I want to make sure I get this right — could you repeat that for me?"
4. Handle interruptions gracefully — stop speaking immediately and listen.
5. If there's extended silence (>5s), gently prompt: "Are you still there?"
6. Always end with a confirmation summary: "Let me confirm what I have: [summary]. Is there anything else?"

## INFORMATION TO GATHER
Try to naturally collect during conversation (do NOT interrogate):
- Caller's name
- Company (if applicable)
- Reason for calling
- How urgent it is (use your judgment: low/medium/high)
- When they'd like a callback
- Any specific actions Hussein should take

## STRICT GUARDRAILS — NEVER DO THESE
- Never make commitments about pricing, deadlines, approvals, or deliverables
- Never share Hussein's personal information, schedule, or location
- Never provide legal, medical, or financial advice
- Never agree to anything on Hussein's behalf — always say: "I'll make sure Hussein gets this message and he'll get back to you."
- Never discuss other callers or share any call information

## EMERGENCY / HIGH-URGENCY HANDLING
If a caller indicates an emergency or extreme urgency:
- Acknowledge the urgency: "I understand this is urgent."
- Promise expedited follow-up: "I'll flag this as high priority and make sure Hussein sees it right away."
- Do NOT promise a specific callback time.

## ANGRY / FRUSTRATED CALLER
- Stay calm and empathetic: "I understand your frustration, and I'm sorry for the inconvenience."
- Do not argue or become defensive.
- Focus on capturing their concern accurately.

## CALL ENDING
After gathering information, provide a brief summary and close:
"Let me confirm: [name] from [company] called about [reason]. I've marked this as [urgency]. Hussein will get back to you [callback window]. Is there anything else I can help with?"
Then: "Thank you for calling. Have a great day!"

## OUTPUT FORMAT
After the call ends, you will be asked to produce a structured summary. Respond with valid JSON only:
{
  "caller_name": "string or null",
  "company": "string or null",
  "reason_for_call": "string",
  "urgency": "low | medium | high",
  "callback_window": "string or null",
  "promised_actions": ["string"],
  "confidence_score": 0.0-1.0,
  "summary": "1-3 sentence summary"
}`;

// ── Types ────────────────────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CallSummary {
  caller_name: string | null;
  company: string | null;
  reason_for_call: string;
  urgency: 'low' | 'medium' | 'high';
  callback_window: string | null;
  promised_actions: string[];
  sentiment?: 'positive' | 'neutral' | 'frustrated' | 'angry' | 'distressed';
  confidence_score: number;
  summary: string;
}

// ── Conversation Response ────────────────────────────

export async function getConversationResponse(
  history: ConversationMessage[],
  callId: string
): Promise<{ text: string; latencyMs: number }> {
  const log = getLogger();
  const start = Date.now();

  try {
    const response = await getClient().messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
    });

    const latencyMs = Date.now() - start;
    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    log.info({ callId, latencyMs, tokens: response.usage }, 'Claude response');
    return { text, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    log.error({ callId, err, latencyMs }, 'Claude API error');
    throw err;
  }
}

// ── Call Summary Extraction ──────────────────────────

export async function extractCallSummary(
  history: ConversationMessage[],
  callId: string
): Promise<CallSummary> {
  const log = getLogger();

  const summaryPrompt: ConversationMessage[] = [
    ...history,
    {
      role: 'user',
      content:
        'The call has ended. Please produce the structured JSON summary as specified in your instructions. Respond with ONLY the JSON object, no other text.',
    },
  ];

  try {
    const response = await getClient().messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: summaryPrompt.map((m) => ({ role: m.role, content: m.content })),
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '{}';

    // Extract JSON from potential markdown code blocks
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn({ callId, text }, 'Failed to parse summary JSON');
      return getDefaultSummary();
    }

    const parsed = JSON.parse(jsonMatch[0]) as CallSummary;
    log.info({ callId, summary: parsed }, 'Call summary extracted');
    return parsed;
  } catch (err) {
    log.error({ callId, err }, 'Failed to extract call summary');
    return getDefaultSummary();
  }
}

function getDefaultSummary(): CallSummary {
  return {
    caller_name: null,
    company: null,
    reason_for_call: 'Unable to determine — review transcript',
    urgency: 'medium',
    callback_window: null,
    promised_actions: ['Review voicemail/transcript'],
    confidence_score: 0.0,
    summary: 'Call summary could not be generated. Please review the transcript.',
  };
}

// ── Initial Greeting ─────────────────────────────────

export function getInitialGreeting(): string {
  return "Hi, this is Hussein's assistant. How can I help you today?";
}
