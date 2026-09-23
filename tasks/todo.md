# Tasks

## Current

<!-- Add tasks with checkboxes. Include file paths, test commands, acceptance criteria. -->
<!-- One task per turn. Keep it specific. -->

- [ ] Test-call verification: confirm Flux STT change doesn't regress recognition quality
      or French TTS, and that repeats/recaps have actually stopped in a real call.

## Completed

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
