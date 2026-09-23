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
