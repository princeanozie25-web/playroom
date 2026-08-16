# FABLE ARCHITECTURE HANDOFF • 13 AUGUST 2026

## PLAYROOM

**Discovery → Product Thesis → Consolidated Architecture**

A complete strategic and technical report for Fable.

### Scope

This report reconstructs the chain of discoveries that sharpened Playroom: the original multi-agent
collaboration thesis; the Steve-Jobs-style "complexity disappears" insight; Grok Bot; the Agent-Link
repository; the proposed Harbor logical worker plane; AWS Cedar, Dogwood, Rex, AgentCore and Loom;
LangSmith/OpenTelemetry observability; Drift as the proof worker; and the resulting Playroom
vocabulary, product boundary, trust model and implementation direction.

> **North-star sentence**
>
> Playroom is the human-facing place where people and persistent AI workers collaborate; Harbor keeps
> workers alive across runtimes; Fabric controls what they can see; Mandates control what they can do;
> verified work becomes reusable experience.

**Prepared for: Fable — senior systems architect / strategic examiner**

Status: architecture consolidation, not a claim that every component is already implemented.

---

## Executive summary

Playroom began as a governed multi-agent collaboration product: people and agents from different
providers working together in shared rooms without collapsing privacy or authority boundaries. The
concept expanded when a recurring usability problem became obvious: modern agents are powerful but
operationally hostile to normal users. They require terminals, local runtimes, MCP configuration,
repositories, credentials, environment setup and always-on machines.

The decisive product insight is therefore not "build another agent." It is "make agent infrastructure
disappear." A user should create a worker in a form, connect tools with ordinary authorization flows,
invite people or other workers, issue a natural-language mandate, close their laptop, and later see
verified work on their phone. Whether the work ran locally, in Playroom cloud, in a private runtime or
on an infrastructure provider should be a placement decision, not a user decision.

> **The product boundary**
>
> Playroom should not try to out-AWS AWS, out-LangSmith LangSmith, or out-model the model labs. It
> should compose infrastructure into an opinionated, provider-neutral coworker experience with durable
> identity, governed context, delegated authority, execution continuity and human-legible
> accountability.

### What the recent discoveries changed

- Grok Bot validated demand for cloud-resident AI teammates that can work across apps, coordinate,
  preserve workflow context and return for approvals.
- Agent-Link raised the importance of simple room-to-room/agent-to-agent connection primitives and
  sharpened our vocabulary around Rooms, Doors and Presence; the repository must still be audited
  directly before any implementation-level dependency decision.
- AWS AgentCore validated the "agent harness" as a distinct layer: orchestration loop, tools, context,
  state, isolation, filesystem/shell, identity and observability.
- AWS Dogwood validated history-aware policy: authorization can depend on what happened earlier, not
  only the current tool call.
- AWS Rex validated a strong local execution pattern: the generated script is not trusted; host
  operations are separately policy-gated.
- Cedar validated deterministic, externalized authorization rather than asking an LLM to police
  itself.
- LangSmith/OpenTelemetry validated trace-first operations, evaluation and regression analysis.
- The remaining Playroom opportunity is above these primitives: belonging, collaboration, continuity,
  governance, distribution and reusable verified experience.

### Recommendation to Fable

Treat the architecture below as the new conceptual north star, but do not immediately bolt every
discovered technology into the codebase. First freeze semantic contracts — Worker, Room, Door, Fabric,
Mandate, Delegation Chain, Harbor, Work Trace, Experience Record — then map current implementation to
those contracts. Adopt external infrastructure only where it reduces undifferentiated work without
surrendering provider neutrality or the product's trust guarantees.

---

## 1. How we got here: the discovery chain

**Discovery timeline**

```
                    MULTI-AGENT PLAYROOM
        governed rooms + provider-neutral collaboration
                             |
                             v
              YC / market signal: "multiplayer AI"
                             |
                             v
                           DRIFT
          a concrete worker: dependency/API maintenance
                             |
                             v
            "STEVE JOBS WOULD HATE AGENT SETUP"
      terminal + MCP + local-only + environment complexity
                             |
                             v
                  PRODUCT THESIS EXPANDS
     one app • any device • one-click tools • local/cloud invisibly
                             |
                             v
                      HARBOR CONCEPT
   logical worker plane: identity + continuity + placement + durable state
                             |
              +--------------+--------------+
              |                             |
              v                             v
          GROK BOT                   AGENT-LINK REPO
      AI teammate signal          connection/room primitives
              |                             |
              +--------------+--------------+
                             v
                    AWS STACK DISCOVERY
             Cedar • Dogwood • Rex • AgentCore • Loom
                             |
                             v
                     LANGSMITH / OTEL
          traces • evals • regression • observability
                             |
                             v
                   CONSOLIDATED PLAYROOM
   People • Workers • Rooms • Trust • Harbor • Experience Network
```

