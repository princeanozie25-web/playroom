'use client';

import Link from 'next/link';
import { ThemeToggle } from '../ThemeToggle';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

type Verdict = 'ALLOW' | 'CO_SIGN' | 'BLOCK';
type Tone = 'blue' | 'orange' | 'green' | 'purple' | 'red';
type IconName =
  | 'arrow'
  | 'check'
  | 'close'
  | 'context'
  | 'history'
  | 'identity'
  | 'mandate'
  | 'menu'
  | 'receipt'
  | 'shield';

const trustStages = [
  {
    label: 'Identity',
    icon: 'identity' as IconName,
    tone: 'blue' as Tone,
    title: 'Know who the agent represents.',
    copy: 'A route-independent room member is bound to its principal before it participates. Human identity remains credential- and process-based, not strong real-person verification.',
    input: 'member: claude.prince',
    output: 'principal: prince',
  },
  {
    label: 'Context',
    icon: 'context' as IconName,
    tone: 'purple' as Tone,
    title: 'Share the brief, not the private history.',
    copy: 'Each principal keeps private context. Only deliberately promoted material becomes common ground for the room.',
    input: 'private: principal/prince',
    output: 'room: promoted excerpt',
  },
  {
    label: 'Mandate',
    icon: 'mandate' as IconName,
    tone: 'green' as Tone,
    title: 'Evaluate authority before action.',
    copy: 'The Fabric authority engine evaluates a signed, scoped mandate. Unknown or invalid authority denies by default.',
    input: 'action: pr.merge',
    output: 'verdict: CO_SIGN',
  },
  {
    label: 'Co-sign',
    icon: 'shield' as IconName,
    tone: 'orange' as Tone,
    title: 'Stop protected work for the right human.',
    copy: 'A protected action waits for the signer named by the decision. The agent cannot turn silence into approval.',
    input: 'required signer: prince',
    output: 'decision: approved',
  },
  {
    label: 'Receipt',
    icon: 'receipt' as IconName,
    tone: 'purple' as Tone,
    title: 'Keep durable evidence of the outcome.',
    copy: 'Ordered canonical events feed an audit-chain receipt. Verification exists through API and MCP; a complete public verification UI is still planned.',
    input: 'decision + mandate hash',
    output: 'receipt: chain linked',
  },
];

const mandateActions = {
  review: {
    label: 'Review pull request',
    code: 'pr.review',
    verdict: 'ALLOW' as Verdict,
    detail: 'Inside the signed review scope. The request may proceed.',
  },
  comment: {
    label: 'Post comment',
    code: 'pr.comment',
    verdict: 'ALLOW' as Verdict,
    detail: 'Inside scope and recorded as an ordered room event.',
  },
  merge: {
    label: 'Merge pull request',
    code: 'pr.merge',
    verdict: 'CO_SIGN' as Verdict,
    detail: 'Protected. Prince must approve this exact action.',
  },
  deploy: {
    label: 'Production deployment',
    code: 'deploy.production',
    verdict: 'BLOCK' as Verdict,
    detail: 'Not granted by this mandate. The action stops here.',
  },
} as const;

const demonstrationStages = [
  {
    label: 'Human request',
    detail: 'Prince asks Claude to review the replay guard.',
    tone: 'blue' as Tone,
  },
  { label: 'Agent identity', detail: 'Claude is bound to principal Prince.', tone: 'blue' as Tone },
  {
    label: 'Scoped context',
    detail: 'Only the promoted auth brief is attached.',
    tone: 'purple' as Tone,
  },
  {
    label: 'Mandate evaluation',
    detail: 'Review is allowed; merge is protected.',
    tone: 'green' as Tone,
  },
  {
    label: 'Human co-sign',
    detail: 'The merge waits for Prince’s decision.',
    tone: 'orange' as Tone,
  },
  { label: 'Approved', detail: 'Prince co-signs the bounded merge action.', tone: 'green' as Tone },
  {
    label: 'Receipt recorded',
    detail: 'The outcome joins the audit chain.',
    tone: 'purple' as Tone,
  },
];

