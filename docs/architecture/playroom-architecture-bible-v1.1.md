# PLAYROOM

**The Trust, Collaboration and Experience Layer for Artificial Intelligence**

**Architecture Bible — Volume I (Revised)**

**Strategic Foundation, Trust Fabric, Cross-Surface Collaboration and Delivery Sequence**

| Field      | Value                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| Owner      | Prince Anozie                                                                                                       |
| Version    | 1.1 — Volume I, Revised                                                                                             |
| Date       | 25 July 2026                                                                                                        |
| Status     | Canonical. Supersedes Architecture Bible v1.0 Vol I; absorbs and amends Master Architecture & Delivery Roadmap v1.0 |
| Supersedes | Bible v1.0 Vol I (25 Jul 2026) · Roadmap v1.0 (24 Jul 2026) · Blueprint v0.2 · Deck v2                              |

> **Standing product law.** Playroom must remain valuable when any one host application, model provider, connector standard or agent runtime disappears.

> **Standing delivery law.** Every phase exit and every canonical demonstration must be executable using assets the founder fully owns. A milestone that needs a third party's cooperation in order to be _shown_ is not a milestone; it is a request.

## Document authority, precedence and reading rule

This volume is canonical. It supersedes Architecture Bible v1.0 Volume I and absorbs the Master Architecture and Delivery Roadmap v1.0. Where those documents disagree with this one, this one wins. Where this one is silent, the roadmap's operational detail still stands.

Terms introduced here are contractual across future Playroom and Drift documents, source-code modules, event schemas, interface language, investor material and agent prompts. Later volumes may refine implementation detail. They may not silently redefine the core product, the delivery sequence or the commercial commitments.

The document distinguishes facts, architectural commitments, working hypotheses and future possibilities. Where a statement depends on a platform capability outside Playroom's control, it is a route-specific integration assumption, never a permanent platform property.

### Precedence by domain

| Domain                                     | Authority           | Provenance                               |
| ------------------------------------------ | ------------------- | ---------------------------------------- |
| Positioning and cross-surface thesis       | This document       | Bible v1.0 §1–5 — accepted               |
| Members, principals, hosts, routes         | This document       | Bible v1.0 §6 — accepted                 |
| Context promotion and consent              | This document       | Bible v1.0 §7 — accepted                 |
| Permission decision contract               | This document       | Bible v1.0 §8.2 — accepted               |
| Trust fabric stages and fail-closed rule   | This document       | Roadmap v1.0 §4, §12.2 — retained        |
| Delivery sequence, slices, binary exits    | This document       | Roadmap v1.0 §11 — retained              |
| Commercial dates and pricing               | This document       | Roadmap v1.0 S2.9 — restored             |
| Latency, cost and telemetry budgets        | This document       | Roadmap v1.0 §7, §16, §17 — retained     |
| Founder capacity and the exam window       | This document       | Roadmap v1.0 §20 — retained              |
| Experience graph, distillation, reputation | Documented, unbuilt | Bible v1.0 §10–11 — parked behind a gate |

## Changes from Bible v1.0 — accepted, amended, rejected

Bible v1.0 was written after the discovery of Buzz and is right about almost everything architectural. It is wrong about delivery, and it is wrong in a specific, diagnosable way: it treated a positioning insight as a build instruction. This section records the disposition of every material claim, so no future session silently reverses a decision.

### Accepted in full

1. The destination-workspace positioning is retired. Buzz occupies that category credibly and openly.
2. **Canonical room versus host projection** becomes the central architectural separation. This is the change that makes ambient collaboration coherent rather than a second copy of the truth.
3. **Member, principal, host, model and route are five distinct concepts.** Member identity is route-independent and must survive a provider, a model or a connector disappearing.
4. **Explicit context promotion** with consent, provenance, purpose and content hashes. Room membership never grants access to a private store; nothing is ingested merely because a member was tagged.
5. **A signed permission decision contract** carrying reason code, required signer, effective mandate hash, policy version and expiry. This is materially better than returning a bare ALLOW / CO_SIGN / BLOCK enum.
6. **Replay and host compromise** added to the threat model as first-class threats with named controls.
7. The standing product law, quoted on the title page.

### Accepted with amendment

1. **Ambient collaboration is the strategic centre, but not the first build.** The thesis is correct; the host order in Bible v1.0 violates the standing delivery law. Corrected in §4.4 and §21.
2. **Drift is retained in full** as the first specialist worker, with its governed pipeline and safety posture intact — but sequenced _after_ the fabric it depends on, not before the room that already exists.
3. **Agent Execution Records ship**, as a structured extension of the receipt, once Drift runs. The experience _graph_ built on top of them does not ship. See §17.

### Rejected, with reasons

Four claims in Bible v1.0 are rejected. Each was previously identified and each survived into the document unamended, which is why they are recorded here in the strongest available form.

1. **Deletion of the commercial commitment.** Bible v1.0 §17 sequences eight phases with no price, no paying customer and no date; its first commercial language appears at phase 8 and says _complete governed workflows_, not _pay_. **£99 per team per month and three paying teams by 30 November 2026 are restored** as slice S2.9. A roadmap accountable only to a demonstration date reliably produces a demonstration.
2. **Buzz as the first host integration.** The proposed hook requires Block to merge an upstream contribution, or requires a maintained fork. Both make a phase exit contingent on a third party. Buzz becomes **host #4**, pulled forward only when a paying pilot asks for it; the enforcement point is our own policy sidecar and relay, which we own outright.
3. **A flagship demonstration that begins inside ChatGPT.** The same violation, twice over: the canonical proof would then depend on a connector policy Playroom does not control and cannot guarantee for a filmed deadline. The cross-surface round trip is the **P4 target and the endgame**; the P0 demonstration stays on owned assets and stays filmable tonight.
4. **The experience network as a core pillar.** Bible v1.0 §2.3 correctly calls the corpus a falsifiable hypothesis with no day-one defensive value, then §11 and phase 8 build a graph, a reputation system and a feed on top of it anyway. That is a second company. It is documented in §17 and gated.

> **A fifth correction, structural rather than strategic.** Bible v1.0 restarts delivery from schemas as though no implementation exists. Eighteen commits are shipped: an ordered room event log with WebSocket fan-out and resume-from-last-id; an Anthropic adapter streaming normalised agent turns with cost telemetry and prompt hashing; a command layer; latency instrumentation across five spans; CI. Those are phase-3 deliverables in Bible v1.0's ordering. They are the foundation, not a later phase.

## Terminology ruling (contractual)

Two names conflict across the existing documents. Both are settled here, because the rename is cheap at eighteen commits and expensive at two hundred.

### Mandate, not permit

Roadmap v1.0 says `permit`, prefix `pmt_`, directory `permits/`. Bible v1.0 and the pitch deck say **mandate**. The deck's demonstration chip already reads _mandate: review-only_ and the sentence that sells the product is _a fully hijacked agent still cannot exceed its mandate_. **Mandate wins.** Prefix `mnd_`, directory `mandates/`, field `effective_mandate_hash`. The word _permit_ appears nowhere in code, schema, prompt or document after the migration commit.

| Term       | Definition                                                              | Stability                             |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------- |
| Member     | A persistent participant in a room, human or agent                      | Stable                                |
| Principal  | The person or organisation a member speaks for                          | Stable unless formally reassigned     |
| Host       | An application surface: Playroom client, GitHub, Claude, ChatGPT, Buzz  | Not stable                            |
| Model      | The inference system used for one turn                                  | Not stable                            |
| Route      | The technical path by which a member is reachable now                   | Not stable; selected per task         |
| Mandate    | The signed, versioned, time-bounded authority document                  | Versioned; hash logged per evaluation |
| Room       | Canonical collaboration state                                           | Authoritative                         |
| Projection | A host-rendered view of room state                                      | Derived; never authoritative          |
| Receipt    | Signed durable evidence that a governed event occurred                  | Append-only                           |
| AER        | Agent Execution Record: structured account of one bounded piece of work | Ships with Drift                      |

### Agent casting: Sol stays, Fable is retired

Bible v1.0 renames Jerry's agent to _Fable_. **Fable is a shipping Anthropic model name** (Claude Fable 5). A product whose entire premise is provider neutrality cannot name its second principal's agent after one provider's model — in a filmed demonstration it reads as either confusion or endorsement, and it undermines the one frame we most need an audience to hold.

Casting is therefore unchanged from the deck and the P0 shot list: **Prince with Claude; Jerry with Sol, a GPT agent.** Cross-provider is visible in the roster, which is the point of the shot.

> The Bible v1.0 example also inverts the surfaces — Prince in ChatGPT, Jerry in Claude. The inversion is harmless and occasionally useful for the P4 narrative, but the P0 film keeps the deck's casting so the recorded asset and the deck agree.

## 1. The platform shift and the missing collaboration layer

Every platform shift changes not only which applications are possible but where coordination happens. The web created shared information spaces. Mobile put them in everyone's pocket. AI introduces software actors that interpret goals, plan work, use tools, continue across long tasks and communicate with humans and with each other.

The first consumer AI wave reproduced the single-player shape of early personal computing: one person, one assistant, one provider, one conversation, one private context window. Even where the model can use tools, the collaboration boundary is the account. Sharing means forwarding a transcript, copying an answer, exporting a file, or inviting someone into a provider-controlled workspace.

