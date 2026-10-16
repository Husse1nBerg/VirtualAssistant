// How much would ElevenLabs cost for what Sky actually said? Totals every assistant
// transcript line per month since the first call and converts to credits/dollars.
// Run in the Render shell (prod DB):  npx tsx scripts/tts-usage.ts
//
// Assumptions (override via env if ElevenLabs changes them):
//   ELEVEN_CREDITS_PER_CHAR  0.5   eleven_turbo_v2_5 is billed at half a credit per character
//   ELEVEN_USD_PER_1K_CREDITS 0.30 pay-as-you-go top-up rate on the free tier
//   GREETING_CHARS            60   pre-connect greeting per call (cached per process, so upper bound)
import 'dotenv/config';
import { loadEnv } from '../src/config/env';
import { getPrisma } from '../src/services/database';

loadEnv();
const CREDITS_PER_CHAR = Number(process.env.ELEVEN_CREDITS_PER_CHAR ?? 0.5);
const USD_PER_1K = Number(process.env.ELEVEN_USD_PER_1K_CREDITS ?? 0.30);
const GREETING_CHARS = Number(process.env.GREETING_CHARS ?? 60);

(async () => {
  const rows = await getPrisma().transcript.findMany({
    where: { role: 'assistant' },
    select: { content: true, callLogId: true, callLog: { select: { startedAt: true } } },
  });
  const calls = await getPrisma().callLog.findMany({ select: { id: true, startedAt: true } });

  const byMonth = new Map<string, { calls: Set<string>; chars: number }>();
  const bucket = (d: Date) => {
    const k = d.toISOString().slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, { calls: new Set(), chars: 0 });
    return byMonth.get(k)!;
  };
  for (const c of calls) bucket(c.startedAt).calls.add(c.id);
  for (const r of rows) bucket(r.callLog.startedAt).chars += r.content.length;

  console.log(`month     calls  spoken_chars  +greetings  credits   usd`);
  let totChars = 0, totCredits = 0, months = 0;
  for (const [m, v] of [...byMonth.entries()].sort()) {
    const chars = v.chars + v.calls.size * GREETING_CHARS;
    const credits = chars * CREDITS_PER_CHAR;
    totChars += chars; totCredits += credits; months++;
    console.log(`${m}  ${String(v.calls.size).padStart(5)}  ${String(v.chars).padStart(12)}  ${String(chars).padStart(10)}  ${String(Math.round(credits)).padStart(7)}  $${(credits / 1000 * USD_PER_1K).toFixed(2)}`);
  }
  const avgCredits = totCredits / Math.max(months, 1);
  console.log(`\n${months} months, ${calls.length} calls, ${totChars} chars incl. greetings`);
  console.log(`average per month: ${Math.round(avgCredits)} credits = $${(avgCredits / 1000 * USD_PER_1K).toFixed(2)}`);
  console.log(`$5 of credits (${Math.round(5000 / USD_PER_1K)} credits) lasts ~${(5000 / USD_PER_1K / Math.max(avgCredits, 1)).toFixed(1)} months at that average`);
  process.exit(0);
})();
