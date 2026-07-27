import {
  ERROR_HANDOFF_MANDATE,
  ERROR_HANDOFF_ROSTER,
  ERROR_NOT_YOUR_TASK,
  ERROR_UNKNOWN_TASK,
} from '@playroom/shared';
import { evaluate } from '@playroom/fabric';
import { isRoomMember, memberRecord } from '../members.js';
import { mandateFor } from '../mandates.js';
import { getTask, handoffTask } from '../tasks.js';
import type { CommandContext, CommandDeps } from './context.js';

/**
 * THE HANDOFF — "@Sol take review" as a record (Bible §21.3).
 *
 * Its exit criterion: the task moves with state and mandate reference, logged. The AUTHENTICATED
 * ACTOR is the addition, and it is the reason this slice builds a handoff at all rather than
 * bolting a check onto `request_action`: S12-N2 says any authenticated member may name any other
 * as the subject of a governed request, and the honest fix is not a rule about naming — it is the
 * record that makes acting-for-another legitimate in the first place. S13-3 requires this record;
 * this commit creates it.
 *
 * ── A HANDOFF CONFERS NO AUTHORITY ──
 *
 * THE RECEIVING MEMBER ACTS UNDER THEIR OWN MANDATE. Not the sender's, not a union of the two,
 * not the sender's minus something. This is the single most likely thing for a later slice to get
 * backwards, because delegation in most systems is exactly the opposite: an OAuth token carries
 * its grant along, a Unix process inherits its parent's rights, a service account passes its role
 * downstream. Here the mandate belongs to the (member, principal) pair and cannot travel, because
 * a mandate is a statement by a PRINCIPAL about their own member — Jerry's grant to Sol says
 * nothing about what Prince's Claude may do, and vice versa. If a handoff could widen the
 * receiver's authority, then any member could escalate any other member's agent by handing it
 * work, and every mandate in the room would be advisory.
 *
 * The structural guarantee is that there is nowhere to put such a claim: `ClientHandoff` has no
 * scope, no mandate reference and no signer field, and the mandate consulted below is looked up
 * BY THE RECEIVER'S ID. The only thing the handoff can do to the receiver's authority is refuse
 * to transfer work their mandate would not admit — which narrows, never widens.
 *
 * ── FOUR REFUSALS, FOUR REASONS ──
 *
 * Ordered so the more fundamental question is answered first, and each one names the constraint
 * that failed. This ordering is not §9.2's evaluation order and does not touch it: these are
 * preconditions for a transfer, not an evaluation of a governed action.
 *
 *   1. UNKNOWN_TASK   — no such task in this room
 *   2. NOT_YOUR_TASK  — the caller has no standing to move it
 *   3. HANDOFF_ROSTER — one of the two members is not in this room
 *   4. HANDOFF_MANDATE— the receiver's mandate does not admit the work
 *
 * Standing before the request, exactly as RA-007 put counterparties ahead of protected actions:
 * asking whether Sol's mandate admits the work is pointless if the caller had no right to move
 * the task, and it would leak which mandates exist to a caller with no standing at all.
 *
 * ── REFUSALS GO TO THE CALLER, NOT INTO THE ROOM ──
 *
 * Unlike a refused summon, which every member of the room witnessed being asked for, a handoff
 * frame is invisible to everyone but its sender. A refusal in the room would tell members about
 * an attempt they never saw — that is attempt visibility, a real product question, and it belongs
 * with interrupts and reputation rather than being decided here by accident. An ACCEPTED handoff
 * is visible: the chip moves, because that changed the room.
 */
export type HandoffRefusal = { code: string; message: string };
export type HandoffResult = { ok: true } | { ok: false; refusal: HandoffRefusal };

