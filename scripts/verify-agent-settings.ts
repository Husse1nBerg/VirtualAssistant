// Pre-merge check: does Deepgram's Agent API ACCEPT every Settings payload we send?
// Opens the real agent WebSocket, sends each builder's output, and fails (exit 1) unless
// Deepgram answers SettingsApplied. Run before merging ANY change to agentPrompt.ts:
//   npx tsx scripts/verify-agent-settings.ts
// Why: a rejected Settings message (INVALID_SETTINGS) fails silently in prod — the
// pre-connect greeting still plays, then the agent never responds. See tasks/lessons.md.
import 'dotenv/config';
import { WebSocket } from 'ws';
import { loadEnv } from '../src/config/env';
import {
  buildAgentSettings,
  buildAgentSettingsWithClaude,
  buildCommandAgentSettings,
  buildCommandAgentSettingsWithClaude,
  speakingFirst,
  claimedOwnerSettings,
  COMMAND_GREETING,
  BACK_TO_MESSAGE_GREETING,
  withHistory,
} from '../src/services/agentPrompt';

loadEnv();
const key = (process.env.DEEPGRAM_API_KEY || '').trim();
const frContact = { contact: { name: 'Test Caller', language: 'fr', isVip: true } as any, recentCalls: [] };

const cases: [string, unknown][] = [
  ['caller / unknown (OpenAI think)', buildAgentSettings(key)],
  ['caller / French contact (OpenAI think)', buildAgentSettings(key, frContact)],
  ['caller / unknown (Claude think)', buildAgentSettingsWithClaude(key, 'x')],
  ['command mode (OpenAI think)', buildCommandAgentSettings(key)],
  ['command mode (Claude think)', buildCommandAgentSettingsWithClaude(key, 'x')],
  ['command mode in French (Claude think)', buildCommandAgentSettingsWithClaude(key, 'x', 'fr')],
  // "It's Hussein" mid-call swaps: the new agent speaks first (agent.greeting), no replayed history.
  ['mid-call owner switch (OpenAI think)', claimedOwnerSettings(speakingFirst(buildCommandAgentSettings(key), COMMAND_GREETING))],
  ['mid-call owner switch (Claude think)', claimedOwnerSettings(speakingFirst(buildCommandAgentSettingsWithClaude(key, 'x'), COMMAND_GREETING))],
  ['mid-call back to message (Claude think)', speakingFirst(buildAgentSettingsWithClaude(key, 'x'), BACK_TO_MESSAGE_GREETING)],
  // French detected mid-call: French voice + listening, conversation so far as history.
  ['mid-call switch to French (Claude think)', withHistory(buildAgentSettingsWithClaude(key, 'x', { contact: null, recentCalls: [], language: 'fr' }),
    [{ role: 'caller', content: 'Hello, is Hussein there?' }, { role: 'assistant', content: "He's tied up right now!" }])],
];

function probe(label: string, settings: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://agent.deepgram.com/v1/agent/converse', {
      headers: { Authorization: `Token ${key}` },
    });
    let settled = false;
    const finish = (ok: boolean, msg: string) => {
      if (settled) return;
      settled = true;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${msg}`);
      try { ws.close(); } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false, 'no SettingsApplied within 8s'), 8000);
    ws.on('open', () => ws.send(JSON.stringify(settings)));
    ws.on('message', (data: Buffer) => {
      const s = data.toString();
      if (!s.startsWith('{')) return;
      const ev = JSON.parse(s);
      if (ev.type === 'SettingsApplied') { clearTimeout(timer); finish(true, ''); }
      if (ev.type === 'Error') { clearTimeout(timer); finish(false, `${ev.code}: ${ev.description}`); }
    });
    ws.on('error', (err) => { clearTimeout(timer); finish(false, `ws error: ${err.message}`); });
  });
}

(async () => {
  let allOk = true;
  for (const [label, settings] of cases) allOk = (await probe(label, settings)) && allOk;
  console.log(allOk ? '\nAll Settings payloads accepted by Deepgram.' : '\nAt least one payload was REJECTED — do not merge.');
  process.exit(allOk ? 0 : 1);
})();