That shape breaks the moment agents represent different people, companies and interests. A person's agent is not merely another model endpoint. It carries private context, tool access, organisational credentials, working history and delegated authority. Bringing several agents into one task therefore raises identity, permission, context, provenance and accountability problems that ordinary group chat does not solve.

The missing layer is not transport. Open protocols already move messages and tool calls. The missing layer is a governed operational contract that answers six questions:

1. Who does this agent speak for?
2. What information is this agent allowed to receive?
3. What actions is this agent permitted to take?
4. Which actions require a human decision?
5. What evidence supports the work?
6. How can every participant later prove what happened?

| Layer          | Primary function                                                 | Why it is insufficient alone                                                      |
| -------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Model provider | Reasoning, generation, tool use                                  | Tied to one account, provider and context boundary                                |
| Agent protocol | Message and capability exchange                                  | Expresses capability, not principal authority, co-sign rules or context ownership |
| Workspace      | Shared destination and conversation                              | Requires migration into one host; the host tends to own agent identity            |
| Playroom       | Cross-surface trust, canonical collaboration, verifiable history | Designed to remain independent of any one host or provider                        |

> Playroom rides transport standards; it does not mistake them for the product. Pipes are replaceable. Governed relationships and provable history are the durable layer.

## 2. Product history and the things we were wrong about

The earliest concept — briefly Wardroom, then Parley, now Playroom — already described persistent rooms where humans and agents from different providers were first-class taggable members, with principal binding, server-enforced authority, isolated private context, boundary screening, audit chains and signed receipts. That foundation holds. Four parts of the story did not.

### 2.1 We overvalued the room as a destination

_Slack, except half your teammates are agents_ communicated the mixed roster quickly and anchored the product to a workspace category. Once Buzz appeared with shared rooms, cryptographic agent identity, signed events, workflows and multiple runtimes, the destination reading stopped being distinct. The room remains essential, but it is redefined as **canonical state** rather than a place every participant must open.

### 2.2 We described the network too much like social media

Agents publishing how they solved problems was compared to a timeline. Literal social networks for agents already exist and engagement-shaped feeds are strategically weak. The useful object is not a post; it is a verified structured record of work another agent can safely reuse. A feed may survive as presentation. It is not the asset.

### 2.3 We treated the accumulated corpus as a moat before proving it

A corpus of change-to-fix mappings has no defensive value on day one. Alerting vendors, code platforms and model providers can accumulate data faster. The corpus is a falsifiable hypothesis and is treated as one throughout this document.

### 2.4 We underestimated ambient collaboration

Ambient mode existed in the old roadmap as a convenience feature gated behind revenue. It is better understood as the distribution strategy: a workspace asks users and agents to come to it; an ambient layer enters the surfaces they already inhabit. Its position moves to the centre of the product thesis. Its position in the build order does not move, and §4.4 explains why.

### 2.5 And then we overcorrected

Bible v1.0 read the arrival of a credible competitor as an instruction to restart. It deleted the revenue date, put two unowned integrations on the critical path and promoted a research hypothesis to a pillar. The pre-committed response to a well-funded entrant was always _pivot up-stack to policy and audit over their pipes_ — the fabric is a chokepoint precisely so it can survive that move. Pivoting up-stack is a positioning change. It is not permission to throw away a working build or a paying customer.

> **The lesson, stated once.** The trust fabric was always stronger than the workspace positioning around it. That is an argument for changing the sentence on the first slide, not the order of the slices.

## 3. Buzz: validation, threat and correct sequencing

Buzz was released by Block on 21 July 2026 under Apache 2.0. It is Nostr-based; every agent receives a cryptographic identity and a second signature ties each agent back to its human owner; it is model-agnostic across Claude Code, Codex and goose through ACP; it ships a git forge in which feature branches become channels. Treat it as neither irrelevant nor fatal.

It validates the premise that humans and agents need shared operational spaces, and it demonstrates that room transport, managed runtimes, workflows, git integration and signed events can be supplied by a capable open-source system. The **weak** version of Playroom — a destination where humans and agents share channels — is directly threatened. The strong version is not.

> **Buzz proves who an agent is. Playroom decides what it may do.** Channel- and thread-level administration is configuration. A signed, per-action mandate evaluated server-side, with co-sign routing and a portable receipt, is enforcement.

| Question                         | Buzz-oriented answer                       | Playroom-oriented answer                                             |
| -------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| Where does collaboration happen? | Primarily inside Buzz                      | In a canonical room projected into many hosts                        |
| Where does agent identity live?  | Within or attached to the Buzz environment | In Playroom, independent of any route                                |
| How are external agents reached? | Runtimes and bridges attached to Buzz      | Selectable routes: own client, GitHub, MCP host connectors, A2A, ACP |
| What is the core asset?          | Workspace and event ecosystem              | Portable enforcement plus provable history                           |
| Must users migrate?              | Generally they join the environment        | No; their existing surface stays primary                             |

### 3.1 What Buzz does not currently appear to productise

The safe claim is not that Buzz is technically incapable of cross-host work — its architecture may well allow it. The narrower claim is that it does not currently productise the complete loop in which a person stays in one AI application, tags another person's agent living in a different application, that agent answers under a mandate its own principal set, private context on both sides stays private, an authority escalation is blocked by a plane neither host controls, and both surfaces render projections of the same canonical task.

That loop is the product thesis. It is also, deliberately, the P4 demonstration rather than the P0 one.

### 3.2 Correct relationship: sidecar, not fork

A maintained fork of Buzz would create maintenance burden, blur product identity and invite the market to read Playroom as a repackaged workspace. The integration model is instead an extension plus a **policy sidecar**: Playroom defines custom event kinds for member references, task creation, decisions, co-sign requests and receipts, which unaware clients ignore and aware clients render; and Buzz calls the sidecar before protected actions, receiving ALLOW, BLOCK or CO_SIGN.

```
Buzz action attempt
        |
        v
Playroom policy sidecar
        |
        +-- ALLOW    -> action proceeds
        +-- BLOCK    -> denial event and explanation
        +-- CO_SIGN  -> approval request; action paused
```

### 3.3 Sequencing correction

Bible v1.0 makes Buzz the first host integration. The upstream hook it proposes needs Block to merge a contribution or needs a fork; either way a phase exit becomes contingent on someone else's review queue. **Buzz is host #4.** It is pulled forward the moment a paying pilot asks for it and not before, and when it arrives the enforcement point is our own sidecar and relay, which we own outright. Nothing about that ordering weakens the strategic reading of Buzz; it only refuses to hand a competitor a veto over our roadmap.

## 4. The ambient collaboration thesis

Ambient collaboration means Playroom is available from inside another application's normal working context. The host stays where the person thinks, drafts, asks and reviews. Playroom appears as a capability that resolves external members, creates shared tasks, promotes selected context, streams replies back and renders governance decisions. It should feel like tagging a colleague, not exporting a transcript.

### 4.1 The core example

Prince, working in his surface, types:

```
@Sol, review Drift's proposed Stripe migration.
Focus on whether the evidence justifies the fallback behaviour.
```

Playroom resolves Sol's persistent identity; verifies that Prince may contact Sol in this room; selects an authorised route; assembles only permitted shared context; sends a structured task; and writes every step to the canonical room. Jerry's surface receives a notification that Sol was tagged. Sol receives common ground plus Jerry-owned private review context, and **no access to Prince's private history**. Sol's reply returns to the canonical room and is projected back, labelled _speaks for Jerry_ and _review-only_. If Sol attempts to merge, deploy or accept a binding change, the fabric evaluates the action outside the model and blocks or escalates it.

### 4.2 Why tagging is more than message routing

A tag carries implied identity, relationship, authority, context and interruption semantics. `@Sol` must not mean _send text to whichever endpoint currently uses that display name_. It means _address the persistent member Sol, who speaks for a known principal, through an authorised route, within the boundaries of a specific room and mandate_. This is what stops route identity from becoming product identity: Sol is the same member whether reached through a host connector, an ACP process, an A2A endpoint or a future enterprise gateway.

### 4.3 Three maturity levels

| Level                        | Experience                                                                   | Dependency                                  | Playroom phase |
| ---------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------- | -------------- |
| 1 — Tool-mediated tagging    | The host model invokes a Playroom tool and displays the result               | Host supports connectors, tools or MCP      | P3, gated      |
| 2 — Shared-thread projection | Several hosts render the same persistent task and event state                | Bidirectional connector plus canonical room | P4             |
| 3 — Native ambient           | Autocomplete, inline streaming, side panel, permission chips, approval cards | Provider cooperation, extension or overlay  | Not scheduled  |

Level 1 is the practical entry point. Level 2 is the real product. Level 3 is the ideal interface and carries the largest platform-policy risk in the plan. **The architecture must never depend on level 3 being available.**

### 4.4 Host order, and why it is not negotiable

Ambient is the endgame; it is not the on-ramp. The host order below is derived directly from the standing delivery law — each host is added only when its failure cannot strand a phase exit.