This matters because the thesis did not pivot away from Playroom. It deepened. The original "trust
layer for multi-agent work" remains the centre. The new infrastructure work exists to make those
workers persistent, safe and usable enough that Playroom can become a daily environment rather than a
demo.

---

## 2. Grok Bot: threat, validation and lessons

The Grok Bot discovery initially looked existential because it attacks the same visible pain: give
users an AI teammate that can operate across workplace tools with much less setup. Public reporting
describes Grok Bot as a beta AI teammate that can independently execute multi-step workplace tasks in
a shared cloud environment, log into apps/websites, coordinate with other bots, retain workflow
context and return to the user for approvals or input.

> **Interpretation**
>
> Grok Bot does not kill Playroom. It validates the category and compresses the time available to
> differentiate. Playroom cannot win by merely saying "persistent agents in the cloud." That is
> becoming table stakes.

### Capabilities to learn from

- Teammate framing instead of "agent framework" framing.
- Cloud persistence: the worker remains useful when the user's laptop is closed.
- Cross-app execution through authenticated tools and browser surfaces.
- Human approval only when needed rather than continuous babysitting.
- Multi-bot coordination.
- Workflow context and adaptation to user preferences.
- Low visible setup burden.

### Where Playroom must be stronger

- Provider neutrality: a Worker should not be synonymous with one model vendor.
- Cross-owner collaboration: my worker and your worker can share a Room without merging private
  context.
- Explicit Fabric and Mandates rather than opaque "trust the teammate" authority.
- Delegation provenance: who authorized which worker, for what scope, and what downstream worker
  inherited.
- Local + cloud + private placement behind one worker identity.
- Public/private worker distribution, following, profiles and reusable verified work.
- Evidence-first work history and policy-verifiable execution.

**Public source:** https://www.theverge.com/ai-artificial-intelligence/978666/spacexai-grok-bot-ai-agent-beta-launch

---

## 3. Agent-Link: useful adjacency, not a product verdict

The repository surfaced as another possible "Playroom killer." The correct response is not to dismiss
it or panic. It is to separate protocol/infrastructure overlap from product overlap. In our
discussions it was useful primarily because it pushed us toward clearer connection primitives: Rooms
as shared contexts, Doors as controlled admission boundaries, and Presence as a first-class state.

> **Evidence boundary**
>
> The repository URL supplied was https://github.com/Riccardo8888/agent-link. During this report
> build, the public README could not be reliably retrieved through the available web index. Therefore
> this report does NOT assert unverified implementation details about Agent-Link. Fable should perform
> a direct repository audit before we copy APIs, schemas, security assumptions or dependency choices.

### What survives regardless of that audit

- A Room needs an explicit admission boundary.
- Connection should be easier than repeatedly sharing raw invite links.
- Presence should show whether a Worker is available, working, blocked, awaiting approval or sleeping.
- Peer-to-peer or cross-owner agent connectivity is infrastructure; Playroom's product value is
  governed collaboration and user experience above it.

**Door / admission concept**

```
        Sarah + Sarah's Researcher
                    |
                    v
            [ ROOM DOOR ]
                    |
         requested capabilities
          - see research summaries
          - use web search
          - post findings
          - 24h membership
                    |
            +-------+-------+
            |               |
          ADMIT           DENY
            |
            v
    scoped Room membership
```

---

## 4. The "amazingly simple" product thesis

The strongest product reframing came from the observation that current AI agent setup violates the
consumer-computing lesson associated with Apple: users are exposed to implementation detail. Today, a
capable agent may require Python/Node, terminals, CLIs, MCP servers, markdown configuration,
environment variables, repositories, Docker or cloud setup, credentials, and a machine that remains
online.

### Desired user experience

**Complexity inversion**

```
        TODAY                    PLAYROOM
        -----                    --------
  install runtime            create worker
  install CLI                choose role
  configure .md              connect apps
  configure MCP              choose people/rooms
  configure secrets          set mandate
  run laptop                 press Deploy
  keep laptop awake          close laptop
  debug environment          check Work History

                    UNDER PLAYROOM
                          |
        +-----------------+-----------------+
        |                 |                 |
      LOCAL             CLOUD            PRIVATE
        |                 |                 |
        +-----------------+-----------------+
                          |
             placement is not a UX burden
```

> **Principle**
>
> The technology underneath may become more complicated. The surface must become less complicated.

### Student wedge

A student-oriented wedge emerged naturally: people who want the benefits of agents but have neither
the patience nor the infrastructure appetite to manage MCP, CLIs and runtime environments. Examples
include research workers, project teams, job-search assistants, study workers and portfolio-building
teams. The wedge is attractive because the value proposition is legible: "make a coworker in a few
clicks."