export async function handoffCommand(
  deps: CommandDeps,
  ctx: CommandContext,
  input: { roomId: string; taskId: string; toMember: string; action: string },
): Promise<HandoffResult> {
  const refuse = (code: string, message: string): HandoffResult => {
    deps.log.warn(
      {
        room_id: input.roomId,
        task_id: input.taskId,
        actor: ctx.actorId,
        to_member: input.toMember,
        action: input.action,
        code,
      },
      'handoff refused',
    );
    return { ok: false, refusal: { code, message } };
  };

  // 1. THE TASK, in THIS room. A task id from another room is not this room's business, and
  // answering differently for "exists elsewhere" would make the refusal a task-id oracle.
  const task = await getTask(deps.pool, input.taskId);
  if (!task || task.room_id !== input.roomId) {
    return refuse(ERROR_UNKNOWN_TASK, `no task "${input.taskId}" in this room`);
  }

  // 2. STANDING. The caller must be a party to the task: the member who created it, or the
  // member currently holding it. Anyone else moving it is the S12-N2 shape one level up — a
  // member acting on work that is none of theirs, with no record that says otherwise.
  const isParty = ctx.actorId === task.created_by || ctx.actorId === task.assignee_member_id;
  if (!isParty) {
    return refuse(
      ERROR_NOT_YOUR_TASK,
      'only the member who created this task or the member holding it may hand it over',
    );
  }

  // 3. THE ROSTER RULE, which exists now (S1.1b). Both ends must be in the room: handing work to
  // a member who is not here would put a task on someone the room cannot address, and handing it
  // FROM a member who has since been removed would move work nobody in the room ever held.
  //
  // Checked for both, and reported as one refusal naming which — two codes here would be two
  // codes for one constraint (§9.2's `counterparties`), and the sentence carries the detail.
  const [fromInRoom, toInRoom] = await Promise.all([
    isRoomMember(deps.pool, input.roomId, task.assignee_member_id),
    isRoomMember(deps.pool, input.roomId, input.toMember),
  ]);
  if (!toInRoom || !fromInRoom) {
    const who = !toInRoom ? input.toMember : task.assignee_member_id;
    return refuse(ERROR_HANDOFF_ROSTER, `${who} is not in this room`);
  }

  // 4. WOULD THE RECEIVER BE ABLE TO DO THIS WORK AT ALL?
  //
  // Refuse rather than transfer into a member who will only BLOCK on arrival. A task sitting on a
  // member whose mandate forbids its action is a task that can never progress, and the room would
  // show it as `submitted` forever — work that looks assigned and is actually dead. Better to
  // refuse the transfer, out loud, at the moment someone can still do something about it.
  //
  // BLOCK is the only refusal. CO_SIGN means the receiver CAN do the work with a human signature,
  // which is a workflow rather than a wall — refusing it would make every protected action
  // untransferable and would misread the whole point of co-signing.
  //
  // AGENTS ONLY. A human member is not bound by a mandate: mandates bind agents to the principals
  // who grant them, and a human typing in their own room acts as a principal. Requiring one of a
  // human would refuse every handoff to a person, which is backwards.
  const receiver = await memberRecord(deps.pool, input.toMember);
  if (!receiver) return refuse(ERROR_HANDOFF_ROSTER, `${input.toMember} is not a member`);

  const mandate = mandateFor(input.toMember);
  let mandateHash: string | null = mandate?.hash ?? null;
  if (receiver.kind === 'agent') {
    const roster = [task.assignee_member_id, input.toMember];
    const verdict = evaluate(
      { type: input.action, resource: `task:${task.id}` },
      input.toMember,
      mandate,
      undefined,
      roster,
    );
    if (verdict.decision === 'BLOCK') {
      return refuse(
        ERROR_HANDOFF_MANDATE,
        `${input.toMember}'s mandate does not admit ${input.action} (${verdict.reason_code})`,
      );
    }
    mandateHash = verdict.effective_mandate_hash;
  }

  // READ BEFORE THE MOVE. `handoffTask` updates this row object in place, so reading
  // `assignee_member_id` afterwards would log the RECEIVER as the sender — a log line that is
  // wrong in the one field the record exists for.
  const fromMember = task.assignee_member_id;

  // The move itself: the event, then the row. Fanned out, because this one DID change the room.
  const event = await handoffTask(deps.pool, task, {
    toMember: input.toMember,
    action: input.action,
    mandateHash,
    actorId: ctx.actorId,
  });
  deps.bus.publish(input.roomId, event);

  deps.log.info(
    {
      room_id: input.roomId,
      task_id: task.id,
      from_member: fromMember,
      to_member: input.toMember,
      action: input.action,
      mandate_hash: mandateHash,
      actor: ctx.actorId,
    },
    'task handed off',
  );
  return { ok: true };
}
