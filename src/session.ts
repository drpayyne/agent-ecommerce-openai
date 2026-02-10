import type { AgentInputItem } from '@openai/agents';

// ---------------------------------------------------------------------------
// Durable session schema — only semantic chat content, no provider IDs
// ---------------------------------------------------------------------------

/** Minimal durable chat message. No provider IDs, reasoning, or status. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt: number; // epoch ms
}

// ---------------------------------------------------------------------------
// SessionStore interface — swap in KV, D1, R2, etc.
// ---------------------------------------------------------------------------

/** Abstract storage backend for replay-safe conversation history. */
export interface SessionStore {
  /** Load the full conversation history for a session. */
  load(conversationId: string): Promise<ChatMessage[]>;
  /** Append messages atomically (user + assistant committed together). */
  append(conversationId: string, messages: ChatMessage[]): Promise<void>;
  /** Delete all messages for a session. */
  clear(conversationId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Durable Object implementation of SessionStore
// ---------------------------------------------------------------------------

/** RPC surface the Durable Object must expose for session storage. */
export interface SessionStub {
  loadSession(conversationId: string): Promise<ChatMessage[]>;
  appendToSession(conversationId: string, messages: ChatMessage[]): Promise<void>;
  clearSession(conversationId: string): Promise<void>;
}

/** SessionStore backed by a Cloudflare Durable Object. */
export class DurableObjectSessionStore implements SessionStore {
  constructor(private stub: SessionStub) {}

  load(conversationId: string): Promise<ChatMessage[]> {
    return this.stub.loadSession(conversationId);
  }

  append(conversationId: string, messages: ChatMessage[]): Promise<void> {
    return this.stub.appendToSession(conversationId, messages);
  }

  clear(conversationId: string): Promise<void> {
    return this.stub.clearSession(conversationId);
  }
}

// ---------------------------------------------------------------------------
// Adapter: durable history → run() input
// ---------------------------------------------------------------------------

/**
 * Reconstruct an `input` array for `run()` from durable history plus the
 * current user turn. Every item is id-free so the Responses API treats
 * them as fresh conversational context — no provider-linked look-ups,
 * no reasoning items, no status tracking.
 */
export function buildRunInput(history: ChatMessage[], currentUserText: string): AgentInputItem[] {
  const items: AgentInputItem[] = [];

  for (const msg of history) {
    if (msg.role === 'user') {
      items.push({
        role: 'user',
        content: [{ type: 'input_text', text: msg.text }],
      } as AgentInputItem);
    } else {
      // AssistantMessageItem requires `status`; `completed` is safe for replay.
      items.push({
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: msg.text }],
      } as AgentInputItem);
    }
  }

  // Append the current turn as the final item.
  items.push({
    role: 'user',
    content: [{ type: 'input_text', text: currentUserText }],
  } as AgentInputItem);

  return items;
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

/** Loose type for streamed agent events — we only inspect a narrow surface. */
export interface StreamEvent {
  type: string;
  data?: { type?: string; delta?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Extract the final assistant text from buffered stream events.
 * Skips reasoning, tool calls, and everything that isn't an output_text_delta.
 */
export function extractAssistantText(events: StreamEvent[]): string {
  let text = '';

  for (const event of events) {
    if (
      event.type === 'raw_model_stream_event' &&
      event.data?.type === 'output_text_delta' &&
      typeof event.data.delta === 'string'
    ) {
      text += event.data.delta;
    }
  }

  return text;
}