However, high-impact actions such as job applications should be designed with platform terms, consent,
rate limits and human review in mind. The product thesis is autonomy with bounded authority, not
indiscriminate automation.

---

## 5. Harbor: the logical worker plane

Harbor is the proposed name for the logical worker plane beneath Playroom. It is not merely a cloud
runtime. Its job is to preserve the identity and work of a Worker while choosing where execution
should occur.

**Harbor placement model**

```
                      HARBOR
              "keep this worker alive"
                        |
           identity • continuity • authority
             durable task state • placement
                        |
        +---------------+---------------+
        |               |               |
      LOCAL           CLOUD          PRIVATE
        |               |               |
        +---------------+---------------+
                        |
                   same Worker
                   same mandate
                   same task
                   same history
```

### Harbor responsibilities

- Stable Worker identity independent of model and runtime.
- Durable task state and resumability.
- Runtime placement and migration decisions.
- Lease/heartbeat semantics for long-running work.
- Credential and capability attachment without exposing raw secrets to the model.
- Local-node routing when private files or local tools are required.
- Cloud continuation when the local machine disappears.
- Failure recovery, retry policy and explicit blocked/awaiting-human states.
- Runtime-independent observability correlation IDs.

### What Harbor is not

- Not a new foundation model.
- Not a replacement for Kubernetes/microVM/cloud infrastructure.
- Not necessarily a single execution engine.
- Not permission policy itself; Harbor carries and enforces the relevant trust contracts through lower
  layers.

---

## 6. The Playroom product model

**Human-facing model**

```
                       PLAYROOM
              "My people. My AI. My work."
                           |
        +------------------+------------------+
        |                  |                  |
      PEOPLE            WORKERS             ROOMS
        |                  |                  |
      Friends            Create           Collaborate
     Following          Configure          Delegate
       Teams             Deploy             Govern
     Profiles           Discover           Observe
        |                  |                  |
        +------------------+------------------+
                           |
                   EXPERIENCE NETWORK
                  useful work compounds
```

This structure deliberately expands Playroom beyond a session tool. People can maintain relationships
instead of repeatedly exchanging invitation links; users can follow people or workers whose public
work is useful; workers can be private, team-scoped or public; and Rooms become durable places where
collaborative work accumulates.

### Worker

A persistent AI identity that performs work. The Worker is not the model. A Worker can change models
or use multiple models while retaining role, mandate, memory, work history and reputation.

### Room

A governed shared execution context containing humans, Workers, promoted context, objectives,
permissions, artifacts, decisions and history.

### Door

A controlled admission boundary through which a human or Worker requests scoped membership in a Room.

### Presence

A live state such as working, sleeping, blocked, awaiting approval, disconnected, local, cloud or
private — rendered as coworker status rather than infrastructure telemetry.

---

## 7. Trust architecture: Fabric, Mandates and Delegation

**Trust plane**

```
                 PLAYROOM TRUST PLANE
                          |
     +--------------------+--------------------+
     |                    |                    |
   FABRIC              MANDATES            IDENTITY
what may be seen    what may be done      who is acting
     |                    |                    |
     +--------------------+--------------------+
                          |
                  DELEGATION CHAIN
                who granted authority?
                          |
                   ACTION GATEWAY
                          |
              deterministic policy checks
```

### Fabric

Fabric is the information-flow boundary. It determines which context is visible in a Room, which
private memory remains private, what can be promoted into shared context, and what a Worker may carry
across Rooms. This is central to the original Playroom promise: collaboration without indiscriminate
context sharing.

### Mandates

Mandates are human-legible authority contracts. The user sees "Can always / Ask me first / Never."
Underneath, Playroom can compile those choices into deterministic policy.

**Mandate UX → deterministic enforcement**

```
              DRIFT'S MANDATE

              Can always
              [x] Read repository
              [x] Run tests
              [x] Create branch

              Ask first
              [!] Open PR
              [!] Install dependency

              Never
              [ ] Merge main
              [ ] Read .env
              [ ] Change billing
                      |
                      v
          machine-enforceable policy
                      |
                      v
                 tool boundary
```

### Delegation Chain

Authority must remain attributable when one worker delegates to another. The key invariant is
monotonic narrowing: downstream authority cannot silently exceed upstream authority unless a human
with sufficient authority explicitly expands it.

**Delegated authority**

```
                    Prince
          scope: repo X / branch only
                      |
                      v
                    Fable
             authority <= Prince
                      |
                      v
                    Codex
             authority <= Fable
                      |
                      v
                GitHub action

  Every hop records:
  principal • delegator • scope • expiry • evidence
```

