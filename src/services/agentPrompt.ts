/**
 * Deepgram Voice Agent — System Instructions
 *
 * This is the brain of the assistant. Deepgram's Agent API pipes
 * caller audio → STT (Nova-2) → LLM (this prompt) → TTS (Aura) in one
 * managed WebSocket. We only need to feed it the right persona.
 *
 * DESIGN PRINCIPLES:
 *   - Every sentence is written to be SPOKEN aloud, not read.
 *   - Short sentences. No walls of text. No bullet lists in speech.
 *   - The LLM output goes directly to TTS — so no markdown, no JSON,
 *     no asterisks, no emojis during the live call.
 *   - JSON output is ONLY produced when the function `end_call_summary`
 *     is invoked after the conversation ends.
 */

// ── The Agent Prompt ─────────────────────────────────

export const AGENT_INSTRUCTIONS = `You are Hussein Bayoun's phone assistant. You answer missed calls and take short messages. Keep calls brief and natural.

VOICE AND DELIVERY
- Short sentences. Conversational. No filler ("um", "uh", "like").
- No markdown, bullets, asterisks, or emojis in speech.
- One question at a time. Keep responses to 1–2 sentences unless the caller asks for more.

OPENING
The greeting has already been played to the caller. Never say "Hi, this is Hussein's assistant" or any greeting again. Your first response must only be a direct reply to what the caller said, e.g. "Go ahead" or "Sure, how can I help?" — never repeat the opening line.
if a foreign language is detected, switch to that labguage and respond in that language.
if the caller is speaking in a french, switch to that language and respond in french.
if the caller is speaking in a arabic, switch to that language and respond in that arabic

WHAT TO COLLECT (only these two)
1. Who is calling (name).
2. Why they're calling (reason or message for Hussein).

Do NOT ask for: company, business name, urgency, when they want a callback, or anything else unless the caller volunteers it. If they give you name and reason quickly, move straight to the summary. Do not run through a checklist.

CLOSING EVERY CALL
Summarize back in one short sentence: who called and what they want. Example: "So that's [name], calling about [reason]. I'll pass that along to Hussein."
Then: "Thanks for calling. Have a good day." and end the call.
If they correct something, update the summary and confirm once more.

WHAT YOU MUST NEVER DO
- Never make commitments on Hussein's behalf — no pricing, no deadlines, no approvals, no deliverables.
- Never share Hussein's schedule, location, other phone numbers, email, or any personal details.
- Never provide legal, medical, or financial advice of any kind.
- Never discuss other callers or any previous call.
- Never agree to schedule meetings, confirm appointments, or authorize anything. Always say: "I'll make sure Hussein gets that message and he'll follow up with you directly."
- Never invent information you don't have. If you don't know, say so honestly.

HANDLING "ARE YOU A ROBOT?" / "ARE YOU AI?"
Say: "I'm Hussein's virtual assistant. I'm here to make sure your message gets to him. How can I help?"
Do not elaborate further about your nature. Redirect to their reason for calling.

HANDLING ANGRY OR FRUSTRATED CALLERS
- Stay calm. Lower your energy slightly. Empathize first.
- "I hear you, and I'm sorry you're dealing with this."
- "I understand that's frustrating. Let me make sure Hussein knows exactly what happened so he can address it."
- Never argue, get defensive, or match their energy. Stay steady.
- Focus on accurately capturing their concern.

HANDLING URGENCY
- Only mention urgency if the caller brings it up. Then say: "I'll make sure Hussein sees this as a priority."
- Never promise a specific callback time.

HANDLING SILENCE
- If the caller goes quiet for several seconds: "Are you still there?"
- If still silent: "It seems like we may have gotten disconnected. I'll make sure Hussein gets what we discussed. Take care."

HANDLING OFF-TOPIC OR STRANGE REQUESTS
- If the caller asks about the weather, tells jokes, or goes off-topic, gently redirect: "I appreciate that! Was there anything you'd like me to pass along to Hussein?"
- If the caller asks you to do something outside your role (order food, search the internet, etc.): "That's outside what I'm able to help with, but I can definitely take a message for Hussein."

HANDLING CONFIDENTIAL INFORMATION REQUESTS
- If the caller asks for Hussein's client list, financial info, passwords, or any sensitive data: "I'm not able to share that information. If you'd like, I can have Hussein get back to you directly to discuss that."

HANDLING MULTIPLE TOPICS
- If the caller raises several issues, address them one at a time: "Got it. Let me capture that first point. And the second thing you mentioned was...?"

TONE CALIBRATION
- Default: professional, warm, efficient.
- If caller is casual/friendly: match slightly — a bit warmer, but never unprofessional.
- If caller is formal/corporate: stay crisp and buttoned-up.
- If caller is distressed: gentle, slower, empathetic.
- Always err on the side of professional.`;

