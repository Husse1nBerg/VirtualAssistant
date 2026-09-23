# Lessons Learned

## Template
**What happened**: Brief description
**Root cause**: Why it happened
**Rule**: The rule to prevent recurrence
**Example**: Command, check, or code pattern that would have caught it

## [2026-09-23] Prompt-only fixes can't solve STT-layer turn-cutting
**What happened**: Real call recording (analyzed via Deepgram batch transcription with diarization + word timing — CallLog 1a191858) showed Sky repeating an identical question verbatim within ~9s of first asking it, with no real gap for the caller's actual reply, and self-interrupting mid-sentence into a near-duplicate question. Earlier prompt edits (INTERRUPTIONS section, NEVER ASK TWICE, no-repeat rules) did not fix this.
**Root cause**: `agent.listen.provider` uses plain `nova-3` (v1), which exposes NO end-of-turn/VAD tuning in the Deepgram Agent Settings API — turn-finalization timing is an internal Deepgram default we cannot adjust. A turn can be cut/finalized at the AUDIO layer before the LLM ever sees the caller's full utterance, so no prompt instruction can fix it.
**Rule**: For "agent cuts off / repeats / mishandles silence" reports, check the STT/turn-detection layer (real recording + timing) before assuming it's a prompt problem. Deepgram's `flux-general-en` / `flux-general-multi` (v2) exposes `eot_threshold` (0.5-1.0, default 0.7), `eager_eot_threshold` (0.3-0.9), and `eot_timeout_ms` (500-60000, default 5000) for exactly this. `flux-general-multi` supports French via `language_hints`.
**Example**: `agent.listen.provider = { type:'deepgram', version:'v2', model:'flux-general-en', eot_threshold:0.8, eot_timeout_ms:7000 }`. Diagnostic: `curl -X POST "https://api.deepgram.com/v1/listen?model=nova-3&utterances=true&diarize=true" -d '{"url":"<recording-proxy-url>"}'`, then diff gaps between consecutive utterances.

## [2026-09-23] Over-confirmation is a separate, prompt-level bug from turn-cutting
**What happened**: Same call — after getting "car insurance" as a clear, complete reason, Sky recapped ("So you're calling about car insurance") then asked "Anything specific you'd like me to mention?" instead of moving to close. She also recapped after nearly every single answer (company name, reason, callback number) rather than once at the end.
**Root cause**: The prompt's CLOSING rule only specifies ONE end-of-call summary, but nothing told the model NOT to reflect back after every fragment, and "don't over-ask" (WHAT TO COLLECT) wasn't strong enough to stop probing for more detail once a short answer was already sufficient.
**Rule**: A short, on-topic answer to "what's the message" is complete — don't dig for more detail unless the caller volunteers it. Reflect back what was heard ONLY at the final close, not after each individual answer.
**Example**: Added NO MID-CALL RECAPS + STOP PROBING WHEN YOU HAVE ENOUGH sections to AGENT_INSTRUCTIONS in agentPrompt.ts.

## [2026-09-23] English-only STT silently drops an unknown caller's French opener
**What happened**: A second bad-call recording (CallLog e2c61e37, pre-Flux-fix) showed a caller opening with "Oui, bonjour." — completely absent from my diagnostic transcript on the first (English-only nova-3) pass, and (more importantly) absent from the LIVE agent's transcript too, since production used the same English-only STT for unknown callers at the time. The agent perceived silence after its own greeting, triggered a "checking in" filler ("Hello? Hi there."), the caller then re-tried in English sounding confused, and the agent additionally cut into a later mid-sentence pause — compounding into a multi-turn "interrupting/resetting" loop the user described directly.
**Root cause**: French support was previously gated entirely on `contact.language === 'fr'` (a known DB contact) — an unknown caller speaking French first had no recognition path at all. Diagnostic tooling made the same mistake (transcribing with `model=nova-3` and no `language` param).
**Rule**: STT recognition should not be English-only for anyone — Montreal is bilingual and unknown callers include French speakers. When diagnosing a call, always re-transcribe with `language=multi` (or the STT config actually used in prod) before concluding what was or wasn't said.
**Example**: Already covered by the 2026-09-23 Flux migration above — `flux-general-multi` with bilingual `language_hints` applies to ALL callers, not just known French contacts, so this class of silent-drop should no longer occur. Confirm with a live test call where an unknown caller opens in French.

## [2026-09-23] LLM invented a caller's name under uncertain audio
**What happened**: Same recording — Sky said "Hi, Dan. How can I help with Milo's appointment?" at 22s, before the caller had given ANY name (the real name, "Sylvia," wasn't given until 65s, and Sky properly asked for it then — never reconciling the earlier wrong one). A separate moment in the same call ("Alexa is saying no," inserted mid-sentence with no referent) looks like the same failure family — fabricated content appearing under uncertain/garbled input, rather than admitting uncertainty.
**Root cause**: The existing "never invent information" rule (WHAT YOU MUST NEVER DO) was too generic/buried to stop this in practice — nothing specifically told the model what to do when a name is unclear (ask vs. guess).
**Rule**: When audio is unclear, ask or say so — never fabricate a plausible-sounding name or detail to fill the gap.
**Example**: Added NEVER GUESS A NAME section to AGENT_INSTRUCTIONS (agentPrompt.ts), right after CALLER INTRODUCES THEMSELVES FIRST.