---

## 8. AWS discoveries and how they map to Playroom

### 8.1 Cedar — deterministic authorization

Cedar provides a model for authorization outside the LLM. This is architecturally aligned with
Playroom: the model is a potentially nondeterministic actor; permission is decided by a separate
policy layer.

Playroom mapping: human Mandate → policy compiler → Action Gateway decision.

### 8.2 Dogwood — runtime verification over history

Dogwood extends the policy idea from "is this request allowed now?" to "is this request allowed given
the sequence of prior events?" That enables temporal conditions such as requiring tests before
deployment, limiting how often a tool may be used, or forbidding an action after a particular state
transition.

**Temporal policy example**

```
              DEPLOY requested
                     |
                     v
     Mandate permits deploy? ---- no ---> DENY
                     |
                    yes
                     |
                     v
              Temporal checks
              tests ran? -------- yes
              tests passed? ----- yes
              security passed? -- yes
              approval exists? -- yes
              branch valid? ----- yes
                     |
                     v
                  EXECUTE
```

For Drift, this is especially useful: "a dependency upgrade may be proposed, but a PR may not be
opened until compatibility checks and tests have completed," or "never merge after an unresolved
regression event."

**AWS Dogwood:** https://aws.amazon.com/blogs/opensource/introducing-dogwood-runtime-verification-for-ai-agents/

### 8.3 Rex — policy-enforced host execution

AWS Trusted Remote Execution (Rex) is an open-source runtime where scripts have no direct host access;
host operations are exposed through controlled functions and each operation is checked against Cedar
policy before execution. The pattern is valuable for Playroom's local node: a remote/cloud Worker
should not receive a raw, unrestricted shell merely because the user connected their computer.

**Rex-inspired local execution**

```
                Cloud Worker
                      |
                      v
                    Harbor
                      |
              signed work lease
                      |
                      v
            Playroom Local Node
                      |
               EXECUTION GATE
                      |
          +-----------+-----------+
          |           |           |
        files        git      terminal
          |           |           |
          +-----------+-----------+
                      |
                 policy check
                  /        \
              allow        deny
                  |
                  v
             local machine
```

**AWS Rex:** https://aws.amazon.com/blogs/opensource/introducing-trusted-remote-execution-policy-enforced-scripts-for-ai-agents-and-humans/

### 8.4 AgentCore Harness — commodity runtime infrastructure

AgentCore Harness is strong external validation for Harbor's lower-level needs. AWS describes the
harness as the body around the model: orchestration loop, tool execution, context management,
persistent state, failure recovery, isolated environment, filesystem/shell, memory, identity and
observability. It is model-agnostic and can switch models mid-session without discarding context.

> **Architectural consequence**
>
> Do not spend Playroom's moat budget rebuilding every commodity runtime primitive. Harbor should be
> capable of using AgentCore or equivalent infrastructure as a runtime driver while preserving
> Playroom's Worker identity, Mandate, Fabric, state model and provider neutrality.

**AgentCore Harness GA:** https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-bedrock-agentcore-harness-generally-available/

**AgentCore interactive shells:** https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-bedrock-agentcore-runtime/

### 8.5 Loom — managed agent platform / registry signal

Loom for AWS is relevant because it combines agent creation, deployment/operation, security/governance
and asset management around AgentCore. The lesson for Playroom is not to clone an enterprise console;
it is to consumerize the same lifecycle: create, review, deploy, discover, govern and operate Workers.

**AWS Loom:** https://aws.amazon.com/blogs/opensource/building-secure-ai-agents-at-scale-introducing-loom-for-aws/

---

## 9. Observability: LangSmith, OpenTelemetry and Work History

A persistent Worker cannot be trusted merely because it returns a plausible final answer. Playroom
needs complete operational evidence: what task ran, which tools were called, which worker delegated,
what failed, what policy denied, what artifacts changed, how long it took and whether the outcome was
verified.

### Technical model

- **Trace:** one complete unit of work.
- **Span:** one operation inside the trace — model call, tool call, policy decision, browser step,
  shell command, handoff, etc.
- **Evaluation:** evidence about quality, correctness, policy adherence or task success.
- **Regression:** whether a newer Worker/model/prompt/tool configuration performs worse than a prior
  version.
- **Dataset:** curated historical tasks used to test changes.

### Human-facing model

**Work History projection**

```
        DRIFT / WORK HISTORY

        OpenAI SDK migration          [verified]
        12 Aug • 4m 19s • £0.72

        Discovery                          ✓
        Impact analysis                    ✓
        14 call sites                      ✓
        Repair                             ✓
        Tests 426/426                      ✓
        Policy checks                      ✓
        PR opened                          ✓

        [ View technical trace ]
```