// ── Function definitions for the Deepgram Agent ──────
// These let the agent call structured tools during/after the conversation.

export const AGENT_FUNCTIONS = [
  {
    name: 'end_call_summary',
    description:
      'Call this function when the conversation is complete and the caller has confirmed the summary or said goodbye. This extracts the structured call data for Hussein.',
    parameters: {
      type: 'object' as const,
      properties: {
        caller_name: {
          type: 'string',
          description: "Caller's full name, or 'Unknown' if not provided",
        },
        company: {
          type: 'string',
          description: "Caller's company/organization, or 'N/A' if not provided",
        },
        reason_for_call: {
          type: 'string',
          description: 'Concise 1-2 sentence reason for the call',
        },
        urgency: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Urgency based on caller tone and content',
        },
        callback_window: {
          type: 'string',
          description: "When the caller wants a callback, e.g. 'today before 5pm', 'anytime this week', or 'ASAP'",
        },
        promised_actions: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of things Hussein should do, e.g. ["Return call", "Send proposal"]',
        },
        sentiment: {
          type: 'string',
          enum: ['positive', 'neutral', 'frustrated', 'angry', 'distressed'],
          description: 'Overall emotional tone of the caller',
        },
        full_summary: {
          type: 'string',
          description: 'Complete 2-4 sentence summary of the conversation for Hussein',
        },
        confidence_score: {
          type: 'number',
          description: 'Your confidence in the accuracy of extracted info (0.0-1.0)',
        },
      },
      required: [
        'caller_name',
        'reason_for_call',
        'urgency',
        'promised_actions',
        'full_summary',
        'confidence_score',
      ],
    },
  },
];

// ── Deepgram Agent Settings Configuration ────────────
// Sent as the first message over the agent WebSocket.

// V1 API: type "Settings", provider-based structure, "prompt" not "instructions".
const baseSettings = {
  type: 'Settings' as const,
  audio: {
    input: { encoding: 'mulaw' as const, sample_rate: 8000 },
    output: { encoding: 'mulaw' as const, sample_rate: 8000, container: 'none' as const },
  },
  agent: {
    language: 'en' as const,
    greeting:
      "Hi, this is Hussein's assistant. How can I help you today?",
    // Seed conversation so the LLM knows the greeting was already played and won't repeat it.
    context: {
      messages: [
        {
          type: 'History' as const,
          role: 'assistant' as const,
          content: "Hi, this is Hussein's assistant. How can I help you today?",
        },
      ],
    },
    listen: { provider: { type: 'deepgram' as const, model: 'nova-3' } },
    speak: { provider: { type: 'deepgram' as const, model: 'aura-2-thalia-en' } },
  },
};

export function buildAgentSettings(_deepgramApiKey: string) {
  return {
    ...baseSettings,
    agent: {
      ...baseSettings.agent,
      think: {
        provider: { type: 'open_ai' as const, model: 'gpt-4o-mini' },
        prompt: AGENT_INSTRUCTIONS,
        functions: AGENT_FUNCTIONS,
      },
    },
  };
}

/**
 * Alternate config if you want to use Anthropic Claude as the LLM
 * instead of OpenAI. Deepgram supports this natively.
 */
export function buildAgentSettingsWithClaude(_deepgramApiKey: string, anthropicApiKey: string) {
  // V1 only allows claude-3-5-haiku-latest | claude-sonnet-4-20250514 (think-models API).
  // Pass Anthropic key via endpoint.headers so Deepgram can call Claude with your key.
  return {
    ...baseSettings,
    agent: {
      ...baseSettings.agent,
      think: {
        provider: {
          type: 'anthropic' as const,
          model: 'claude-sonnet-4-20250514',
        },
        prompt: AGENT_INSTRUCTIONS,
        functions: AGENT_FUNCTIONS,
        endpoint: {
          url: 'https://api.anthropic.com',
          headers: {
            'x-api-key': anthropicApiKey,
          },
        },
      },
    },
  };
}
