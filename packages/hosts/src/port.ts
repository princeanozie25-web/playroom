// The RoomMcpPort — the command surface the MCP tools call, injected by the host application.
//
// A package must not import an app, and the MCP host must not re-implement the trust fabric. So the
// six operations are an INTERFACE here; apps/api implements it by authenticating a credential, deriving
// the acting member, and dispatching through executeCommand (§13, ADR-004). Every method is already
// bound to ONE authenticated member — `memberId` — so identity is never a tool argument to be claimed.

/** A room the acting member belongs to. */
export interface RoomSummary {
  id: string;
  title: string;
  created_at: string;
  created_by: string | null;
}

/** One event in a room's recent transcript, flattened for a reader. */
export interface RoomEvent {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  body: string | null;
}

/** A room read: its identity, roster (ids only), recent transcript, and active briefing. */
export interface RoomView {
  id: string;
  title: string;
  created_by: string | null;
  members: string[];
  recent: RoomEvent[];
  briefing: { content: string; purpose: string; set_by: string } | null;
}

/** The fabric's verdict on a requested action. Nothing executes — this is the ruling, and a poll handle. */
export interface ActionVerdict {
  decision: 'ALLOW' | 'CO_SIGN' | 'BLOCK';
  reason_code: string;
  required_signer: string | null;
  effective_mandate_hash: string | null;
  decision_id: string | null;
  poll_after_ms: number | null;
}

export interface PostMessageResult {
  seq: number;
}

export interface RespondResult {
  ok: true;
}

export interface RaiseHandView {
  addressed: string[];
  raised: number;
  refused: string | null;
}

/** A message that `@`-mentioned you and had nothing to answer it (you were not summoned). */
export interface PendingTag {
  room_id: string;
  seq: number;
  ts: string;
  from: string;
  snippet: string;
}

/** The tamper-evident receipt for a co-signed decision. `status` says whether it is in the chain yet. */
export interface Receipt {
  decision_id: string;
  room_id: string;
  status: 'chained' | 'pending_anchor' | 'unresolved';
  resolution?: 'APPROVED' | 'DENIED';
  signed_by?: string;
  /** The receipt's tamper-evident id — the chain entry_hash. Present when `status` is `chained`. */
  entry_hash?: string;
  body_hash?: string;
  chained_at?: string;
  /** The chained receipt still matches its source — this one receipt is intact. */
  verified?: boolean;
}

/**
 * A refusal the port surfaces to a tool as an MCP error RESULT (isError), not a thrown 500. It carries a
 * stable code + a sentence — a room a caller may not see, a mandate refusal, a budget hit — so the model
 * on the other end reads a governed "no", not a stack trace.
 */
export class RoomMcpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RoomMcpError';
  }
}

/**
 * The command surface, bound to one authenticated member. Reads are scoped to that member; writes carry
 * their attribution from `memberId`, never from an argument. A method rejects with {@link RoomMcpError}
 * for a governed refusal; anything else it throws is an unexpected fault.
 */
export interface RoomMcpPort {
  /** The authenticated member this port acts as. Identity is DERIVED here, never claimed by a tool arg. */
  readonly memberId: string;
  /** The rooms the member belongs to. */
  listRooms(): Promise<RoomSummary[]>;
  /** Messages that `@`-mentioned the member since it last acted — the tags no summon answered (B3). */
  listPendingTags(): Promise<PendingTag[]>;
  /** Read a room the member belongs to; RoomMcpError('room_not_found') otherwise (no existence leak). */
  readRoom(roomId: string): Promise<RoomView>;
  /** Post a message into a room as the member. */
  postMessage(input: {
    roomId: string;
    body: string;
    clientMsgId?: string;
  }): Promise<PostMessageResult>;
  /** Ask the fabric to rule on an action under the member's mandate. Nothing executes; the verdict returns. */
  requestAction(input: {
    roomId: string;
    action: string;
    resource: string;
    clientMsgId?: string;
  }): Promise<ActionVerdict>;
  /** Approve or deny a co-sign decision that awaits the member's signature. */
  respondToDecision(input: {
    roomId: string;
    decisionId: string;
    resolution: 'APPROVED' | 'DENIED';
    clientMsgId?: string;
  }): Promise<RespondResult>;
  /** Raise a BLOCKER or FYI to the humans of the member's principal in a room. */
  raiseHand(input: {
    roomId: string;
    urgency: 'BLOCKER' | 'FYI';
    reason: string;
    clientMsgId?: string;
  }): Promise<RaiseHandView>;
  /** The tamper-evident receipt for a co-signed decision in a room the member belongs to. */
  getReceipt(decisionId: string): Promise<Receipt>;
}