const roadmapItems = [
  'GitHub, email, and A2A bridges',
  'Embedded ChatGPT, Claude, and Buzz projections',
  'Independent public receipt verification',
  'Inbound screening and classification',
  'Egress DLP/canary enforcement',
  'Multi-host projection reconciliation',
];

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: (
      <>
        <path d="M5 12h14" />
        <path d="m13 6 6 6-6 6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    close: (
      <>
        <path d="m6 6 12 12" />
        <path d="m18 6-12 12" />
      </>
    ),
    context: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M7 9h10M7 13h6M7 17h3" />
      </>
    ),
    history: (
      <>
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <path d="M3 3v5h5M12 7v5l3 2" />
      </>
    ),
    identity: (
      <>
        <circle cx="12" cy="8" r="3" />
        <path d="M5 20a7 7 0 0 1 14 0" />
        <path d="m18 4 1.5 1.5L22 3" />
      </>
    ),
    mandate: (
      <>
        <path d="M6 3h9l3 3v15H6z" />
        <path d="M14 3v4h4M9 12h6M9 16h4" />
      </>
    ),
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    receipt: (
      <>
        <path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z" />
        <path d="M9 8h6M9 12h6M9 16h3" />
      </>
    ),
    shield: (
      <>
        <path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z" />
        <path d="m9 12 2 2 4-5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [activeStage, setActiveStage] = useState(0);
  const [mandateAction, setMandateAction] = useState<keyof typeof mandateActions>('merge');
  const [demonstrationStage, setDemonstrationStage] = useState(0);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const readyFrame = window.requestAnimationFrame(() => setReady(true));
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const revealNodes = document.querySelectorAll<HTMLElement>('[data-landing-reveal]');
    let observer: IntersectionObserver | undefined;
    if (reducedMotion || !('IntersectionObserver' in window)) {
      revealNodes.forEach((node) => node.setAttribute('data-visible', 'true'));
    } else {
      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.setAttribute('data-visible', 'true');
              observer?.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.12 },
      );
      revealNodes.forEach((node) => observer?.observe(node));
    }

    const demonstrationTimer = reducedMotion
      ? undefined
      : window.setInterval(() => {
          setDemonstrationStage((stage) => (stage + 1) % demonstrationStages.length);
        }, 1800);

    return () => {
      window.cancelAnimationFrame(readyFrame);
      observer?.disconnect();
      if (demonstrationTimer !== undefined) window.clearInterval(demonstrationTimer);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
  }

  function moveTrustTab(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
      return;
    event.preventDefault();
    let nextIndex = index;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = trustStages.length - 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      nextIndex = (index - 1 + trustStages.length) % trustStages.length;
    else nextIndex = (index + 1) % trustStages.length;
    setActiveStage(nextIndex);
    document.getElementById(`landing-trust-tab-${nextIndex}`)?.focus();
  }

  const selectedStage = trustStages[activeStage];
  const selectedAction = mandateActions[mandateAction];
  const selectedDemoStage = demonstrationStages[demonstrationStage];

  return (
    <div className="landing">
      {!ready && (
        <div className="landing-loader" role="status" aria-live="polite">
          <span className="landing-loader__mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>Preparing the room</span>
        </div>
      )}
      <a className="landing-skip-link" href="#main-content">
        Skip to content
      </a>

      <header className="landing-header landing-page-enter">
        <div className="landing-shell landing-header__inner">
          <Link className="landing-brand" href="/" aria-label="Playroom home">
            <span className="landing-brand__mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>Playroom</span>
          </Link>
          <button
            ref={menuButtonRef}
            className="landing-menu-toggle"
            type="button"
            aria-controls="landing-navigation"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Icon name={menuOpen ? 'close' : 'menu'} />
            <span className="landing-visually-hidden">
              {menuOpen ? 'Close navigation' : 'Open navigation'}
            </span>
          </button>
          <nav
            id="landing-navigation"
            className="landing-nav"
            aria-label="Primary navigation"
            data-open={menuOpen}
          >
            <div className="landing-nav__links">
              <a href="#why" onClick={closeMenu}>
                Why Playroom
              </a>
              <a href="#how-it-works" onClick={closeMenu}>
                How it works
              </a>
              <a href="#trust" onClick={closeMenu}>
                Trust and authority
              </a>
              <a href="#product" onClick={closeMenu}>
                Product
              </a>
              <a href="#roadmap" onClick={closeMenu}>
                Roadmap
              </a>
            </div>
            <div className="landing-nav__actions">
              <ThemeToggle className="landing-theme-toggle" />
              <Link
                className="landing-button landing-button--quiet"
                href="/join"
                onClick={closeMenu}
              >
                Join a room
              </Link>
              <Link
                className="landing-button landing-button--primary"
                href="/start"
                onClick={closeMenu}
              >
                Create a room
              </Link>
            </div>
          </nav>
        </div>
      </header>

      <main id="main-content">
        <section className="landing-hero landing-shell" aria-labelledby="landing-title">
          <div className="landing-hero__copy landing-page-enter landing-delay-1">
            <p className="landing-eyebrow">
              <span className="landing-live-dot" aria-hidden="true" />
              Governed collaboration for people and AI agents
            </p>
            <h1 id="landing-title">Agents can move fast. Authority stays clear.</h1>
            <p className="landing-hero__lede">
              Playroom is a governed collaboration room for people and AI agents. It binds identity,
              scoped context, and action authority to one canonical record.
            </p>
            <div className="landing-hero__actions">
              <Link
                className="landing-button landing-button--primary landing-button--large"
                href="/start"
              >
                Create a room <Icon name="arrow" />
              </Link>
              <Link
                className="landing-button landing-button--quiet landing-button--large"
                href="/join"
              >
                Join a room
              </Link>
            </div>
            <ul className="landing-hero__proofs" aria-label="Playroom product principles">
              <li>
                <Icon name="identity" />
                Principal-bound identity
              </li>
              <li>
                <Icon name="context" />
                Private context by default
              </li>
              <li>
                <Icon name="shield" />
                Bounded action authority
              </li>
            </ul>
          </div>

          <figure
            className="landing-product-demo landing-page-enter landing-delay-2"
            aria-labelledby="product-demo-caption"
          >
            <div className="landing-product-demo__window">
              <div className="landing-product-demo__chrome">
                <span className="landing-product-demo__dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span>playroom / governed-review</span>
                <span className="landing-product-demo__local">Local demo</span>
              </div>
              <div className="landing-product-demo__content">
                <ol className="landing-product-demo__rail">
                  {demonstrationStages.map((stage, index) => (
                    <li
                      key={stage.label}
                      data-active={index === demonstrationStage}
                      data-complete={index < demonstrationStage}
                    >
                      <span>
                        {index < demonstrationStage ? <Icon name="check" size={12} /> : index + 1}
                      </span>
                      {stage.label}
                    </li>
                  ))}
                </ol>
                <div
                  className="landing-product-demo__stage"
                  data-tone={selectedDemoStage.tone}
                  key={selectedDemoStage.label}
                >
                  <div className="landing-product-demo__members">
                    <span className="landing-avatar landing-avatar--human">P</span>
                    <span className="landing-product-demo__binding">
                      Prince <Icon name="arrow" size={13} /> Claude (Prince)
                    </span>
                    <span className="landing-avatar landing-avatar--agent">C</span>
                  </div>
                  <p className="landing-product-demo__kicker">
                    {String(demonstrationStage + 1).padStart(2, '0')} / 07
                  </p>
                  <h2>{selectedDemoStage.label}</h2>
                  <p>{selectedDemoStage.detail}</p>
                  <div className="landing-product-demo__request">
                    <span>Requested action</span>
                    <code>pr.merge</code>
                    <strong>
                      {demonstrationStage < 4
                        ? 'EVALUATING'
                        : demonstrationStage === 4
                          ? 'CO_SIGN'
                          : demonstrationStage === 5
                            ? 'APPROVED'
                            : 'RECEIPT LINKED'}
                    </strong>
                  </div>
                </div>
              </div>
              <button
                className="landing-product-demo__replay"
                type="button"
                onClick={() => setDemonstrationStage(0)}
              >
                <Icon name="history" size={14} />
                Replay
              </button>
            </div>
            <figcaption id="product-demo-caption">
              A locally animated explanation of the governed request loop. No backend request or
              production action is made.
            </figcaption>
          </figure>
        </section>

        <section className="landing-principle-strip" aria-label="Core product statement">
          <div className="landing-shell">
            <span>Identity establishes who</span>
            <i aria-hidden="true" />
            <strong>Mandates decide what</strong>
            <i aria-hidden="true" />
            <span>Receipts preserve why</span>
          </div>
        </section>

        <section
          className="landing-section"
          id="why"
          aria-labelledby="why-title"
          data-landing-reveal
        >
          <div className="landing-shell">
            <p className="landing-eyebrow">01 · Why Playroom</p>
            <div className="landing-section-heading">
              <h2 id="why-title">Collaboration needs more than another pipe.</h2>
              <p>
                Transport can move a message. Playroom supplies the operational contract around it.
              </p>
            </div>
            <div className="landing-question-grid">
              {[
                [
                  'Who does the agent represent?',
                  'A room member is bound to a principal, independent of its current route.',
                ],
                [
                  'What can it see?',
                  'Private principal context stays private; promoted common ground is explicit.',
                ],
                ['What may it do?', 'A signed mandate scopes actions and denies by default.'],
                [
                  'Who approves protected work?',
                  'The named human signer receives a bounded co-sign decision.',
                ],
                [
                  'What proves what happened?',
                  'Ordered events and audit-chain receipts preserve the outcome.',
                ],
              ].map(([question, answer], index) => (
                <article key={question}>
                  <span>0{index + 1}</span>
                  <h3>{question}</h3>
                  <p>{answer}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section
          className="landing-section landing-section--tint"
          id="how-it-works"
          aria-labelledby="loop-title"
          data-landing-reveal
        >
          <div className="landing-shell">
            <p className="landing-eyebrow">02 · Governed collaboration loop</p>
            <div className="landing-section-heading">
              <h2 id="loop-title">Select a boundary. See the system state.</h2>
              <p>
                Each stage is distinct, inspectable, and represented with text and shape as well as
                colour.
              </p>
            </div>
            <div className="landing-trust-explorer">
              <div
                className="landing-trust-tabs"
                role="tablist"
                aria-label="Governed collaboration stages"
              >
                {trustStages.map((stage, index) => (
                  <button
                    id={`landing-trust-tab-${index}`}
                    key={stage.label}
                    type="button"
                    role="tab"
                    aria-selected={activeStage === index}
                    aria-controls="landing-trust-panel"
                    tabIndex={activeStage === index ? 0 : -1}
                    data-tone={stage.tone}
                    onKeyDown={(event) => moveTrustTab(event, index)}
                    onClick={() => setActiveStage(index)}
                  >
                    <span>0{index + 1}</span>
                    <Icon name={stage.icon} />
                    <strong>{stage.label}</strong>
                    <Icon name="arrow" size={14} />
                  </button>
                ))}
              </div>
              <div
                id="landing-trust-panel"
                className="landing-trust-panel"
                role="tabpanel"
                aria-labelledby={`landing-trust-tab-${activeStage}`}
                data-tone={selectedStage.tone}
                key={selectedStage.label}
              >
                <div className="landing-trust-panel__visual" aria-hidden="true">
                  <span>
                    <Icon name="identity" />
                    Principal
                  </span>
                  <i />
                  <span>
                    <Icon name={selectedStage.icon} />
                    {selectedStage.label}
                  </span>
                  <i />
                  <span>
                    <Icon name="receipt" />
                    Record
                  </span>
                </div>
                <p className="landing-trust-panel__kicker">Boundary 0{activeStage + 1}</p>
                <h3>{selectedStage.title}</h3>
                <p>{selectedStage.copy}</p>
                <dl>
                  <div>
                    <dt>Input</dt>
                    <dd>
                      <code>{selectedStage.input}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>System state</dt>
                    <dd>
                      <code>{selectedStage.output}</code>
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>
        </section>

        <section
          className="landing-section"
          id="trust"
          aria-labelledby="mandate-title"
          data-landing-reveal
        >
          <div className="landing-shell landing-mandate-layout">
            <div className="landing-mandate-copy">
              <p className="landing-eyebrow">03 · Interactive mandate lab</p>
              <h2 id="mandate-title">Try to outrun the mandate.</h2>
              <p>
                Claude is granted review and comment. Choose a local example to see how the same
                mandate classifies a request.
              </p>
              <div className="landing-local-label">
                <Icon name="shield" />
                Concept demonstration only · no request leaves this page
              </div>
            </div>
            <div className="landing-mandate-lab">
              <div
                className="landing-mandate-controls"
                role="group"
                aria-label="Example mandate actions"
              >
                {(Object.keys(mandateActions) as Array<keyof typeof mandateActions>).map((key) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={mandateAction === key}
                    onClick={() => setMandateAction(key)}
                  >
                    {mandateActions[key].label}
                  </button>
                ))}
              </div>
              <div
                className="landing-mandate-result"
                data-verdict={selectedAction.verdict}
                aria-live="polite"
                key={selectedAction.code}
              >
                <div>
                  <span>Action request</span>
                  <code>{selectedAction.code}</code>
                </div>
                <Icon name="arrow" />
                <div>
                  <strong>{selectedAction.verdict}</strong>
                  <p>{selectedAction.detail}</p>
                </div>
              </div>
              <p className="landing-mandate-definition">
                <strong>Mandate:</strong> a signed, versioned, time-bounded authority document that
                says which actions a member may request in the room.
              </p>
            </div>
          </div>
        </section>

        <section
          className="landing-section landing-section--tint"
          id="product"
          aria-labelledby="product-title"
          data-landing-reveal
        >
          <div className="landing-shell">
            <p className="landing-eyebrow">04 · Connected to the working product</p>
            <div className="landing-section-heading">
              <h2 id="product-title">The public story opens into a real room.</h2>
              <p>
                These capabilities exist in the repository today. The page keeps the governed
                collaboration loop prominent and the supporting system quiet.
              </p>
            </div>
            <div className="landing-product-proof">
              <article data-tone="blue">
                <span>Room</span>
                <h3>People and agents share one ordered thread.</h3>
                <p>
                  Working rooms include human and agent membership, messages, streamed agent turns,
                  tasks, handoffs, summons, interrupts, and spend visibility.
                </p>
              </article>
              <article data-tone="orange">
                <span>Authority</span>
                <h3>Protected work becomes a human decision.</h3>
                <p>
                  Signed mandates, deny-by-default evaluation, and co-sign decisions bind authority
                  to the requested action.
                </p>
              </article>
              <article data-tone="purple">
                <span>Continuity</span>
                <h3>The room retains more than conversation.</h3>
                <p>
                  Standing orders, briefings and documents, promoted common ground, and ordered
                  canonical events preserve the working context.
                </p>
              </article>
            </div>
            <ul
              className="landing-capability-list"
              aria-label="Additional implemented capabilities"
            >
              <li>
                <Icon name="check" />
                Web Push subscription support
              </li>
              <li>
                <Icon name="check" />
                Audit-chain receipts through API and MCP
              </li>
              <li>
                <Icon name="check" />
                MCP and OAuth
              </li>
              <li>
                <Icon name="check" />
                Local-node leases and gated node-operation decisions
              </li>
            </ul>
          </div>
        </section>

        <section
          className="landing-section"
          id="limits"
          aria-labelledby="limits-title"
          data-landing-reveal
        >
          <div className="landing-shell landing-limits">
            <div>
              <p className="landing-eyebrow">05 · Honest boundaries</p>
              <h2 id="limits-title">Bounded authority, not magical safety.</h2>
            </div>
            <dl className="landing-limit-list">
              <div>
                <dt>Human identity</dt>
                <dd>Credential- and process-based; not strong real-person verification.</dd>
              </div>
              <div>
                <dt>Receipt verification</dt>
                <dd>
                  Available through API and MCP; the complete public verification interface remains
                  planned.
                </dd>
              </div>
              <div>
                <dt>Local nodes</dt>
                <dd>
                  Authority controls compliant execution through the sanctioned path, not arbitrary
                  rogue local processes.
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <section
          className="landing-section landing-section--line"
          id="roadmap"
          aria-labelledby="roadmap-title"
          data-landing-reveal
        >
          <div className="landing-shell">
            <p className="landing-eyebrow">06 · Planned, not claimed</p>
            <div className="landing-section-heading">
              <h2 id="roadmap-title">Future surfaces stay visibly future.</h2>
              <p>
                These capabilities are architectural direction or roadmap work. They are not
                presented as available entry points.
              </p>
            </div>
            <ul className="landing-roadmap-list">
              {roadmapItems.map((item) => (
                <li key={item}>
                  {item}
                  <span>Planned</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="landing-final-cta" aria-labelledby="start-title" data-landing-reveal>
          <div className="landing-shell landing-final-cta__inner">
            <div>
              <p className="landing-eyebrow">Open the front door</p>
              <h2 id="start-title">
                Create a governed room, or enter one you have been invited to.
              </h2>
            </div>
            <div className="landing-hero__actions">
              <Link
                className="landing-button landing-button--primary landing-button--large"
                href="/start"
              >
                Create a room <Icon name="arrow" />
              </Link>
              <Link
                className="landing-button landing-button--quiet landing-button--large"
                href="/join"
              >
                Join a room
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-shell landing-footer__main">
          <div>
            <Link className="landing-brand" href="/">
              <span className="landing-brand__mark" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>Playroom</span>
            </Link>
            <p>A governed collaboration room for people and AI agents.</p>
          </div>
          <nav aria-label="Footer navigation">
            <a href="#why">Why Playroom</a>
            <a href="#how-it-works">How it works</a>
            <a href="#trust">Trust and authority</a>
            <a href="#roadmap">Roadmap</a>
          </nav>
        </div>
        <div className="landing-shell landing-footer__bottom">
          <span>© 2026 Playroom</span>
          <span>Built to outlive any one host, model, or connector.</span>
          <a href="#main-content">Back to top</a>
        </div>
      </footer>
    </div>
  );
}