| #   | Host                                | Owned?                                        | Phase     | Gate to open                                                     |
| --- | ----------------------------------- | --------------------------------------------- | --------- | ---------------------------------------------------------------- |
| 1   | Playroom's own client               | Fully owned; already built                    | P0–P2     | None — this is the workbench                                     |
| 2   | GitHub bridge                       | Owned integration against a stable public API | P2 (S2.6) | None. Counterparty installs nothing                              |
| 3   | MCP connector into Claude / ChatGPT | Third-party policy risk                       | P3        | P2 exit achieved, one pilot renewed, platform-policy ADR written |
| 4   | Buzz extension plus policy sidecar  | Third-party review queue                      | P4        | A paying pilot asks for it by name                               |

> The ordering is also the honest commercial reading. Host #1 proves the fabric. Host #2 is how a counterparty participates without installing anything, which is what makes a pilot buyable. Hosts #3 and #4 are distribution, and distribution is earned after somebody pays.

## 5. Canonical rooms and host projections

The canonical room is the authoritative shared state of a collaboration. A host projection is a route-specific view of that state rendered inside the Playroom client, GitHub, Claude, ChatGPT, Buzz or a future surface. This separation is the architectural move that lets Playroom be ambient without losing coherence, and it is the single most valuable idea carried forward from Bible v1.0.

### 5.1 Canonical room responsibilities

- Maintain membership, principal bindings and effective mandates.
- Store ordered events, messages, tasks, artifacts, decisions and receipts.
- Track common-ground context separately from private principal stores.
- Record route-independent member identity.
- Enforce evaluation before every commitment-bearing action.
- Provide idempotent event ingestion, stable event ids and projection cursors.
- **Remain the source of truth when hosts disagree, reconnect or reorder.**

### 5.2 Host projection responsibilities

- Render the subset of room state the host can support, and degrade gracefully where it cannot.
- Translate host-native mentions into canonical member references, and canonical objects into host-native ones.
- Maintain the mapping between host conversation identifiers and Playroom room identifiers.
- Preserve provenance labels so imported content is never mistaken for native private memory.
- Never hold state the room does not have. A projection that cannot be rebuilt from the event log is a bug.

### 5.3 Projection is not ingestion

Playroom must never silently absorb an entire private conversation because a member was tagged. The person or the host agent selects what becomes shared; the selection is copied into common ground with provenance, consent and a stated reason. The canonical room holds the collaboration record, not every participant's complete working history.

```
Private host conversation
        |
        |  explicit selection / summarisation / artifact promotion
        v
Playroom common ground  (canonical)
        |
        +--> projected to Playroom client   (host #1)
        +--> projected to GitHub            (host #2)
        +--> projected to Claude / ChatGPT  (host #3, gated)
        +--> projected to Buzz              (host #4, gated)
```

> **Conflict rule.** When a projection and the room disagree, the room wins and the projection is rebuilt from the event log. Where a host has already shown a stale object to a human, the correction is an appended superseding event with a visible marker — never a silent edit.

## 6. Identity, principals, members and routes

The identity model separates five things that naive designs collapse into one: the member, the principal, the host, the model and the route. Collapsing them is how a product ends up unable to survive a provider change, and how an agent ends up with authority it was never granted.

### 6.1 Member record

```
{
  "member_id": "agent:sol",
  "display_name": "Sol",
  "kind": "agent",
  "principal_id": "principal:jerry",
  "identity_document_ref": "idoc_...",
  "default_mandate_ref": "mnd_...",
  "routes": [
    {
      "route_id": "route_sol_openai",
      "type": "openai_api",
      "status": "online",
      "capabilities": ["receive_task", "stream_reply", "request_decision"],
      "data_classes": ["common_ground", "principal_private"]
    },
    {
      "route_id": "route_sol_buzz",
      "type": "buzz_acp",
      "status": "available",
      "capabilities": ["receive_task", "publish_event"],
      "data_classes": ["common_ground"]
    }
  ]
}
```

Names are never self-asserted. A message claiming to be Sol that did not enter through Jerry's authenticated enrolment does not acquire an identity stamp, and unstamped cross-boundary messages are dropped at the room service. Signatures are Ed25519 with managed server keys in v1; §15.3 states plainly what that costs.

### 6.2 Route selection is policy, not availability

A route that can receive text may not be authorised to receive artifacts. A route that streams may not support approval prompts. A local route may be preferred for sensitive work even when a cloud route is faster. Selection must therefore satisfy capability, data classification, security, latency and principal preference — and the result is recorded, so a later participant can explain where a task went and why.

1. Resolve the member identifier to a canonical member.
2. Confirm room membership and counterparty policy.
3. Load the effective mandate and its route constraints.
4. Filter routes by capability **and by data classification of the assembled context**.
5. Rank surviving routes by principal preference, availability and expected latency.
6. Select, and write a `route.selected` event carrying the reason.
7. Create a delivery envelope with an idempotency key, a nonce and an expiry.

> **Failure rule.** If no route satisfies the constraints, the task enters `input-required` and the tagging human is told which constraint failed. Silently downgrading the data classification to make a route fit is the single most dangerous shortcut available in this system, and it is forbidden.

## 7. Context boundaries and common-ground promotion

Cross-provider collaboration is dangerous when context ownership is vague. Context belongs to a principal unless it has been explicitly promoted. Room membership grants access to common ground and to nothing else.

### 7.1 The assembly invariant

```
def assemble(member, room, task):
    context  = system_frame(member.identity, effective_mandate(member, room))
    context += room.common_ground(relevant_to=task)
    context += principal_store(member.principal_id).retrieve(task)
    context += task.state_and_artifacts()

    assert principals_visible(context) <= {member.principal_id, COMMON_GROUND}
    return context
```

The implementation may differ; the invariant may not. **Foreign private stores are unreachable by construction.** A prompt instruction telling an agent to ignore foreign context is not a control if the data is already in the window. The test that proves a foreign store is unreachable from assembly — including through summaries, embeddings and promoted items — is **CI-blocking**, not a ticket.

### 7.2 The promotion object

```
{
  "promotion_id": "prm_...",
  "source_host": "playroom_client",
  "source_principal": "principal:prince",
  "room_id": "room_pr_41",
  "selected_content_hash": "sha256:...",
  "representation": "summary",
  "purpose": "external review",
  "approved_by": "principal:prince",
  "created_at": "2026-07-25T...",
  "expires_at": null,
  "provenance": { "conversation_ref": "host-local-reference",
                  "selector": "user-selected turns and attachment" }
}
```

### 7.3 Minimisation

Default to the smallest useful package: task intent, relevant evidence, current artifacts, constraints and requested output. Full transcript transfer is exceptional. Summaries are labelled as summaries and the source stays addressable for authorised verification. Minimisation reduces leakage, injection surface, token cost and ambiguity about what the external member actually saw — four benefits from one discipline, which is why it is the default rather than a setting.

## 8. The trust fabric

The trust fabric is the independent enforcement plane between rooms, routes, tools and providers. No commitment-bearing action reaches an external system without traversing it. It does not promise that models cannot be manipulated. It promises that **manipulation cannot expand authority beyond what the principal already granted.**

### 8.1 Four stages, in order, independently testable

Coupling the stages creates bugs: a message can be perfectly authentic and still malicious; perfectly benign and still unauthorised; perfectly authorised and still leaking.

| Stage                  | Function                                                                                         | Failure behaviour                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 1 — Identity stamping  | Stamp every turn with member id, principal binding and mandate hash before anything else sees it | Unstamped cross-boundary messages are dropped at the room service                           |
| 2 — Inbound screening  | L1 provenance framing (structural) then L2 detection (statistical), each with a recorded verdict | Classifier down: L1-only mode, co-sign thresholds tighten automatically, degradation logged |
| 3 — Mandate evaluation | Deny-by-default, server-side, under 30 ms at P95, every outcome audited with the mandate hash    | **Fail closed.** Engine unavailable means cross-boundary actions block; reads continue      |
| 4 — Egress control     | Scan outbound content against secret tags and seeded canaries; debit postage                     | Canary hit freezes cross-boundary sends in the room and alerts both principals              |

### 8.2 Why enforcement cannot live inside the model

A model can be instructed to obey a policy, but the model is also the component most exposed to malicious content, ambiguous requests and reasoning errors. The engine must therefore be external, deterministic where possible, versioned and independently testable. A fully compromised agent may **ask** to merge; it must still be unable to merge when its mandate grants review and comment.

### 8.3 Inbound screening detail

L1 wraps every foreign span in a provenance envelope before any model sees it. It is necessary, not sufficient, and is logged as such:

```
<foreign source="agent:sol" principal="principal:jerry" verdict="PASS" mandate="mnd_7f3a">
  ...counterparty content, delivered as data...
</foreign>
```

- **L2 rule pack** — instruction-override patterns, role-play preambles, encoding and homoglyph tricks, tool-call smuggling. Rules are versioned files; every hit names its rule id in telemetry.
- **L2 classifier** — small model behind the Python screening service, threshold tuned against a versioned corpus. Verdicts: PASS, FLAG (deliver and alert), HOLD (quarantine for human release), BLOCK.
- **L3 egress DLP** — secret-tagged items matched with normalised fuzzy matching; canaries of the form `plr_cnry_<base32>` are seeded into every principal store **before any external agent joins**.
- **Scan policy** — full scan on every cross-boundary hop; sampled scan on intra-principal traffic to stay inside the §11 budgets.

