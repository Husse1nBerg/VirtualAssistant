# Tasks

## Current

<!-- Add tasks with checkboxes. Include file paths, test commands, acceptance criteria. -->
<!-- One task per turn. Keep it specific. -->

- [ ] Test-call verification (BLOCKER, user places call): confirm agent responds after the
      greeting on main c9821b0 (Flux agent.language fix merged 2026-10-09), that Flux STT
      doesn't regress recognition/French TTS, and that repeats/recaps have stopped.
- [ ] Surface Deepgram agent `Error` events into the /health error counter (callOrchestrator
      `handleAgentEvent` Error case only log.errors today) so a rejected Settings payload
      alerts instead of hiding behind a green health check.

- [ ] After the recording-prefetch fix is merged: confirm on the next 2–3 calls that the
      MMS `dateSent` is within ~10s of `dateCreated` (Twilio console, or the diag approach
      in lessons.md 2026-10-09). Render log line to look for: "Recording proxy: served audio"
      with `cached: true`.
- [ ] Barge-in fix (Twilio `clear` on UserStartedSpeaking, lessons 2026-10-18). On the next
      call, check the agent channel of the 2-channel recording: no agent audio should
      overlap caller speech for more than ~0.3s, and no clipped syllables.
- [ ] Prod sends a WhatsApp copy on every call and Twilio rejects it (error 63007: the
      Twilio number is not a WhatsApp sender). Harmless but noisy — either unset
      OWNER_WHATSAPP_NUMBER on Render or enable the WhatsApp sender. Owner's call.

## Completed

### 2026-10-09 — Combined MMS arriving minutes late
Twilio timestamps proved our pipeline creates the message 4–5s after hang-up; the delay was
Twilio backing off after a slow first pull of the mp3 from our proxy. Fix: prefetch the mp3
into memory in `/voice/recording-status` before `messages.create`; proxy serves from cache
(`src/services/recordingCache.ts`, 2 tests). Typecheck clean, 17/17 tests.

### 2026-09-23 — Fix repeated questions, excess recaps, and STT-layer cutoffs
**Trigger**: Real call recording (CallLog 1a191858) analyzed via Deepgram batch
transcription with diarization + word timing (`curl .../v1/listen?utterances=true&diarize=true`).

**Root causes found** (two, independent):
1. `agent.listen.provider` = plain `nova-3` (v1), which exposes NO end-of-turn tuning in
   the Deepgram Agent API — turn finalization timing was an internal default we couldn't
   adjust, cutting the caller off mid-pause and triggering "I didn't catch that" + a
   verbatim re-ask.
2. Prompt had no rule against reflecting back ("So that's X calling") after every single
   answer, and no rule to stop probing ("Anything specific...?") once a short answer was
   already sufficient.

**Fix** (`src/services/agentPrompt.ts`):
- Added NO MID-CALL RECAPS and STOP ONCE YOU HAVE ENOUGH sections to `AGENT_INSTRUCTIONS`.
- Swapped `listen.provider` from `nova-3` to `flux-general-multi` (v2), with
  `eot_threshold: 0.8` (default 0.7) and `eot_timeout_ms: 7000` (default 5000) for more
  patience on a thinking pause, and `language_hints` biased per contact language
  (bilingual `['en','fr']` default — Montreal).

**Verified**: `npm run typecheck` clean, 15/15 tests pass. NOT yet verified with a live
test call (added to Current above) — Deepgram doc examples pair Flux listen (v2) with
v1 Aura speak models without stating an incompatibility, but this is worth confirming
live since it changes the STT model actually processing calls in production.

**Full write-up**: see tasks/lessons.md 2026-09-23 entries.
