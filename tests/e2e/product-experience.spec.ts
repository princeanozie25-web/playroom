import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { makePool } from '../../apps/api/src/db.js';
import { admitMember } from '../../apps/api/src/events.js';
import { issueCredential } from '../../apps/api/src/credentials.js';
import { mintRoomCode } from '../../apps/api/src/room-codes.js';

test.describe.configure({ mode: 'serial' });

const databaseUrl = (): string => {
  const value = process.env.PLAYROOM_E2E_DATABASE_URL;
  if (!value) throw new Error('E2E database coordinate was not supplied by global setup');
  return value;
};

const apiUrl = (): string => {
  const value = process.env.PLAYROOM_E2E_API_URL;
  if (!value) throw new Error('E2E API coordinate was not supplied by global setup');
  return value;
};

async function expectNoSeriousAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations,
    result.violations.map((violation) => `${violation.id}: ${violation.help}`).join('\n'),
  ).toEqual([]);
}

function observeBrowserProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const source = message.location().url;
      problems.push(`console${source ? ` (${source})` : ''}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    const resourceType = response.request().resourceType();
    if (
      response.status() >= 400 &&
      ['script', 'stylesheet', 'image', 'font'].includes(resourceType)
    ) {
      problems.push(`${resourceType}: ${response.status()} ${response.url()}`);
    }
  });
  return problems;
}

function expectNoBrowserProblems(problems: string[]): void {
  expect(problems, problems.join('\n')).toEqual([]);
}

async function createRoomFromBrowser(page: Page, roomId: string): Promise<void> {
  let requests = 0;
  await page.route('**/api/rooms', async (route) => {
    requests += 1;
    await new Promise((resolve) => setTimeout(resolve, 180));
    await route.continue();
  });
  await page.goto('/start');
  await page.getByLabel('Room name').fill('Browser E2E room');
  await page.getByLabel(/Room slug/).fill(roomId);
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.getByRole('button', { name: 'Creating room…' })).toBeDisabled();
  await expect(page).toHaveURL(new RegExp(`/r/${roomId}$`), { timeout: 30_000 });
  expect(requests).toBe(1);
  await page.unroute('**/api/rooms');
  await expect(page.getByText('connected', { exact: true })).toBeVisible();
}

let roomId = '';
let creator: BrowserContext;
let creatorPage: Page;
let joiner: BrowserContext;
let joinerPage: Page;

test('public front door is operable, responsive, persistent, and reduced-motion safe', async ({
  browser,
}) => {
  const firstVisit = await browser.newContext({ colorScheme: 'dark' });
  const page = await firstVisit.newPage();
  const problems = observeBrowserProblems(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-landing-theme', 'dark');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create a room' }).first()).toHaveAttribute(
    'href',
    '/start',
  );
  await expect(page.getByRole('link', { name: 'Join a room' }).first()).toHaveAttribute(
    'href',
    '/join',
  );
  await expectNoSeriousAxeViolations(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);

  await page.reload();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main-content$/);

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await page.goto('/start');
  await expect(page.locator('html')).toHaveAttribute('data-landing-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-landing-theme', 'light');
  expectNoBrowserProblems(problems);
  problems.length = 0;

  await page.route('**/api/rooms', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'credential_required', message: 'not configured' }),
    }),
  );
  await page.getByLabel('Room name').fill('Unavailable local room');
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.locator('#create-room-error')).toContainText(/run the local bootstrap/i);
  await page.unroute('**/api/rooms');
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('/api/rooms');
  expect(problems[0]).toContain('500');
  await firstVisit.close();

  const reduced = await browser.newContext({ reducedMotion: 'reduce' });
  const reducedPage = await reduced.newPage();
  const reducedProblems = observeBrowserProblems(reducedPage);
  await reducedPage.goto('/');
  const animationName = await reducedPage
    .locator('.landing-product-demo')
    .evaluate((node) => getComputedStyle(node).animationName);
  expect(animationName).toBe('none');
  expectNoBrowserProblems(reducedProblems);
  await reduced.close();
});

test('create, join, live messaging, reconnect, and co-sign work end to end', async ({
  browser,
}) => {
  roomId = `e2e-${Date.now()}`;
  creator = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  creatorPage = await creator.newPage();
  const creatorProblems = observeBrowserProblems(creatorPage);
  await createRoomFromBrowser(creatorPage, roomId);

  const pool = makePool(databaseUrl());
  let agentCredentialId = '';
  try {
    await admitMember(pool, roomId, 'claude-code');
    await admitMember(pool, roomId, 'claude-main');
    await admitMember(pool, roomId, 'sol');

    const expired = await mintRoomCode(pool, {
      roomId,
      principalId: 'principal:guest-b',
      label: 'expired browser e2e',
      codeHours: 1,
      credentialHours: 1,
      createdBy: 'prince',
    });
    await pool.query(
      "UPDATE room_codes SET expires_at = now() - interval '1 minute' WHERE code = $1",
      [expired.code],
    );
    const valid = await mintRoomCode(pool, {
      roomId,
      principalId: 'principal:guest-a',
      label: 'valid browser e2e',
      codeHours: 1,
      credentialHours: 1,
      createdBy: 'prince',
    });

    joiner = await browser.newContext({ viewport: { width: 390, height: 844 } });
    joinerPage = await joiner.newPage();
    const joinerProblems = observeBrowserProblems(joinerPage);
    await joinerPage.goto('/join');
    await joinerPage.getByLabel(/Your code/i).fill('ZZZZ');
    await joinerPage.getByLabel(/first name/i).fill('Amara');
    await joinerPage.getByRole('button', { name: 'Enter the room' }).click();
    await expect(joinerPage.locator('#join-error')).toBeVisible();

    await joinerPage.getByLabel(/Your code/i).fill(expired.code);
    await joinerPage.getByRole('button', { name: 'Enter the room' }).click();
    // Expired and unknown codes are intentionally indistinguishable to the caller.
    await expect(joinerPage.locator('#join-error')).toContainText(/check it with whoever sent it/i);
    const expectedJoinRefusals = joinerProblems.filter(
      (problem) => problem.includes('/api/join') && problem.includes('404'),
    );
    expect(expectedJoinRefusals).toHaveLength(2);
    for (const expectedProblem of expectedJoinRefusals) {
      joinerProblems.splice(joinerProblems.indexOf(expectedProblem), 1);
    }

    await joinerPage.getByLabel(/Your code/i).fill(valid.code);
    await joinerPage.getByRole('button', { name: 'Enter the room' }).click();
    await expect(joinerPage.getByRole('button', { name: 'Letting you in…' })).toBeDisabled();
    await expect(joinerPage).toHaveURL(new RegExp(`/r/${roomId}\\?welcome=1$`));
    await expect(joinerPage.getByText('connected', { exact: true })).toBeVisible();
    expect(await joinerPage.evaluate(() => document.cookie)).not.toContain('playroom_member');
    const session = (await joiner.cookies()).find((cookie) => cookie.name === 'playroom_member');
    expect(session?.httpOnly).toBe(true);

    const creatorMessage = `creator message ${randomUUID()}`;
    await creatorPage.getByLabel('Message the room').fill(creatorMessage);
    await creatorPage.getByRole('button', { name: 'Send' }).click();
    await expect(joinerPage.getByText(creatorMessage)).toBeVisible();

    const joinerMessage = `joiner message ${randomUUID()}`;
    await joinerPage.getByLabel('Message the room').fill(joinerMessage);
    await joinerPage.getByRole('button', { name: 'Send' }).click();
    await expect(creatorPage.getByText(joinerMessage)).toBeVisible();
    await joinerPage.reload();
    await expect(joinerPage.getByText(creatorMessage)).toHaveCount(1);
    await expect(joinerPage.getByText(joinerMessage)).toHaveCount(1);
    await expect(joinerPage.getByLabel('Message the room')).toBeInViewport();

    const agent = await issueCredential(pool, 'claude-code', 'browser e2e agent', 1);
    agentCredentialId = agent.id;
    const decision = await fetch(`${apiUrl()}/rooms/${roomId}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agent.token}` },
      body: JSON.stringify({ action: 'pr.merge', resource: 'repo:playroom#e2e' }),
    });
    expect(decision.status).toBe(200);
    await expect(creatorPage.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(
      joinerPage.getByText(/Awaiting Prince to approve or deny pr\.merge/),
    ).toBeVisible();
    await expect(joinerPage.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await creatorPage.getByRole('button', { name: 'Approve' }).click();
    await expect(creatorPage.getByText(/Approved by Prince/)).toBeVisible();
    await expect(joinerPage.getByText(/Approved by Prince/)).toBeVisible();

    const deniedDecision = await fetch(`${apiUrl()}/rooms/${roomId}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agent.token}` },
      body: JSON.stringify({ action: 'pr.merge', resource: 'repo:playroom#e2e-deny' }),
    });
    expect(deniedDecision.status).toBe(200);
    await creatorPage.getByRole('button', { name: 'Deny' }).click();
    await expect(creatorPage.getByText(/Denied by Prince/)).toBeVisible();
    await expect(joinerPage.getByText(/Denied by Prince/)).toBeVisible();
    await expectNoSeriousAxeViolations(creatorPage);
    expectNoBrowserProblems(creatorProblems);
    expectNoBrowserProblems(joinerProblems);
  } finally {
    if (agentCredentialId) {
      await pool.query('DELETE FROM member_credentials WHERE id = $1', [agentCredentialId]);
    }
    await pool.end();
  }
});

test('standing orders expose real create, edit, pause, resume, revoke, and error states', async () => {
  test.skip(!creatorPage || !roomId, 'create journey did not complete');
  const standingProblems = observeBrowserProblems(creatorPage);
  await creatorPage.goto(`/r/${roomId}/loops`);
  await expect(creatorPage.getByText('No standing orders yet.')).toBeVisible();

  await creatorPage.getByLabel('Objective for every cycle').fill('Review the next replay guard');
  await creatorPage.getByLabel('Trigger agent').selectOption('claude-main');
  await creatorPage.getByLabel('Agent to summon').selectOption('sol');
  await expect(creatorPage.getByRole('button', { name: 'Create standing order' })).toBeDisabled();
  await creatorPage.getByLabel(/Cycle cap/).fill('5');
  await creatorPage.getByRole('button', { name: 'Create standing order' }).click();
  await expect(
    creatorPage.locator('.loop-row').getByText('Review the next replay guard'),
  ).toBeVisible();

  await creatorPage.getByRole('button', { name: 'Pause' }).click();
  await expect(creatorPage.getByRole('button', { name: 'Resume' })).toBeVisible();
  await creatorPage.getByRole('button', { name: 'Resume' }).click();
  await expect(creatorPage.getByRole('button', { name: 'Pause' })).toBeVisible();
  await creatorPage.getByRole('button', { name: 'Edit' }).click();
  await creatorPage.locator('.loop-edit-form').getByLabel('Attendance dial').fill('2');
  await creatorPage.getByRole('button', { name: /Save — effective next cycle/ }).click();
  await expect(creatorPage.getByText(/dial 2/)).toBeVisible();

  await creatorPage.getByRole('button', { name: 'Revoke' }).click();
  await expect(creatorPage.getByText('revoked', { exact: true })).toBeVisible();
  expectNoBrowserProblems(standingProblems);
  standingProblems.length = 0;

  await creatorPage.route(`**/api/rooms/${roomId}/orders`, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"offline"}',
    });
  });
  await creatorPage.getByLabel('Objective for every cycle').fill('Show the failure state');
  await creatorPage.getByLabel('Trigger agent').selectOption('claude-main');
  await creatorPage.getByLabel('Agent to summon').selectOption('sol');
  await creatorPage.getByRole('button', { name: 'Create standing order' }).click();
  await expect(creatorPage.locator('.loops-error')).toBeVisible();
  await creatorPage.unroute(`**/api/rooms/${roomId}/orders`);
  expect(standingProblems).toHaveLength(1);
  expect(standingProblems[0]).toContain(`/api/rooms/${roomId}/orders`);
  expect(standingProblems[0]).toContain('503');
  await expectNoSeriousAxeViolations(creatorPage);
});

test('entry, fixture, 404, and theme surfaces remain accessible', async ({ page }) => {
  const problems = observeBrowserProblems(page);
  for (const route of ['/start', '/join', '/dev/decision-card', '/route-that-does-not-exist']) {
    await page.goto(route);
    await expectNoSeriousAxeViolations(page);
  }
  await expect(page.getByText(/404 · Route not found/)).toBeVisible();
  const expectedNotFound = problems.filter(
    (problem) => problem.includes('/route-that-does-not-exist') && problem.includes('404'),
  );
  expect(expectedNotFound).toHaveLength(1);
  problems.splice(problems.indexOf(expectedNotFound[0]), 1);
  expectNoBrowserProblems(problems);
});

test.afterAll(async () => {
  await joiner?.close();
  await creator?.close();
});
