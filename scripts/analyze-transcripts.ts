/**
 * Transcript Analyzer
 *
 * Fetches all call transcripts from the database, sends them to Claude,
 * and produces a report with patterns, failures, and specific prompt improvements.
 *
 * Usage (local):
 *   npx tsx scripts/analyze-transcripts.ts
 *
 * Usage (Render shell):
 *   DATABASE_URL=file:./data/assistant.db npx tsx scripts/analyze-transcripts.ts
 *
 * Output: scripts/analysis-report.md
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'fs';
import { join } from 'path';

const CURRENT_PROMPT_SUMMARY = `
The agent is Hussein Bayoun's phone assistant. It answers missed calls, collects the caller's
name and reason for calling, and sends Hussein an SMS summary + recording link.
Key rules: warm and human, never robotic, never ask for info already given, recognize when the
caller's statement IS the message, handle "Is Hussein available?" gracefully, vary phrasing.
`;

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('❌ ANTHROPIC_API_KEY is not set in .env');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const anthropic = new Anthropic({ apiKey });

  console.log('📂 Fetching calls from database...');

  const calls = await prisma.callLog.findMany({
    include: {
      transcripts: { orderBy: { timestamp: 'asc' } },
    },
    orderBy: { startedAt: 'desc' },
    where: {
      transcripts: { some: {} }, // only calls with transcript data
    },
  });

  await prisma.$disconnect();

  if (calls.length === 0) {
    console.log('⚠️  No calls with transcripts found in the database.');
    console.log('   Make a few test calls first, then run this script.');
    process.exit(0);
  }

  console.log(`✅ Found ${calls.length} call(s) with transcripts.`);

  // Format each call as a readable block
  const formattedCalls = calls.map((call, i) => {
    const lines = call.transcripts.map((t) => {
      const speaker = t.role === 'caller' ? 'CALLER' : 'AGENT';
      return `  ${speaker}: ${t.content.trim()}`;
    });

    const meta = [
      `From: ${call.fromNumber}`,
      `Duration: ${call.durationSeconds ?? '?'}s`,
      `Status: ${call.status}`,
      call.callerName ? `Name extracted: ${call.callerName}` : null,
      call.reasonForCall ? `Reason extracted: ${call.reasonForCall}` : null,
      call.summary ? `Summary: ${call.summary}` : null,
      call.confidenceScore != null ? `Confidence: ${call.confidenceScore}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    return `=== CALL ${i + 1} (${call.startedAt.toISOString().slice(0, 10)}) ===\n${meta}\n\nTranscript:\n${lines.join('\n') || '  (empty)'}`;
  });

  const callsText = formattedCalls.join('\n\n');

  console.log('🤖 Sending to Claude for analysis...');

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are a prompt engineer analyzing transcripts from an AI phone assistant to improve its system prompt.

ASSISTANT ROLE:
${CURRENT_PROMPT_SUMMARY}

CALL TRANSCRIPTS (${calls.length} total):
${callsText}

---

Please produce a structured analysis with these four sections:

## 1. PATTERNS
What common caller behaviors, question types, and scenarios appear across these calls? Group them. Be specific.

## 2. FAILURES & WEAKNESSES
Where did the agent respond poorly, robotically, or miss the mark? Quote the exact transcript lines. Explain what went wrong and what would have been better.

## 3. PROMPT IMPROVEMENTS
Specific, copy-paste-ready additions or rewrites for the system prompt. For each one:
- State the problem it solves
- Provide the exact text to add

## 4. FEW-SHOT EXAMPLES
Pick the 2–3 best-handled conversations from the transcripts (or construct ideal versions of real ones). Format them as example dialogues that could be inserted directly into the system prompt to show the agent how to behave.

Be direct and specific. Quote real transcript lines when identifying failures.`,
      },
    ],
  });

  const report = response.content[0].type === 'text' ? response.content[0].text : '';

  const outputPath = join(process.cwd(), 'scripts', 'analysis-report.md');
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const fullReport = `# Transcript Analysis Report
Generated: ${timestamp}
Calls analyzed: ${calls.length}

---

${report}
`;

  writeFileSync(outputPath, fullReport, 'utf8');

  console.log(`\n✅ Report written to: scripts/analysis-report.md`);
  console.log(`\n--- PREVIEW ---\n`);
  console.log(report.slice(0, 800) + (report.length > 800 ? '\n...(see full report in file)' : ''));
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