OpenTelemetry should be the vendor-neutral instrumentation spine where practical. LangSmith can be an
observability/evaluation backend for Drift and other LangChain-compatible or custom workers, but
Playroom should keep its canonical audit/event model independent so the product is not semantically
owned by one observability vendor.

**LangSmith observability docs:** https://docs.langchain.com/langsmith/observability

**AWS unified agent observability:** https://aws.amazon.com/about-aws/whats-new/2026/07/amazon-bedrock-agentcore-unified-observability-single-log-group/

---

## 10. Drift as the killer proof worker

Drift is strategically useful because it makes the architecture concrete. Rather than proving Playroom
with a generic chat agent, Drift can prove persistent identity, scheduled/background work, codebase
access, temporal verification, policy-gated execution, observability and human approval.

**Drift end-to-end**

```
        API / SDK ecosystem changes
                    |
                    v
                  DRIFT
        persistent Worker identity
                    |
                    v
                DISCOVERY
        release notes • schema • docs
                    |
                    v
            IMPACT ANALYSIS
     customer repo / dependency graph
                    |
                    v
                 MANDATE
       what Drift may inspect/change
                    |
                    v
             TEMPORAL POLICY
        required checks happened?
                    |
                    v
             EXECUTION GATE
       branch • files • tests • shell
                    |
                    v
               VERIFICATION
      build • tests • compatibility
                    |
                    v
            APPROVAL / PR GATE
                    |
                    v
                WORK TRACE
                    |
                    v
            EXPERIENCE RECORD
```

### Minimum compelling Drift demo

1. User deploys Drift from Playroom with a form — no local agent framework setup.
2. User connects GitHub and chooses one repository.
3. Drift notices a real dependency/API change.
4. Drift identifies affected call sites and explains impact.
5. Drift creates a governed branch, performs the repair and runs tests.
6. Temporal policy prevents PR creation until required checks pass.
7. User receives a phone notification with evidence and approves the PR.
8. Work History shows the complete trajectory and outcome.
9. The verified procedure becomes eligible for an Experience Record.

---

## 11. Experience Network: where Playroom can compound

The strongest differentiated layer is not raw traces. It is turning verified outcomes into reusable
experience without exposing private context or hidden chain-of-thought.

**Experience compounding**

```
            Worker solves problem
                     |
                     v
                Work Trace
                     |
                     v
                Evaluation
                     |
             outcome verified
                     |
                     v
            Experience Record
        problem • procedure • evidence
          environment • constraints
                     |
                     v
           EXPERIENCE NETWORK
                     |
        +------------+------------+
        |            |            |
   same Worker  other Workers   humans
    improves      retrieve     discover
```

### What may be shared

- Problem signature and environment characteristics.
- Successful procedure or workflow.
- Tool sequence at an appropriate abstraction level.
- Artifacts or diffs where the owner permits.
- Verification evidence and confidence.
- Failure patterns and recovery steps.

### What should not be treated as the product

- Raw private prompts by default.
- Secrets or credentials.
- Unfiltered private Room context.
- Hidden chain-of-thought.
- A claim that one successful trace is universally reusable.

---

## 12. People, following and the Worker Directory

The social idea is not decorative. It reduces collaboration friction and creates distribution. A user
should be able to maintain a relationship with collaborators, follow useful builders/workers, and
choose whether a Worker or Experience Record is private, team-only or public.

**Distribution loop**

```
            useful public work
                     |
                     v
      profile / Worker / Experience
                     |
                     v
      follow • save • deploy • invite
                     |
                     v
       new Rooms and collaborations
                     |
                     v
           more verified work
                     |
        +------------+
        |
        v
   reputation grows
```

### Worker Directory

A public directory can eventually surface workers by job-to-be-done, evidence, deployment count,
verified outcomes, compatibility and owner reputation. The design should resist vanity metrics:
evidence and reliability should matter more than follower count.

---

## 13. Mobile control: not a raw terminal, a governed work surface

The original pain was practical: coding agents stop because they need a terminal keypress,
authentication step, approval or command while the user is away from the computer. The product
opportunity is real, but the safest abstraction is not "expose my laptop shell to the internet."

**Phone → governed execution**

```
                  PHONE
                    |
                    | approve / inspect / command
                    v
                 PLAYROOM
                    |
                    v
                  HARBOR
                    |
                    +-------- cloud session
                    |
                    +-------- local node
                    |
                    v
             EXECUTION GATE
                    |
        scoped interactive shell
                    |
             user's computer
```

A mobile terminal can exist as an advanced surface, but it should inherit Worker identity, session
identity, Mandate, policy enforcement, audit and reconnect semantics. AWS AgentCore's persistent
PTY-backed interactive shells are useful proof that resumable remote terminal sessions can be a
runtime primitive; Playroom's value is making them safe and coherent with the rest of the worker
model.