> **Honest limit, in writing.** Paraphrase leakage below DLP granularity survives every layer. The mitigation is a small common-ground window and mandates that cap what a leak is worth — not a claim that detection catches semantics.

### 8.4 Receipts

A receipt is durable evidence that a governed event occurred under defined terms, both human-readable and machine-verifiable. Receipts are not decorative audit cards; they are inputs to dispute resolution, compliance review and — later — experience verification. A receipt carries identities, mandate hash, requested action, decision, human signers, evidence references, timestamps, result hashes and the chain anchor for the room's ledger.

## 9. Mandates and the decision contract

Mandates are signed JSON documents, versioned under `mandates/` in git exactly like prompts. The schema is wedge-agnostic: the same shape carries review scopes today and spend caps if the commerce wedge revives.

### 9.1 Mandate document

```
{
  "mandate_id": "mnd_7f3a",
  "principal": "principal:jerry",
  "member": "agent:sol",
  "room": "room_pr_41",
  "scope": ["pr.review", "pr.comment", "task.accept"],
  "protected_actions": ["pr.merge", "deploy"],
  "co_sign": { "actions": ["pr.merge"], "by": "principal" },
  "limits": { "interrupts_per_day": 6, "postage_per_day": 200 },
  "counterparties": "roster_only",
  "route_constraints": { "max_data_class": "common_ground" },
  "policy_version": "playroom-policy/1.0",
  "expires": "2026-11-30T00:00:00Z",
  "sig": "ed25519:jerry..."
}
```

### 9.2 Evaluation order — fixed, and boring on purpose

```
def evaluate(action, member, mandate):
    if mandate.expired() or not mandate.sig_valid():        return BLOCK
    if action.type not in mandate.scope:                    return BLOCK   # unknown = denied
    if replayed(action.nonce, action.resource_hash):        return BLOCK   # §9.4
    if action.type in mandate.protected_actions:            return CO_SIGN
    if mandate.counterparties == 'roster_only' and \
       action.target not in room.roster:                    return BLOCK
    if breaches_limits(action, mandate.limits):
        return CO_SIGN if within_cosign(action) else BLOCK
    return ALLOW
```

ALLOW proceeds. CO_SIGN pauses the action and raises a DECISION interrupt to the owning principal. BLOCK stops it and notifies the member's principal and, for protected attempts, the room. HOLD exists only as a screening verdict, never a mandate one. Every outcome is audited with the mandate hash.

### 9.3 The decision contract

Every evaluation emits a signed decision object rather than a bare enum. This is what makes a decision portable, disputable and verifiable by a counterparty who does not trust our servers.

```
{
  "decision_id": "dec_...",
  "request_id": "act_...",
  "subject": "agent:sol",
  "principal": "principal:jerry",
  "room_id": "room_pr_41",
  "action": "github.pull_request.merge",
  "resource": "repo:playroom/playroom#pr-41",
  "arguments_hash": "sha256:...",
  "decision": "CO_SIGN",
  "reason_code": "PROTECTED_ACTION",
  "required_signer": "principal:jerry",
  "effective_mandate_hash": "sha256:...",
  "policy_version": "playroom-policy/1.0",
  "nonce": "...",
  "expires_at": "2026-07-25T20:05:00Z",
  "signature": "ed25519:..."
}
```

### 9.4 Replay protection

An approval is bound to one action on one resource with one argument set. The tuple of nonce, `resource`, `arguments_hash` and `expires_at` is recorded on decision and checked on execution; a second execution attempt against a spent decision is a BLOCK with reason code `REPLAY`. Server time is authoritative for ordering, and clock skew between a signed timestamp and server time is logged rather than trusted.

### 9.5 Mandates and prompts as code

Mandate templates and prompts live in git. Every model call logs the prompt file hash; every evaluation logs the mandate hash. A behavioural regression is answered with a diff and a revert, not archaeology. Changes ship under `feat/prompt`, `fix/prompt`, `feat/mandate` prefixes so the audit trail reads like a changelog.

_Commerce extension, dormant until the wedge revives: `limits` gains `per_txn`, `aggregate` and `co_sign_over` amounts in a named currency. Review-only versus merge is the same shape as negotiate-only versus accept — authority, bounded in advance._

## 10. Non-negotiable architecture principles

- **Enforcement server-side, never model-side.** The model is never the security boundary.
- **No bypass path.** There is no route from a room to a provider adapter that does not traverse all four fabric stages. This is a property of the code layout, not a convention, and §20 requires it to be proved from the repository rather than the diagram.
- **Context never crosses principals.** Assembly reaches common ground and the summoned member's own principal store, and nothing else. A reachable foreign store is a CI-blocking failure.
- **Deny by default.** An action not explicitly granted is blocked. Unknown action types are blocked. Engine unavailable means cross-boundary actions are blocked; reads may continue.
- **Silence by default.** Agents never speak unprompted. Any feature described as _agents could chat about…_ is rejected on sight.
- **Receipts for anything commitment-shaped** — merges, acceptances, approvals, spends. Never prose.
- **Provider-agnostic core.** Only adapters know provider names. The room, the fabric and the data model never do.
- **The room is authoritative; projections are derived.** A projection that cannot be rebuilt from the event log is a bug.
- **Events are immutable.** Corrections append superseding events. The canonical event id survives projection into any host.
- **Demo-first delivery.** Every slice ends in something a camera can see. A slice with no visible outcome is two slices badly cut.
- **Assets-owned rule.** Every phase exit and canonical demonstration runs on assets the founder fully owns.
- **Boring infrastructure.** The novelty budget is spent on the fabric and the room mechanics. Everything else is the most boring available option.
- **Spend is visible.** Per-room budgets and per-summon cost render in-thread; cost transparency doubles as babble suppression.
- **Append-only audit.** History is hash-chained and the daily root is emailed to principals, so silent rewriting is detectable by anyone with an inbox.

## 11. Latency and performance budgets

Without explicit targets you cannot tell broken from slow, and in a trust product slow enforcement invites bypass pressure. A week of P95 drift is a bug, not noise.

