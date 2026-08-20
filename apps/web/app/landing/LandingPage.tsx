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
    copy: 'An agent is bound to the person it acts for before it can do anything here — so every action traces to someone. People sign in with a credential, short of full identity verification.',
    input: 'member: claude.prince',
    output: 'principal: prince',
  },
  {
    label: 'Context',
    icon: 'context' as IconName,
    tone: 'purple' as Tone,
    title: 'Share the brief, not the private history.',
    copy: 'Everyone keeps their own private context. Only what someone deliberately promotes becomes shared ground the whole room can see.',
    input: 'private: principal/prince',
    output: 'room: promoted excerpt',
  },
  {
    label: 'Mandate',
    icon: 'mandate' as IconName,
    tone: 'green' as Tone,
    title: 'Evaluate authority before action.',
    copy: 'Every action is checked against a mandate a human signed and scoped. Anything not clearly granted is denied.',
    input: 'action: pr.merge',
    output: 'verdict: CO_SIGN',
  },
  {
    label: 'Co-sign',
    icon: 'shield' as IconName,
    tone: 'orange' as Tone,
    title: 'Protected work waits for the right person.',
    copy: 'A protected action waits for the signer the decision names. The agent cannot turn silence into approval.',
    input: 'required signer: prince',
    output: 'decision: approved',
  },
  {
    label: 'Receipt',
    icon: 'receipt' as IconName,
    tone: 'purple' as Tone,
    title: 'Keep durable evidence of the outcome.',
    copy: 'Every outcome leaves a tamper-evident receipt in an append-only record. You can verify it through the API and MCP today; a full in-app view is on the way.',
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
  'Bring a room into GitHub, email, and other agents',
  'Work alongside ChatGPT and Claude from inside a room',
  'Verify any receipt yourself, without trusting us',
  'Screen what comes in before an agent ever sees it',
  'Catch sensitive data before it can leave the room',
  'Keep the same room consistent across machines',
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
  const [activeStage, setActiveStage] = useState(0);
  const [mandateAction, setMandateAction] = useState<keyof typeof mandateActions>('merge');
  const [demonstrationStage, setDemonstrationStage] = useState(0);
  const [demoPaused, setDemoPaused] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
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

    return () => {
      observer?.disconnect();
    };
  }, []);

  // The product walkthrough auto-advances — but WCAG 2.2.2 (Pause, Stop, Hide) says any auto-moving
  // content over 5s needs a control to stop it, and reduced-motion is not enough (it only covers
  // people who set that preference). This timer lives in its own effect keyed on `demoPaused` so the
  // pause button genuinely halts it, and it is skipped entirely under reduced motion.
  useEffect(() => {
    if (demoPaused) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => {
      setDemonstrationStage((stage) => (stage + 1) % demonstrationStages.length);
      // 3.6s, not 1.8s: a stage carries a heading + a sentence, and the old cadence flipped it before it
      // could be read. Slower default; the pause control and Replay are there for anyone who wants them.
    }, 3600);
    return () => window.clearInterval(timer);
  }, [demoPaused]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    // While the flyout is open, lock background scroll and make the page content INERT — so a keyboard
    // user tabbing past the last nav link cannot land in the hero underneath, and touch/keyboard scroll
    // of the page behind the overlay is disabled. Both are restored when the menu closes.
    const main = document.getElementById('main-content');
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    main?.setAttribute('inert', '');
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      document.body.style.overflow = prevOverflow;
      main?.removeAttribute('inert');
    };
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
              Governed collaboration
            </p>
            <h1 id="landing-title">Agents can move fast. Authority stays clear.</h1>
            <p className="landing-hero__lede">
              People and AI agents work in one room. Every action is checked against a mandate a
              human signed, and everything that happens is on the record.
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
                    {String(demonstrationStage + 1).padStart(2, '0')} /{' '}
                    {String(demonstrationStages.length).padStart(2, '0')}
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
              <div className="landing-product-demo__controls">
                <button
                  className="landing-product-demo__replay"
                  type="button"
                  onClick={() => setDemoPaused((paused) => !paused)}
                >
                  {demoPaused ? 'Play the walkthrough' : 'Pause the walkthrough'}
                </button>
                <button
                  className="landing-product-demo__replay"
                  type="button"
                  onClick={() => {
                    setDemonstrationStage(0);
                    setDemoPaused(false);
                  }}
                >
                  <Icon name="history" size={14} />
                  Replay
                </button>
              </div>
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
                Chat tools move messages. Playroom adds the rules around them — who&rsquo;s acting,
                what they may do, and what it leaves behind.
              </p>
            </div>
            <div className="landing-question-grid">
              {[
                [
                  'Who does the agent represent?',
                  'Every agent acts for a specific person — and that binding follows it, however it connected.',
                ],
                [
                  'What can it see?',
                  "Each person's private context stays private. Only what someone shares becomes common ground.",
                ],
                [
                  'What may it do?',
                  'A mandate a human signed says what it may do. Anything else is denied.',
                ],
                [
                  'Who approves protected work?',
                  'The specific person the mandate names — they get a decision to approve or deny.',
                ],
                [
                  'What proves what happened?',
                  'An append-only record and a tamper-evident receipt for every outcome.',
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
              <h2 id="loop-title">Pick a boundary. Watch it hold.</h2>
              <p>Each step stands on its own — shown in words and shape, never colour alone.</p>
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
                tabIndex={0}
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
                Everything here already works. The page keeps the important part loud and the
                plumbing quiet.
              </p>
            </div>
            <div className="landing-product-proof">
              <article data-tone="blue">
                <span>Room</span>
                <h3>People and agents share one ordered thread.</h3>
                <p>
                  A room holds people and agents together — messages, live agent replies, tasks and
                  handoffs, interruptions, and what each turn costs.
                </p>
              </article>
              <article data-tone="orange">
                <span>Authority</span>
                <h3>Protected work becomes a human decision.</h3>
                <p>
                  A signed mandate decides each action, and anything protected pauses for the right
                  person to sign.
                </p>
              </article>
              <article data-tone="purple">
                <span>Continuity</span>
                <h3>The room retains more than conversation.</h3>
                <p>
                  Standing orders, briefings, shared documents, and an ordered record keep the
                  room&rsquo;s context between sessions.
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
                Revoke a machine&rsquo;s lease and its next action fails
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
                <dd>
                  People sign in with a credential — enough to attribute actions, not full identity
                  verification.
                </dd>
              </div>
              <div>
                <dt>Receipt verification</dt>
                <dd>
                  Verify receipts through the API and MCP today; a full in-app view is still to
                  come.
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
            <p className="landing-eyebrow">06 · Built, not overclaimed</p>
            <div className="landing-section-heading">
              <h2 id="roadmap-title">The roadmap, built — and still labelled honestly.</h2>
              <p>
                Each of these is now built and governed on main, with tests and a decision record.
                The ones that reach outside a room — posting to GitHub or email, driving a hosted
                model, reconciling a second host — run against a mock until you wire the real
                credential or host. The page won&rsquo;t pretend they do more than that.
              </p>
            </div>
            <ul className="landing-roadmap-list">
              {roadmapItems.map((item) => (
                <li key={item}>
                  {item}
                  <span>Built</span>
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