---

## 14. Consolidated architecture

**Full conceptual stack**

```
                            PLAYROOM
              human-facing collaboration product
                                |
        +-----------------------+-----------------------+
        |                       |                       |
      PEOPLE                 WORKERS                  ROOMS
        |                       |                       |
        +-----------------------+-----------------------+
                                |
                       EXPERIENCE NETWORK
                                |
                                v
                             HARBOR
                      logical worker plane
        identity • continuity • durable state • placement
                                |
        +-----------------------+-----------------------+
        |                       |                       |
      LOCAL                   CLOUD                  PRIVATE
        |                       |                       |
        +-----------------------+-----------------------+
                                |
                    PLAYROOM TRUST PLANE
                                |
        +-----------------------+-----------------------+
        |                       |                       |
      FABRIC                 MANDATES                IDENTITY
   context flow             authority                principal
        |                       |                       |
        +-----------------------+-----------------------+
                                |
                        DELEGATION CHAIN
                                |
                         ACTION GATEWAY
                                |
              +-----------------+-----------------+
              |                 |                 |
           current           temporal        native rules
           policy             policy
         Cedar-like        Dogwood-like
              |                 |
              +-----------------+
                                |
                        EXECUTION GATE
                  Rex-inspired host control
                                |
                                v
                            REAL WORLD
           APIs • browser • files • git • shell • SaaS
                                |
                                v
                          OBSERVABILITY
              OpenTelemetry → LangSmith / internal
                                |
                                v
                            WORK TRACE
                                |
                             evaluate
                                |
                                v
                        VERIFIED OUTCOME
                                |
                                v
                        EXPERIENCE RECORD
```

---

## 15. Terminology to freeze

| Term                   | Frozen meaning                                                                   |
| ---------------------- | -------------------------------------------------------------------------------- |
| **Playroom**           | Human-facing product and collaboration environment.                              |
| **Worker**             | Persistent AI identity that performs work; not synonymous with a model.          |
| **Room**               | Governed shared execution/collaboration context.                                 |
| **Door**               | Controlled admission boundary into a Room.                                       |
| **Fabric**             | Context visibility and information-flow layer.                                   |
| **Mandate**            | Human-legible authority contract for a Worker.                                   |
| **Delegation Chain**   | Provenance of authority across human→worker→worker/tool hops.                    |
| **Harbor**             | Logical worker plane for identity, continuity, durable task state and placement. |
| **Local Node**         | Trusted bridge between Playroom and a user's computer/private environment.       |
| **Action Gateway**     | Boundary through which external actions are authorized.                          |
| **Execution Gate**     | Policy-enforced boundary for host/system operations.                             |
| **Presence**           | Human-facing live Worker state.                                                  |
| **Work Trace**         | Technical execution trajectory for a unit of work.                               |
| **Work History**       | Human-facing projection of traces and outcomes.                                  |
| **Artifact**           | Durable output produced by work.                                                 |
| **Handoff**            | Transfer of responsibility between humans/workers.                               |
| **Approval**           | Explicit human authorization for a gated action.                                 |
| **Experience Record**  | Verified reusable abstraction of successful work.                                |
| **Experience Network** | System through which verified experience compounds.                              |
| **Worker Directory**   | Discovery/distribution surface for Workers.                                      |

### Implementation terminology — keep below the surface

| Technical term | Role                                                                  |
| -------------- | --------------------------------------------------------------------- |
| Cedar          | Deterministic authorization / policy language or reference.           |
| Dogwood        | Temporal/runtime verification over event history.                     |
| Rex            | Reference pattern / possible component for policy-enforced execution. |
| AgentCore      | Potential cloud execution/harness substrate.                          |
| Loom           | Reference for governed agent lifecycle/registry patterns.             |
| OpenTelemetry  | Vendor-neutral telemetry transport/instrumentation.                   |
| LangSmith      | Optional traces/evaluation/observability backend.                     |
| MCP            | Tool integration protocol.                                            |
| A2A            | Agent interoperability protocol.                                      |
| OAuth          | Delegated service authorization.                                      |

---

## 16. Competitive interpretation

The discoveries show that many layers are rapidly commoditizing. That is a reason to sharpen Playroom,
not abandon it.

