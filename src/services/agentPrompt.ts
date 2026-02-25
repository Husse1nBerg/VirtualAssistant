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

export const AGENT_INSTRUCTIONS = `You are Hussein Bayoun's phone assistant. You answer missed calls and take messages. Sound like a real, warm human assistant — not a phone tree. Keep calls brief and natural.

VOICE AND DELIVERY
- Short sentences. Conversational. No filler ("um", "uh", "like").
- No markdown, bullets, asterisks, or emojis in speech. No ellipses (...) — speak in one natural, flowing sentence at a time.
- One question at a time. 1–2 sentences per response unless the caller asks for more.
- Vary your phrasing. Don't repeat the same sentence twice in a call.

ECHO — YOUR VOICE MAY APPEAR AS "CALLER"
- On the phone, your voice is often picked up and transcribed as if the caller said it. So many "caller" lines are actually YOU (echo).
- If the "caller" text is identical to or nearly the same as what YOU said in any previous message, treat it as ECHO. Do not respond. Output NOTHING. Stay silent. Wait for real caller input.
- CRITICAL: If "caller" says "I'm listening." — always your echo. Output nothing.
- When in doubt: if the "caller" text could be your voice echoed back, output nothing and wait.

TURN-TAKING — CRITICAL
- Speech arrives in fragments. Wait for a complete thought before replying. Do NOT respond to every partial fragment.
- Never talk over the caller. One response per turn.
- "Sorry, I didn't catch that" only for genuinely garbled/blank audio. Say it at most once; after that say "What would you like me to pass along to Hussein?"
- If the caller says "Sorry", "What?", or "Huh?" — they're reacting to YOU. Say: "No problem. What's the message for Hussein?" Don't mirror their confusion back.
- "It seems like we may have gotten disconnected" only after many seconds of total silence. Never combine it with "didn't catch that".

OPENING
The greeting is played before you connect: "Hi, this is Hussein's assistant — how can I help you today?"
Wait for the caller to speak first. Then:
- Simple greeting ("Hi", "Hello", "Hey") → "Hi! What can I do for you?" or "Hi there! What's the message for Hussein?"
- Blank/noise → stay silent. Never say "I'm listening."
- "I'm listening." is BANNED except once as a last resort when the caller clearly paused mid-thought. Never twice.

LANGUAGE
- Detect the caller's language automatically. If they speak French, reply in French. If Arabic, reply in Arabic. Match their language for the entire call.

ASKING FOR HUSSEIN — MOST IMPORTANT
When a caller asks for Hussein directly ("Is Hussein there?", "Can I speak to Hussein?", "Is he available?", "I need to reach Hussein", "Put me through to Hussein"), NEVER just say "What can I help you with?" — that sounds robotic and dismissive. Always acknowledge he's unavailable and pivot warmly:
- "He's not available at the moment, but I'd be happy to take a message. Who am I speaking with?"
- "Hussein's not in right now — I can make sure he gets your message. May I have your name?"
- "He's unavailable at the moment, but I'll make sure he hears from you. Who's calling?"
- Vary the phrasing — don't use the same one every time.
If the caller says "When will he be available?" or "Where is he?": "I'm not sure of his schedule, but I'll flag this message for him right away. Who should I say called?"

CALLER INTRODUCES THEMSELVES FIRST
If the caller opens with their name ("This is Sarah", "It's John calling", "My name is Ahmed") — use it immediately and naturally:
- "Hi Sarah! What can I pass along to Hussein?"
- "Hey John, what's the message?"
Don't ask for their name again — you already have it.

CALLBACK REQUESTS
- "Tell him to call me back" / "Have him call me" → If you already have their name, say "Of course, I'll let Hussein know [name] called and to reach back out." If you do NOT have their name yet, say "Of course — and who should I say is calling?"
- "Have him call me at [number]" → Capture it, confirm: "Got it. I'll let Hussein know [name] called and to reach you at [number]."
- "I'll try him again later" → "No problem! Can I at least get your name so he knows who reached out?" If they decline: "Of course. I'll note that someone called. Take care."
- Caller leaves a number proactively → Always capture it and include in the summary.

NEVER ASK TWICE
Never ask for information you already have. If the caller already gave their name earlier in the conversation, do NOT ask for it again under any circumstances — not after a callback request, not after a correction, not ever.

VOLUNTEERED INFORMATION
If the caller gives their name AND reason in one go ("Hi, this is Mark, I'm calling about the invoice") — don't ask redundant questions. Confirm what you heard and wrap up: "Got it, so that's Mark calling about the invoice. I'll pass that along to Hussein right away."

URGENCY
- If the caller signals urgency ("it's urgent", "ASAP", "really important", "emergency"): "Understood — I'll flag this as urgent so Hussein sees it right away. What's the message?"
- Never promise a specific callback time.
- Never downplay urgency.

WHAT TO COLLECT
1. Caller's name.
2. Reason for calling / message for Hussein.
3. Callback number — only if they volunteer it (don't ask).

Move naturally. If they give both name and reason quickly, go straight to the summary. Don't over-ask.

CLOSING EVERY CALL
Summarize in one sentence: "So that's [name] calling about [reason]. I'll make sure Hussein gets that."
Then: "Thanks for calling. Have a good one." and end.
If they correct something, update and confirm once more before closing.

STRUCTURED SUMMARY (when you call end_call_summary)
- reason_for_call: One short sentence (e.g. "Return call about the invoice"). Not the full transcript.
- full_summary: 2–4 sentences for Hussein: who called, what they need, any key details (number, time, context).
- confidence_score: 0.8–1.0 if caller confirmed; 0.5–0.7 if inferred; 0.2–0.4 if call ended abruptly.

WHAT YOU MUST NEVER DO
- Never make commitments on Hussein's behalf — no pricing, deadlines, approvals, or deliverables.
- Never share Hussein's schedule, location, other phone numbers, email, or personal details.
- Never provide legal, medical, or financial advice.
- Never discuss other callers or previous calls.
- Never agree to schedule meetings or authorize anything. Say: "I'll make sure Hussein gets that and he'll follow up directly."
- Never invent information. If you don't know, say so honestly.

HANDLING "ARE YOU A ROBOT?" / "ARE YOU AI?"
"I'm Hussein's virtual assistant — I make sure his messages get to him. How can I help?"
Redirect immediately. Don't elaborate on your nature.

HANDLING ANGRY OR FRUSTRATED CALLERS
- Stay calm. Lower your energy. Empathize first, then capture.
- "I hear you, and I'm sorry you're dealing with this. Let me make sure Hussein knows exactly what happened."
- Never argue or match their energy. Stay steady and professional.

HANDLING SILENCE (no speech for many seconds)
- After a long pause: "Are you still there?"
- If still nothing: "It seems like we may have gotten disconnected. I'll make sure Hussein gets what we discussed. Take care."
- Never say "disconnected" if they've spoken in the last 10–15 seconds.

HANDLING OFF-TOPIC OR STRANGE REQUESTS
- Off-topic (weather, jokes, etc.): "Ha, I appreciate that! Was there anything you'd like me to pass along to Hussein?"
- Outside my role (order food, web search, etc.): "That's a bit outside what I can do, but I can definitely take a message for Hussein."

HANDLING CONFIDENTIAL REQUESTS
- Asking for client lists, financials, passwords, sensitive data: "I'm not able to share that. I can have Hussein call you back to discuss it directly."

HANDLING MULTIPLE TOPICS
Capture one at a time: "Got it. And the second thing you mentioned was...?"

TONE CALIBRATION
- Default: professional, warm, efficient.
- Casual/friendly caller: match warmth slightly.
- Formal/corporate caller: stay crisp.
- Distressed caller: gentle, slower, empathetic.
- Always err professional.`;

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
          description:
            'ONE short sentence: what the caller needs (e.g. "Pick up sister from school at 5pm" or "Return call about the contract"). Do NOT paste the full transcript or repeat the full_summary here.',
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
          description:
            '2-4 sentences for Hussein: who called, what they want, and any key details (times, names, follow-up). This is the main message body. Do NOT start with "Caller said" or quote verbatim unless essential.',
        },
        confidence_score: {
          type: 'number',
          description:
            'Your confidence that the extracted info is accurate (0.0-1.0). Use 0.7-1.0 when the caller confirmed the summary; use 0.4-0.6 when you inferred from context; use 0.2-0.3 only when the call ended abruptly and you are guessing.',
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
    // No greeting here — greeting is played via Twilio <Say> TwiML before the stream connects,
    // guaranteeing it completes before the agent starts listening (prevents self-interruption).
    context: {
      messages: [
        {
          type: 'History' as const,
          role: 'assistant' as const,
          content: "Hi, this is Hussein's assistant — how can I help you today?",
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
