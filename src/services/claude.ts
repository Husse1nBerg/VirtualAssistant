// Shared call-summary shape. The live voice pipeline runs entirely through
// Deepgram's managed Agent API (see callOrchestrator.ts / agentPrompt.ts); the
// old manual Anthropic conversation/summary functions that used to live here were
// unused and have been removed. Only this type is still referenced.

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
