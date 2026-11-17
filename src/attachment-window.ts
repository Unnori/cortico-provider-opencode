import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';

/** Core's external-event delivery marker, not a model-generated tool call. */
const EXTERNAL_EVENT_FRAME = 'external_event_frame';

function modelOutput(entry: ContextRecord): boolean {
  if (entry.context.head) return false;
  const item = entry.item;
  return item.type === 'reasoning' || item.type === 'message' && item.role === 'assistant'
    || item.type === 'function_call' && item.name !== EXTERNAL_EVENT_FRAME;
}

function delivery(entry: ContextRecord): boolean {
  if (entry.context.head) return false;
  const item = entry.item;
  return item.type === 'message' && item.role === 'user'
    || item.type === 'function_call' && item.name === EXTERNAL_EVENT_FRAME
    || item.type === 'function_call_output' && Boolean(entry.context.frame);
}

/**
 * First record whose media belongs to the current delivery. Consecutive user
 * messages and event frames before any model output form one batch. Ordinary
 * tool calls/results never start a batch; their media stays through its loop.
 * Results after the last model output also stay: a new delivery may arrive
 * before the model has had any chance to see those results.
 *
 * With no recognizable delivery marker, keep the supplied context. Nothing here
 * records a send as analysis success, mutates history or depends on process state.
 */
export function attachmentWindow(context: readonly ContextRecord[]): number {
  let latest = -1;
  let output = -1;
  for (let index = context.length - 1; index >= 0; index--) {
    if (latest < 0 && delivery(context[index])) latest = index;
    if (output < 0 && modelOutput(context[index])) output = index;
    if (latest >= 0 && output >= 0) break;
  }
  if (latest < 0) return 0;
  let start = latest;
  for (let index = latest - 1; index >= 0 && !modelOutput(context[index]); index--) {
    if (delivery(context[index])) start = index;
  }
  return Math.min(start, output + 1);
}