| Layer                       | External signal                       | Playroom posture                                                         |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| Model intelligence          | Frontier labs                         | Do not compete.                                                          |
| Agent harness               | AWS AgentCore and others              | Use/abstract where economical.                                           |
| Policy language             | Cedar / Dogwood                       | Adopt concepts or engines; do not make users learn them.                 |
| Sandbox / execution         | Rex, microVMs, cloud runtimes         | Treat as substrate.                                                      |
| Observability               | LangSmith, CloudWatch, OTEL ecosystem | Integrate behind canonical Playroom events.                              |
| Agent connectivity          | Agent-Link / A2A / MCP ecosystem      | Interoperate; productize admission and trust.                            |
| AI teammate                 | Grok Bot and lab products             | Compete on neutrality, cross-owner rooms, trust, continuity and network. |
| Human-facing collaboration  | Playroom opportunity                  | Own the experience.                                                      |
| Verified experience network | Playroom opportunity                  | Potential compounding moat.                                              |

### The moat thesis

> **Not "we have agents."**
>
> The defensible thesis is the governed relationship between persistent Worker identity, cross-owner
> collaboration, provider-neutral placement, information-flow boundaries, delegated authority,
> evidence and reusable verified experience.

Grok Bot can validate teammate UX. AWS can validate runtime and governance primitives. LangSmith can
validate observability. None of those facts removes the need for a product that makes heterogeneous AI
coworkers feel coherent to ordinary people and teams.

---

## 17. Architectural invariants Fable should protect

- Worker identity must survive model changes.
- Room membership must not imply access to all private Worker/user context.
- Authority must be external to the model and attributable to a principal.
- Delegated authority must not silently expand.
- High-impact actions must support explicit approval gates.
- Execution placement must not change the semantic identity of the Worker.
- Local access must be mediated through a trusted node/execution boundary rather than an unrestricted
  internet-exposed shell.
- Every consequential action must produce an auditable event.
- Observability vendors must not become the canonical source of Playroom semantics.
- Public Experience Records must be derived from verified outcomes and privacy-safe abstractions, not
  raw private reasoning.
- Provider neutrality must be real at the Worker contract, even if individual runtime adapters are
  provider-specific.
- Failure, blocked, disconnected and awaiting-human states are first-class durable states, not
  exceptions hidden in logs.

---

## 18. Recommended implementation sequence

Fable should audit current reality before accepting this sequence verbatim. The sequence is
architectural, not a claim about existing roadmap phase numbering.

1. **Contract freeze** — Define schemas/interfaces for Worker, Room, Door, Fabric grant, Mandate,
   Delegation, Task state, Artifact and Work event.
2. **Canonical event model** — Create one append-only work/event vocabulary before wiring multiple
   observability backends.
3. **Drift proof path** — Implement one worker end-to-end through the contracts. Avoid a broad Worker
   marketplace first.
4. **Mandate + Action Gateway** — Put deterministic authorization at tool/action boundaries.
5. **Temporal verification** — Add Dogwood-style sequence constraints for a small set of high-value
   Drift operations.
6. **Local Node + Execution Gate** — Build governed local file/git/shell access; test reconnect and
   revocation.
7. **Harbor durable state** — Persist task lifecycle, lease/heartbeat, placement and resume semantics.
8. **Cloud runtime adapter** — Use a provider/runtime abstraction; evaluate AgentCore as one driver
   rather than the product core.
9. **Work History** — Render traces, approvals, policy decisions, artifacts and outcomes in human
   language.
10. **Mobile intervention** — Approvals, blocked tasks, resumable terminal/session controls.
11. **People + Doors** — Persistent collaborators, scoped Room admission and following.
12. **Experience Records** — Only after verification semantics are trustworthy.
13. **Directory/network** — Public/private Worker distribution once quality and safety signals exist.

---

## 19. Questions Fable should answer before ratification

- Which of these contracts already exist in the current Playroom codebase under different names?
- Does Harbor deserve to be a first-class subsystem, or is it better expressed as existing
  runtime/state services plus a placement interface?
- What is the minimum canonical Worker identity that survives provider/model/runtime changes?
- What information-flow guarantees can Fabric actually enforce today, and which remain roadmap claims?
- Where should Mandate compilation occur, and should Cedar be an engine, a reference, or avoided
  initially?
- Can Dogwood be embedded/adapted without coupling Playroom to AWS AgentCore?
- Should the Local Node use a Rex-derived design, Rex directly, OS-native sandboxing, or a separate
  capability broker?
- What is the exact revocation model when a phone, Room member, Worker or runtime is compromised?
- How should Harbor transfer work from local to cloud without accidentally transferring local-only
  secrets or context?
- What events are security/audit events versus product collaboration events, and how do they
  correlate?
- What is the canonical boundary between Work Trace and Experience Record?
- How do we prevent Experience Network poisoning, low-quality imitation and reputation gaming?
- What is the smallest Drift demo that proves the architecture rather than merely simulating it?
- Which AWS components save time without creating an AWS-shaped product?
- What should remain deliberately NOT built until product-market evidence exists?