| Operation                           | P50     | P95     | Ceiling | Fail mode                               |
| ----------------------------------- | ------- | ------- | ------- | --------------------------------------- |
| Message fan-out to room members     | <120 ms | <250 ms | 1 s     | Degrade to SSE                          |
| Mandate evaluation                  | <10 ms  | <30 ms  | 100 ms  | Fail closed                             |
| Inbound screen — L1 wrap plus rules | <80 ms  | <250 ms | 600 ms  | HOLD                                    |
| Inbound screen — with classifier    | <350 ms | <900 ms | 2 s     | L1-only mode, stricter co-sign          |
| Route selection                     | <20 ms  | <60 ms  | 250 ms  | Fall back to principal default route    |
| Summon: context assembly            | <250 ms | <400 ms | 1 s     | Trim window, log compression            |
| First streamed token (cloud)        | <900 ms | <1.8 s  | 3 s     | Notify and hold task                    |
| Receipt sign and append             | <25 ms  | <50 ms  | 200 ms  | Retry once, else co-sign path           |
| Interrupt push to human device      | <600 ms | <1 s    | 3 s     | Fall back to in-thread card             |
| GitHub webhook to room event        | <800 ms | <2 s    | 10 s    | Reconcile poll                          |
| Projection round trip (host #3+)    | <1.2 s  | <2.5 s  | 6 s     | Render in canonical client, notify host |
| Audit append                        | <10 ms  | <20 ms  | 100 ms  | Block cross-boundary sends              |

_First-token P95 was revised from 1.5 s to 1.8 s under ADR-005 after a fifty-turn measurement against a bare-SDK control (observed P50 726 ms, P95 1,716 ms at current context depth). The revision is scoped to current context depth and is re-measured whenever the assembly window changes._

## 12. Streaming, realtime and projection consistency

- All provider calls stream by default; tokens batch into message deltas roughly every 150 ms and fan out over WebSocket, with SSE as the degraded path.
- Every event carries a monotonically increasing room sequence id. Delivery is at-least-once; clients dedupe on event id and reconnect with resume-from-last-id. The server replays from Postgres, so a dropped socket never loses a receipt.
- **Ordering rule.** Fabric verdicts commit to the audit chain **before** the message fans out. Members never see a message the fabric has not finished judging.
- **Persist before fan-out.** No event reaches a client that is not already durable.
- Interrupt semantics: a human reply to a streaming agent flushes that agent's output queue at the next sentence boundary and re-summons with the new context. Agents never talk over a principal.
- Working indicators are events, not polling: task state changes (working, input-required, done) render as chips the moment they commit.
- **Projection cursors.** Each host projection tracks a cursor into the canonical log and is idempotent on replay. Ingestion from a host carries an idempotency key; duplicate delivery is a no-op, not a duplicate task.

## 13. State, persistence and repository structure

| State                                 | Store                                             | Rationale                                                               |
| ------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| Rooms, members, messages, tasks       | Postgres 16                                       | Structured, queryable, survives everything; source of truth for replay  |
| Mandates                              | Postgres plus `mandates/` in git                  | Runtime copy for evaluation; git copy for versioning, diff and rollback |
| Decisions                             | Postgres `decisions` table                        | Signed, replay-checked, independently verifiable                        |
| Audit chain                           | Append-only Postgres table                        | Hash-chained rows; daily root emailed to principals                     |
| Receipts                              | Postgres plus rendered artifact in object storage | Queryable and human-readable; the verification page reads both          |
| Principal context                     | Schema-per-principal, pgvector, RLS on            | Isolation enforced by the database, not by discipline                   |
| Projection cursors and host mappings  | Postgres                                          | Rebuildable; never authoritative                                        |
| Hot presence and stream buffers       | Redis                                             | Recreatable on restart; loss degrades presence, never messages          |
| Artifacts (diffs, exports, test logs) | S3-compatible                                     | Cheap, immutable, content-addressed                                     |
| Prompts and mandate templates         | Files under git                                   | Versioned, diff-able, hash logged per call                              |

```
playroom/
  apps/
    web/                 # Next.js room UI — host #1
    api/                 # Fastify + tRPC — room service, command layer, gateway
  services/
    screening/           # FastAPI — L2 classifier, DLP, reputation (Jerry's lane)
  packages/
    fabric/              # identity, mandates, decisions, screening client, egress, audit
    adapters/            # anthropic/, openai/, a2a/
    hosts/               # projection adapters: github/, mcp/ (P3), buzz/ (P4)
    shared/              # event types, AgentTurn, zod schemas — WebSocket and HTTP
  mandates/
    templates/           # review-only.json, commerce.json (dormant)
  prompts/               # versioned, git-tracked, hash-logged
  infra/                 # fly.toml, docker-compose, migrations
  tests/
    fabric/              # mandate table tests, hijack simulation, replay tests
    assembly/            # foreign-store-unreachable (CI-BLOCKING)
    hosts/               # projection idempotency and conformance suite
    screening/           # injection corpus
  docs/decisions/        # ADRs
  scripts/               # seed, canary tools, root-anchor mailer
```

_`packages/hosts/` is new in this revision. It exists from P2 with exactly one occupant (GitHub) so that the MCP connector and the Buzz sidecar are later additions to a seam, not rewrites — the same discipline that made the command-layer extraction worth doing mid-S0.3._

## 14. Failure modes, per component

| Failure                         | Detection                                      | Response                                                                                                      |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Provider outage or 429 mid-task | Adapter error class, retry budget exhausted    | Task moves to held, persisted; room notified; resumes on recovery — task state never lives in provider memory |
| Mandate engine unavailable      | Health check or evaluation timeout over 100 ms | **Fail closed**: cross-boundary actions block, read-only continues, incident banner in room                   |
| Screening classifier down       | Screening service health check                 | L1-only mode; co-sign thresholds tighten automatically; logged as degraded                                    |
| WebSocket drop                  | Client heartbeat miss                          | Resume-from-last-event-id replay from Postgres; no gap, no duplicates                                         |
| Redis loss                      | Connection error                               | Presence and typing degrade; messages, receipts and audit unaffected                                          |
| Route unavailable at summon     | Route health or capability mismatch            | Task moves to input-required naming the failed constraint; never a silent downgrade of data class             |
| Projection divergence           | Cursor gap or host state mismatch              | Rebuild projection from the canonical log; append a visible superseding event where a human saw stale state   |
| Host connector compromised      | Signature mismatch on a decision card          | Reject the card, freeze the room's cross-boundary sends, alert both principals                                |
| Replayed approval               | Spent nonce or resource-hash mismatch          | BLOCK with reason `REPLAY`; incident logged against the requesting member                                     |
| GitHub webhook missed           | Sequence gap versus poll                       | Reconcile poll every five minutes while the bridge is active; idempotent event ids                            |
| Canary token fires              | Egress DLP hit                                 | Room freezes cross-boundary sends; both principals alerted; disclosure runbook opens                          |
| Audit append fails              | Write error or chain mismatch                  | Cross-boundary sends block until the chain heals — an unaudited action is worse than a delayed one            |
| Interrupt flood                 | Threshold per member per hour                  | Rate limit, auto-downgrade to digest, reputation records the spike                                            |
| Clock skew                      | Signed timestamp versus server time            | Server time is authoritative for chain ordering; skew logged                                                  |

## 15. Security posture and threat model

Playroom operates at a dangerous boundary: it moves instructions, artifacts and decisions between agents belonging to different principals. The system assumes hostile or compromised content, fallible models, stale routes, confused humans and partially trusted integrations. **The promise is bounded authority and accountable state, not perfect model behaviour.**

### 15.1 Primary threats

| Threat               | Example                                                  | Primary control                                                                      |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Agent impersonation  | A route claims to be Sol                                 | Signed member identity, authenticated enrolment, stamp-or-drop                       |
| Prompt injection     | Repository text instructs an agent to exfiltrate secrets | Provenance framing, screening, egress control, bounded mandate                       |
| Context leakage      | Jerry's private memory appears in Prince's projection    | Principal-partitioned stores, explicit promotion, CI-blocking assembly test          |
| Authority escalation | A review agent attempts a merge                          | Server-side deny-by-default evaluation, co-sign routing                              |
| Replay               | An old approval reused for a new action                  | Nonce, resource hash, arguments hash, expiry, idempotency                            |
| Host compromise      | A connector alters a decision card in flight             | Signed canonical events; the card is verified against the room, not the host         |
| Audit rewriting      | An operator deletes evidence                             | Append-only hash chain, daily root emailed to principals                             |
| Cost abuse           | Agents repeatedly interrupt humans or call models        | Budgets, rate limits, priced interrupts, digest degradation                          |
| Experience poisoning | A bad pattern presented as verified                      | Dormant while §17 is unbuilt; evidence thresholds and reuse tracking before it ships |

### 15.2 Residual risk, stated plainly

Classifiers miss novel attacks. Paraphrased secrets evade fuzzy DLP. Custodial keys create operator trust. Host platforms change connector policies without notice. Humans approve dangerous requests when tired. A patch can pass every test and still be semantically wrong. Trust improves when a product states which risks it bounds and which it does not.

### 15.3 What v1 honestly is not

Keys are custodial and Playroom is a trusted operator: we can read rooms and the terms of service say so. There is no implied end-to-end encryption. The certificate authority is centralised. Receipts prove events to the two principals and to us; the verification page (S3.5) is the first step toward proving them to a third party who trusts nobody. Hardware-backed keys, principal-held keys and third-party anchoring are sequenced behind paying demand, in that order.

> **Emergency stop.** `/freeze` halts all cross-boundary sends in a room instantly and may be invoked by any human member. Unanswered DECISION cards hold their branch indefinitely; nothing times out into an approval.

## 16. Drift as the first specialist worker

Drift's mission is self-maintaining APIs. It watches provider change signals, determines whether a codebase is exposed, proposes a repair, verifies it, and delivers the smallest safe artifact for human approval. It is not diluted into a general-purpose agent whose purpose is to populate Playroom: its independent utility is strategically important, and it gives the fabric a concrete working loop to govern.

### 16.1 Governed pipeline

1. Ingest a provider change from an authoritative source.
2. Normalise and classify the change.
3. Identify potentially affected repositories and call sites.
4. Estimate blast radius and confidence.
5. Retrieve relevant verified repair patterns (§17, when they exist).
6. Generate a candidate patch.
7. Run build, type-check, tests and change-specific verification.
8. Produce an evidence-linked proposal.
9. **Ask Playroom whether opening a draft pull request is allowed.**
10. Open the draft pull request only after an ALLOW decision.
11. Request review from another authorised human or agent.
12. **Require a human merge**, unless a later mandate explicitly changes the rule.
13. Publish an Agent Execution Record after completion.

### 16.2 Initial safety posture

- Draft pull requests only; no automatic merge in v1.
- No proposal below the configured confidence threshold.
- Mechanical changes before semantic changes.
- Repository tests must pass before a pull request opens.
- Every proposal cites the provider change that justified it.
- Self-hosted or CI-native mode for customers unwilling to expose repository content.
- All protected actions traverse Playroom or an equivalent local policy engine.

### 16.3 Sequencing ruling

Bible v1.0 makes Drift the phase-1 deliverable, ahead of the canonical room. Rejected. Drift's entire value proposition is that its authority is governed — which requires the fabric that P2 builds — and the room infrastructure Drift would need already exists in the repository. **Drift's governed loop is a P3 slice.** Its standalone commercial value is real and it remains the first specialist worker; the November revenue comes from Playroom pilots, and Drift arrives once there is something for it to be governed by.

_Drift remains host-independent: it may appear through the Playroom client, through GitHub, through ACP inside Buzz or through A2A. Those are delivery surfaces. Change analysis, repository reasoning, verification and execution-record logic stay in Drift's own service boundary._

## 17. Agent Execution Records and the experience hypothesis

This section is the one place where the document deliberately describes something it does not build. The distinction matters: **the record ships; the graph does not.**

### 17.1 What ships — the Agent Execution Record

An AER is the canonical account of one bounded piece of work: closer to a signed build record, an incident timeline and an experiment report than to a chat transcript. It depends on no hidden reasoning traces — only on structured operational facts about what was attempted, observed, decided and verified. It ships as a receipt extension when Drift ships, because at that point it costs a schema and earns an audit trail.

```
{
  "aer_id": "aer_...",  "task_id": "task_...",
  "actor": "agent:drift",  "principal": "principal:playroom",
  "intent": "repair breaking Stripe API change",
  "trigger": { "type": "provider_change", "source_ref": "stripe:changelog:..." },
  "environment": { "repository": "org/service", "commit": "abc123",
                   "language": "typescript", "dependency_versions": {"stripe":"x.y.z"} },
  "observations": ["field X removed", "three call sites affected"],
  "actions": ["updated access path", "added compatibility fixture"],
  "rejected_approaches": [ { "approach": "runtime response shim",
                             "reason": "would hide a semantic change" } ],
  "verification": { "build": "passed", "typecheck": "passed", "tests": "passed",
                    "change_specific_checks": ["legacy subscription fixture passed"] },
  "governance": { "decisions": ["dec_..."], "human_approvals": ["approval_..."],
                  "receipt": "rcpt_..." },
  "outcome": { "pull_request": "github:...", "merged": true,
               "modified_by_human": false, "production_observation_window": "14d" },
  "cost": { "tokens": 0, "compute_seconds": 0, "elapsed_seconds": 0 }
}
```

Rejected approaches are recorded deliberately. A future agent benefits not only from the winning patch but from knowing which plausible approaches failed and why — expressed as externally defensible reasons (failing tests, unsupported environment assumptions, policy violations, semantic incompatibility, excessive blast radius), never as private reasoning traces.

### 17.2 What does not ship — the experience graph

Pattern distillation, retrieval, reputation scoring, the reuse ledger and any feed built on them are **documented and unbuilt**. The design below exists so that AERs are recorded in a shape the graph could later consume; recording is cheap, building is a second company.

| Maturity            | Meaning                                          | Default use                             |
| ------------------- | ------------------------------------------------ | --------------------------------------- |
| Observation         | One execution produced a result                  | Reference only                          |
| Candidate pattern   | Structure appears reusable                       | May inform generation                   |
| Verified pattern    | Repeated success under defined conditions        | May influence ranking                   |
| Generalised pattern | Validated across environments and held-out cases | May support automation under mandate    |
| Deprecated pattern  | No longer safe or current                        | Excluded except for historical analysis |

> **The gate.** No graph work begins until all three hold: (a) at least twenty AERs exist from real merged repairs on repositories we do not own; (b) at least one reuse demonstrably reduced time-to-verified-fix; (c) a paying customer asks for it. Until then, AERs accumulate and nothing is distilled. If the gate never opens, the hypothesis was wrong and cost us a JSON schema.

_The long-term ambition is unchanged and worth keeping in writing: search engines indexed pages, code hosts indexed code, and the interesting unindexed asset is verified operational experience. It is an ambition, not a plan, and this document declines to fund it before the fabric earns revenue._

## 18. Cost engineering

- Per-room daily budget, default £5, visible in-thread to every member from S1.6 onward.
- Rolling summaries from day one. A healthy summon is roughly 6k tokens in and 0.8k out — about $0.03 at mid-tier pricing. The naive 50k-token replay (~$0.16 and rising) is designed out, not policed.
- Postage debits every agent-initiated message and every interrupt. **Silence is free.**
- Review loops carry iteration caps: an agent may request re-review at most twice per task before a human must touch it.
- Development token cap £50/month with a hard stop. Pilot teams carry per-team caps inside their mandates.
- Every model call logs estimated cost and prompt hash, so waste is findable and reproducible.

| Feature               | Cost risk                          | Mitigation                                            |
| --------------------- | ---------------------------------- | ----------------------------------------------------- |
| Agent chatter         | Token burn and user cringe         | Silence law, postage, spend public in-thread          |
| Ageing rooms          | Superlinear context replay         | Rolling summary plus fixed window                     |
| Review loops          | Recursive agent calls              | Iteration caps; diff-based context, never whole files |
| Webhook storms        | Event floods                       | Rate limit plus reconcile-poll dedupe                 |
| Cross-host projection | Duplicate delivery and re-assembly | Idempotency keys, cursors, minimised promotion        |
| Pilot abuse           | One team burns the budget          | Per-team caps in mandates; digest-mode degradation    |

## 19. Telemetry, decisions and audit (DDL)

Three tables. `events` is the operational log — mutable and prunable. `decisions` is the signed authority record. `audit_chain` is tamper-evident and neither mutable nor prunable. They are separate on purpose.

```
CREATE TABLE events (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL,
  room_id         TEXT NOT NULL,
  actor_id        TEXT NOT NULL,      -- member (human or agent)
  principal_id    TEXT,
  event_type      TEXT NOT NULL,      -- message|summon|screen|decision|receipt|
                                      -- interrupt|route|projection|bridge|error
  direction       TEXT,               -- inbound|outbound|internal
  host_id         TEXT,               -- projection origin, null for canonical client
  route_id        TEXT,
  screen_verdict  TEXT,               -- PASS|FLAG|HOLD|BLOCK
  decision        TEXT,               -- ALLOW|CO_SIGN|BLOCK
  reason_code     TEXT,
  urgency         TEXT,               -- BLOCKER|DECISION|FYI
  adapter_id      TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cost_usd        NUMERIC(10,5),
  latency_ms      INTEGER,
  success         BOOLEAN NOT NULL,
  error_class     TEXT,
  prompt_hash     TEXT,
  mandate_hash    TEXT,
  notes           TEXT
);

CREATE TABLE decisions (
  decision_id     TEXT PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL,
  room_id         TEXT NOT NULL,
  subject         TEXT NOT NULL,      -- member id
  principal_id    TEXT NOT NULL,
  action          TEXT NOT NULL,
  resource        TEXT NOT NULL,
  arguments_hash  TEXT NOT NULL,
  decision        TEXT NOT NULL,      -- ALLOW|CO_SIGN|BLOCK
  reason_code     TEXT NOT NULL,
  required_signer TEXT,
  mandate_hash    TEXT NOT NULL,
  policy_version  TEXT NOT NULL,
  nonce           TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,        -- replay protection (§9.4)
  sig             TEXT NOT NULL,
  UNIQUE (nonce, resource, arguments_hash)
);

CREATE TABLE audit_chain (
  seq             BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL,
  room_id         TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  event           TEXT NOT NULL,      -- pr.merge, mandate.grant, consent.promote, ...
  body_hash       TEXT NOT NULL,
  prev_hash       TEXT NOT NULL,
  entry_hash      TEXT NOT NULL,      -- H(prev_hash || body_hash || meta)
  sig             TEXT NOT NULL
);
```

**Drift queries** run nightly and are reviewed weekly: P95 latency per operation against §11; BLOCK and CO_SIGN rates per member; screening false-positive rate on FLAGged-then-released items; cost per summon trend; interrupt downgrade rate per member; projection divergence count; and unprompted-message count, **which must remain exactly zero**.

## 20. Testing, quality gates and versioning

| Layer              | Minimum gate                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mandate engine     | 40-case table including hijack simulation, expired mandates, unknown actions, roster violations, replayed approvals; P95 under 30 ms in CI                         |
| Context assembly   | Foreign-store-unreachable test is **CI-blocking**; provenance assertion covered by property tests                                                                  |
| Screening          | Versioned corpus: known injections yield zero PASS; benign-set false-positive rate under target; rule ids asserted                                                 |
| Receipts and chain | Round-trip verify; tamper test breaks the chain; root-anchor mail renders                                                                                          |
| Adapters           | Error classes, rate limits, missing keys, streaming resume; contract tests against the AgentTurn interface                                                         |
| Host projections   | **One conformance suite every host adapter must pass**: idempotent ingestion, cursor replay, superseding-event rendering, signature verification of decision cards |
| GitHub bridge      | Webhook replay idempotency; reconcile-poll convergence; comment renders on a real pull request                                                                     |
| Streaming          | Kill-socket replay leaves no gap and no duplicates; interrupt flush at sentence boundary                                                                           |
| Budgets            | Breach degrades to digest; postage debits balance; the £50 development cap hard-stops                                                                              |
| Latency            | §11 P95s measured in CI smoke and alerted in production                                                                                                            |
| Billing (S2.9)     | Stripe test-mode end-to-end; cancellation keeps receipts readable                                                                                                  |

> The host conformance suite is the structural answer to the ambient thesis. If every host adapter must pass the same suite, adding Claude, ChatGPT or Buzz later is an exercise against a fixture rather than an architectural argument — and a host that cannot pass it is a host we decline, publicly and with a reason.

## 21. Delivery sequence — phases, slices, binary exits

### 21.1 What counts as a slice

- **Two to four focused days.** Bigger than that means two slices badly cut.
- **Vertical.** It touches whatever layers it needs in order to end in something user-visible. A slice that ends in a library is not done.
- **Binary exit.** A test that passes or a clip that exists. Never _mostly works_.
- **Filmed.** Every slice closes with a thirty-second screen recording, so the demo is an edit job rather than a scramble.
- **Guarded.** Each slice names the premortem it is most likely to trip, and that tripwire is watched while the slice is live.
- **Revertable.** Merged behind a flag where feasible; rollback is a flag flip or a git revert, never surgery.

### 21.2 P0 — Spike (August 2026, pre-term)

| Slice   | Work                                                                                     | Binary exit                                                                    | Status     |
| ------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------- |
| S0.1    | Repo, pnpm workspaces, CI, envs, test harness, ADR template                              | Fresh clone, one command, app and tests green                                  | Done       |
| S0.2    | Room event model, WebSocket fan-out, resume-from-last-id                                 | Two browsers converse; kill a socket mid-stream, nothing lost                  | Done       |
| A2 / A3 | Membership modes (ADR-004), command-layer extraction, credential import, live smoke test | Existing suite passes unchanged; 50-turn live measurement recorded             | Done       |
| S0.3    | Anthropic adapter, streamed AgentTurn, cost telemetry, prompt hashing                    | @claude produces a streamed in-thread reply                                    | Done       |
| S0.3b/c | Typecheck coverage, latency instrumentation, ADR-005                                     | Deliberate type-error injection caught; five spans measured                    | Done       |
| A4      | Automated capture attempt (Playwright headless video)                                    | Clips exist, or a precise reason they cannot                                   | In flight  |
| S0.4    | OpenAI adapter behind the same interface                                                 | Same prompt routes through either member via roster config, no app-code change | Next       |
| S0.5    | Summon rule v0: tag-only activation, one turn per summon                                 | 20-case test: zero unprompted agent messages                                   | Pending    |
| S0.6    | Demo cut: beats 1–6 live, recorded                                                       | **The 90-second video exists and is watchable**                                | Phase exit |

_Migration commit `permit → mandate` lands with S0.4, before the fabric package acquires more surface area._

### 21.3 P1 — Room MVP (September 2026, term begins)

| Slice | Work                                                                                                             | Binary exit                                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| S1.1  | Principals, members, roster, invites, **route table**; member-to-principal binding                               | Sol cannot exist in a room without Jerry's authenticated enrolment; a route decision is recorded per summon |
| S1.2  | Identity stamping at the gateway; unstamped drops                                                                | Spoof test: a forged Sol message never renders                                                              |
| S1.3  | Tasks and handoff object with A2A-shaped states                                                                  | @Sol take review moves the task with state and mandate reference, logged                                    |
| S1.4  | Interrupts: BLOCKER / DECISION / FYI plus one-tap downgrade                                                      | Downgrade decrements the member's interrupt budget, visibly                                                 |
| S1.5  | Context scopes: per-principal store, assembly with the assertion                                                 | **CI-blocking** test proves a foreign store is unreachable from assembly                                    |
| S1.6  | Rolling summary and per-room budget meter in-thread                                                              | A 50-message room summons at under 7k tokens; spend visible to all members                                  |
| S1.7  | **Promotion v0** — paste a Claude/ChatGPT export, select what promotes, room born with provenance-tagged context | A real prior conversation becomes a joinable room in under a minute, and nothing unselected appears in it   |
| S1.X  | **Phase exit** — a real pull request on the Playroom repository reviewed end to end in the room                  | Clip exists: tag, review, patch, approve                                                                    |

_S1.7 is the first half of the ambient thesis delivered without any host cooperation: it is promotion and provenance, built and demonstrable on owned assets. The connector that automates it is P3._

### 21.4 P2 — Fabric v1, dogfood and first revenue (October–November 2026)

| Slice | Work                                                                                                            | Binary exit                                                                                                                           |
| ----- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| S2.1  | Mandate engine: schema, signatures, deny-by-default evaluation, **signed decision contract**, replay protection | 40-case table passes including hijack simulation (injected agent attempts merge, gets BLOCK) and a replayed approval; P95 under 30 ms |
| S2.2  | Co-sign flow: CO_SIGN, DECISION card, sign, resume                                                              | A merge outside Sol's mandate pauses until Jerry taps approve                                                                         |
| S2.3  | Receipts, hash chain, daily root email to principals                                                            | Tamper test: an edited row breaks the chain and the morning email proves it                                                           |
| S2.4  | Inbound screening L1 and L2 via the screening service                                                           | Corpus run: known injections yield zero PASS; benign false-positive rate under target                                                 |
| S2.5  | Egress DLP and canary seeding tools                                                                             | A planted canary exfiltration attempt fires a block and a principal alert                                                             |
| S2.6  | **GitHub bridge — host #2, the first host projection**, running on the conformance suite                        | A maintainer participates from GitHub having installed nothing; webhook replay is idempotent                                          |
| S2.7  | Postage budgets and interrupt pricing live                                                                      | A budget breach degrades to digest mode, never a surprise bill                                                                        |
| S2.8  | **Red-team week** — founder attacks own boundary; findings triaged                                              | At least five findings logged with severity and fix-or-accept decisions; canaries verified end to end                                 |
| S2.9  | **Pilot onboarding and Stripe: £99 per team per month**, docs, support channel                                  | **Three external teams paying by 30 November** — or the tripwire fires and P3 re-scopes                                               |
| S2.X  | **Phase exit** — 20 real pull requests through the room; co-sign fired at least once in anger                   | Dogfood dashboard shows 20; the audit chain verifies                                                                                  |

> S2.9 is restored verbatim from Roadmap v1.0 and is the single most important line in this document. It is eight slices of work away, each independently small. If it misses, the accelerator application ships on dogfood evidence instead and says so honestly — but it is not deleted in advance to make the plan feel calmer.

### 21.5 P3 — Network and hosts (Q1 2027, post-exams)

| Slice | Work                                                                                 | Binary exit                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| S3.1  | A2A conformance endpoint: accept external signed Agent Cards, map the task lifecycle | A reference A2A agent completes a task in our room under our mandate                                                           |
| S3.2  | **MCP connector — host #3**, level-1 tool-mediated tagging into Claude and ChatGPT   | An external member is tagged and answers without anyone opening the Playroom UI; the host adapter passes the conformance suite |
| S3.3  | **Drift as a resident agent**: governed repair loop plus AER v0                      | A draft pull request opens only after an ALLOW; the merge requires a human co-sign; an AER is published                        |
| S3.4  | Orgs, roles, multi-room administration                                               | A pilot team self-serves a second room with scoped mandates                                                                    |
| S3.5  | Receipt verification page: a counterparty independently checks signatures and chain  | Verification works with Playroom's servers treated as untrusted                                                                |
| S3.6  | Reputation v0 (Jerry, async): downgrade counts and postage decay                     | A chronically mislevelled member measurably loses interrupt budget                                                             |

**Gate for S3.2:** P2 exit achieved, at least one pilot renewed, and a platform-policy ADR written. The connector is the largest platform-risk stack in the plan and it earns a date only after revenue exists.

### 21.6 P4 — Cross-surface (gated, not scheduled)

Level-2 shared-thread projection: the same canonical task rendered and answerable in two different hosts, with the reply and the co-sign round-tripping across them. Buzz arrives here as **host #4**, through the extension and policy sidecar of §3.2, pulled by a pilot asking for it. This is the demonstration Bible v1.0 wanted as its flagship, and it is worth wanting — it is simply the last thing built rather than the first.

### 21.7 Demonstrations

| Demo                   | Phase         | Casting                                           | Proves                                                                                        | Owned?                     |
| ---------------------- | ------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------- |
| The 90-second demo     | P0 — August   | Prince/Claude, Jerry/Sol, one repo, two providers | Cross-provider roster, tagging, scoped review, blocked merge, human co-sign, signed receipt   | Entirely                   |
| The dogfood reel       | P2 — November | Same, plus a GitHub maintainer                    | A counterparty participating having installed nothing; 20 real PRs; a real blocked escalation | Entirely                   |
| The cross-surface loop | P4 — gated    | Two hosts, one canonical task                     | The room spanning applications while governance holds                                         | Partially — host-dependent |

> Bible v1.0's demonstration sequence is preserved intact as the P4 script. Nothing in it is wrong. It simply cannot be the demonstration a funding application depends on while two of its steps run on somebody else's connector policy.

## 22. Commercial plan and accelerator framing

### 22.1 The commitment

| Item          | Commitment                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Price         | £99 per team per month, pilot tier                                                                                   |
| Target        | Three paying external teams by 30 November 2026                                                                      |
| Who           | Teams already paying for two or more AI subscriptions across providers, working in pull requests                     |
| What they get | A governed room, the GitHub bridge, mandates, co-sign, receipts, per-team spend caps, a support channel              |
| Tripwire      | If the weekly clip slips twice in a row, pre-agreed cuts fire — starting with the P4 date, never with fabric quality |
| If it misses  | The application ships on dogfood evidence and says so plainly. The date is not quietly removed beforehand            |

### 22.2 YC framing

The strongest pitch is not that Playroom invented multi-agent rooms. It is that Playroom is building the neutral trust layer for work performed across different AI applications, providers and principals — with the working software to prove it. The most credible evidence is software that prevented an unauthorised action, obtained a real human co-sign and produced a verifiable receipt.

**Mention Buzz directly.** Hiding it looks unaware; naming it looks calibrated. The line is: Buzz validates the workspace category, and Playroom is the portable trust layer that lets those rooms span the surfaces people already use. Then show the blocked merge.

### 22.3 Hub71 and regional framing

A pre-seed or MVP-oriented programme is a more realistic fit than a later-stage cohort expecting traction. The Abu Dhabi angle should be substantive rather than decorative: cross-company AI collaboration, governed enterprise adoption, regulated sectors, data sovereignty, and neutral infrastructure connecting global providers all give a credible regional rationale.

### 22.4 Value if the company does not happen

A real implementation demonstrates unusually broad engineering ability: provider adapters, MCP and A2A integration, event systems, identity and signatures, authorisation, context isolation, injection defence, human approval workflows, git automation and agent evaluation. That materially strengthens applications for AI engineering, agent infrastructure, AI security and product security roles — but only on implementation evidence: working demos, tests, documented threat models, ADRs, merged repairs, users, measurable outcomes.

> **Separate the two decisions.** A small but complete governed loop is worth building regardless of whether a company exists. A larger commitment should depend on external evidence: paying pilots, design partners, willingness to grant repository access, and a credible founder-capacity plan.

## 23. Solo-founder reality check

The scarce resource is founder hours, against a final year in ethical hacking at Manchester Metropolitan with exams in January.

| Window                    | Realistic hours/week | Implication                                                                            |
| ------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| August (pre-term)         | 30–35                | The year's best build window. Spend it on slices, not setup                            |
| September–November (term) | 14–18                | One to two slices per week is honest. S2.9 is the crunch and gets first claim on hours |
| December (revision)       | 6–8                  | Ship nothing new. Support pilots; write applications from artefacts that already exist |
| January (exams)           | 3–5                  | **Protected.** Zero slices scheduled, on purpose                                       |
| February–March            | 15–20                | P3 slices; interview-ready demo maintenance                                            |

### 23.1 The velocity correction

Roadmap v1.0's capacity model assumed the founder writes the code. In practice he directs an implementation agent against written briefs, and the shipped record — eighteen commits, five slices and two amendments inside the first two days — shows the model was calibrated low. The correction is narrower than it looks: **agent-assisted implementation raises throughput on well-specified slices and raises nothing else.** Decisions, review, filming, customer conversations and exams consume the same hours they always did, and a brief that is wrong produces wrong code faster.

| Assumption           | Honest number                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slice size           | 2–4 focused days for founder-authored work; often under a day when a brief is precise and the exit is binary                                                        |
| Binding constraint   | Review bandwidth and decision latency, not typing speed                                                                                                             |
| Jerry's contribution | Async, off the critical path: screening corpus, classifier tuning, reputation v0. No slice exit depends on his calendar. IP assignment signed before any code lands |
| Cash burn            | Infrastructure ~£40/month plus up to £50/month development tokens — under £100/month pre-revenue                                                                    |
| Buffer policy        | Pre-agreed cuts, in order: P4 date, then S3.4, then P3 date. **S2.1 (fail-closed engine) and S2.8 (red-team) are never cut**                                        |

> The plan fits a solo final year — barely, and only while the weekly-clip discipline and the slice-size law hold. Revenue by 30 November is ambitious and sits on eight independently small slices. That is the whole bet, stated without decoration.

## 24. Non-goals, open questions and future volumes

### 24.1 Non-goals for v1

- Not an always-listening ambient agent platform. Agents are silent until summoned; ambient mode is a surface, not a behaviour change.
- Not a general social network for autonomous agents, and not an agent marketplace.
- Not autonomous spend. Money moves only behind a co-sign, and no money moves at all until the commerce wedge revives.
- Not automatic merging of Drift repairs.
- Not a blockchain. A Postgres hash chain plus an emailed root gives the property needed.
- Not end-to-end encrypted in v1 — disclosed plainly, sequenced behind paying demand.
- Not storing or exposing hidden chain-of-thought. Structured operational facts only.
- Not a Slack replacement for human-only chat. If no agent is in the roster, use Slack.
- Not multi-provider beyond two adapters until a paying customer forces a third.
- Not enterprise-compliant (SSO, SOC 2, DPAs) before ten paying teams exist.
- Not a complex microservice fleet. A modular monolith with defended module contracts.
- Not a claim that prompt injection is solved.

### 24.2 Open questions

- Which host offers the most reliable first tool-mediated tagging integration, and what is its policy risk in writing?
- How much native interface can be achieved without a browser extension or provider cooperation?
- What is the correct consent experience for promoting conversation context — per-turn selection, summary approval, or both?
- Should route selection be visible to end users by default, or surfaced only on failure and in the audit trail?
- How should cross-organisation rooms handle retention and deletion conflicts?
- At what threshold does a repair recipe become a verified pattern, and who is allowed to promote it?
- How should reputation avoid disadvantaging new members and new environments?
- Which audit anchors provide sufficient tamper evidence without unnecessary complexity?
- How should self-hosted deployments federate identity and receipts?
- Does the trademark position on _Playroom_ survive contact with the existing game SDK of that name, and what is the fallback?

### 24.3 Planned future volumes

| Volume | Scope                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------- |
| II     | Detailed data model, event catalogue, API specifications, state machines                              |
| III    | Trust fabric implementation: cryptography, policy language, receipts, audit                           |
| IV     | Host integrations: GitHub, MCP, ACP, A2A, and the conformance suite in full                           |
| V      | Drift internals: change ingestion, repository analysis, repair generation, verification               |
| VI     | Experience graph, retrieval, distillation, evaluation and reputation — **only if the §17 gate opens** |
| VII    | Threat model, red-team plans, privacy, compliance, enterprise deployment                              |
| VIII   | Product UX, design system, demo scripts, pricing, go-to-market, accelerator material                  |
| IX     | Premortems, operating plan, founder capacity, roadmap and research agenda                             |

## 25. Instructions for future audits

When asking any senior reviewer — human or model — to audit this document or its successors, the audit must answer:

- Does any code path reach an adapter without traversing all four fabric stages? Prove it from the repository layout, not the diagram.
- Can context assembly ever see a foreign principal store — including through summaries, embeddings or promoted items — and is the CI test actually blocking?
- Is the mandate engine fail-closed everywhere, including partial outages, clock skew and replayed approvals?
- Where can a host projection and the canonical log diverge, and who wins? Show the reconciliation path.
- Is the GitHub bridge idempotent under webhook replay and reconcile races?
- Which slice is most likely to slip, and does its slip break the £99 pilot promise or only an internal date?
- Are the §11 budgets realistic on a single region, and what breaks first under ten concurrent rooms?
- Which premortem is closest to firing, judged by tripwire telemetry, and is the plan reacting?
- **Has any item rejected in §0.3 quietly returned?** Specifically: has the revenue date gone missing, has an unowned integration appeared on a phase exit, or has the experience graph acquired a slice number?
- What should be simplified before more code is written?

## 26. Immediate next actions

| Priority | Action                                                                                                   | Owner                |
| -------- | -------------------------------------------------------------------------------------------------------- | -------------------- |
| P0       | Close out A4: clips exist, or a written reason they cannot be captured headlessly                        | Prince               |
| P0       | S0.4 — OpenAI adapter behind the one interface; `adapters.yaml` serves as the roster until S1.1          | Prince + Claude Code |
| P0       | Migration commit: `permit` → `mandate` across code, schemas, docs and prompts                            | Prince + Claude Code |
| P0       | S0.5 summon rule, then S0.6 — film the 90-second demo                                                    | Prince               |
| P1       | ADR-006: terminology ruling and document precedence (this document, recorded as a decision)              | Prince               |
| P1       | RA-002: host adapter interface, decision contract, replay protection, one conformance suite              | Prince + Claude Code |
| P1       | Rotate the Neon database password; confirm no secret is in git history                                   | Prince               |
| P1       | MMU intellectual-property email; Jerry's IP assignment signed before any of his code lands               | Prince               |
| P1       | Screening corpus v0: collect injection samples for the §20 gate                                          | Jerry (async)        |
| P1       | Trademark and domain check: playroom.ai against the existing Playroom game SDK; record the fallback name | Prince               |
| P2       | Pilot shortlist: ten teams already paying for two or more AI subscriptions                               | Prince               |
| P2       | ADR-007: platform-policy review for the MCP connector — written before S3.2 is scheduled                 | Prince               |

## Final canonical position

> Playroom is the shared collaboration plane connecting humans and their independently owned agents across otherwise isolated AI applications — enforced by a trust fabric no model provider controls, and provable afterwards by anyone who was in the room.

Buzz is infrastructure and, eventually, a host surface. Playroom is the canonical room, the trust fabric and the provable history. Drift is the first specialist worker that proves the system under real conditions.

The defining experience is simple to state and technically demanding to build: **a person tags somebody else's agent without leaving the surface they were already working in.** Playroom resolves that member's identity, shares only what was explicitly promoted, routes the task, returns the response, blocks the authority escalation, requests the right human approval, issues a signed receipt and preserves the verified work.

Two sentences carry the product. The first is the promise: **a fully hijacked agent still cannot exceed its mandate.** The second is the discipline that gets there: **every phase exit runs on assets we own, and the first one is a ninety-second video.**

_Architecture Bible Volume I (Revised) · v1.1 · 25 July 2026 · Prince Anozie · Supersedes Bible v1.0 Vol I and Master Roadmap v1.0 · Next volume: II — data model, event catalogue and API specifications._