---

## 20. Premortem

| Failure mode                                 | What it looks like                                                              | Countermeasure                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| We build infrastructure instead of a product | Harbor becomes a months-long runtime project while no ordinary user gets value. | Keep Drift demo and one-click Worker UX as acceptance tests for every infrastructure milestone.      |
| We overreact to competitors                  | Each new repo causes architecture churn.                                        | Freeze semantic contracts; evaluate new projects against contracts rather than renaming the product. |
| We become AWS-dependent                      | AgentCore conveniences leak into Worker semantics.                              | Adapter boundary; canonical state and events remain Playroom-owned.                                  |
| Trust is mostly UI                           | Mandates look safe but tool calls bypass enforcement.                           | All consequential actions pass through one enforceable gateway; test bypass attempts.                |
| Local node becomes a security liability      | Remote shell access is too broad.                                               | Capability-scoped execution, revocation, short-lived leases, policy gates, explicit audit.           |
| Experience Network leaks data                | Useful traces accidentally expose private context.                              | Promotion pipeline, owner controls, redaction, derived records, no raw CoT.                          |
| Social layer arrives too early               | Following/feed becomes vanity before work quality exists.                       | Make verified work the graph's unit of value; defer broad feed mechanics.                            |
| Worker marketplace fills with junk           | Low-quality clones erode trust.                                                 | Evidence-backed ranking, verification badges, compatibility tests, abuse controls.                   |
| Model providers subsume basic teammate UX    | Playroom's visible features become commodity.                                   | Own cross-provider/cross-owner trust, durable identity, governed rooms and experience portability.   |

---

## 21. Final north star

> **The simplest description**
>
> Playroom is a place where people can create, bring, govern and collaborate with persistent AI
> coworkers — without needing to understand the infrastructure that keeps those coworkers alive.

The strategic direction is now clearer than it was before Grok Bot, Agent-Link and the AWS
discoveries. Those projects do not erase the idea; they help separate commodity layers from the layer
Playroom should own.

**The user should experience this — and only this**

```
            Open Playroom
                  |
        Create / choose Worker
                  |
         Connect what it needs
                  |
        Choose people + Room
                  |
        Set simple boundaries
                  |
   "you two work together on this"
                  |
            close laptop
                  |
         check phone later
                  |
      verified work is waiting
```

Behind that simple flow may sit Harbor placement, cloud microVMs, a Local Node, OAuth, MCP/A2A
adapters, Fabric scoping, Mandate compilation, Cedar authorization, Dogwood temporal verification,
Rex-like execution controls, OpenTelemetry, LangSmith and multiple model providers.

**The disappearing complexity is the product.**

---

## Appendix A — Source register

Sources below were used to verify the external technology claims in this report. Product synthesis,
naming and Playroom mappings are architectural recommendations, not statements made by those sources.

- **Grok Bot reporting:** https://www.theverge.com/ai-artificial-intelligence/978666/spacexai-grok-bot-ai-agent-beta-launch
- **Agent-Link repository supplied by Prince:** https://github.com/Riccardo8888/agent-link
- **AWS Dogwood:** https://aws.amazon.com/blogs/opensource/introducing-dogwood-runtime-verification-for-ai-agents/
- **AWS Trusted Remote Execution (Rex):** https://aws.amazon.com/blogs/opensource/introducing-trusted-remote-execution-policy-enforced-scripts-for-ai-agents-and-humans/
- **AWS AgentCore Harness GA:** https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-bedrock-agentcore-harness-generally-available/
- **AWS AgentCore Harness docs:** https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html
- **AWS AgentCore interactive shells:** https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-bedrock-agentcore-runtime/
- **AWS Loom:** https://aws.amazon.com/blogs/opensource/building-secure-ai-agents-at-scale-introducing-loom-for-aws/
- **AWS unified observability:** https://aws.amazon.com/about-aws/whats-new/2026/07/amazon-bedrock-agentcore-unified-observability-single-log-group/
- **AWS AgentCore Evaluations:** https://aws.amazon.com/blogs/machine-learning/build-reliable-ai-agents-with-amazon-bedrock-agentcore-evaluations/
- **LangSmith observability:** https://docs.langchain.com/langsmith/observability

---

## Appendix B — Evidence / inference boundary

Verified external facts are limited to what the cited sources support. The Playroom architecture,
Harbor naming, Experience Network, Door semantics, Mandate UX, Delegation invariant, competitive
positioning and implementation sequence are synthesis from the ongoing Playroom design discussion.

Agent-Link deserves a dedicated repository audit. The URL was available, but its README was not
reliably retrievable through the web index used while preparing this document; therefore no unverified
repository internals have been treated as fact.
