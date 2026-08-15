// THE SERVICE WORKER — S-PUSH. It exists to do exactly one thing: show a notification when the
// room is closed, and open the room when it is tapped.
//
// ── WHY THIS FILE IS SO SMALL, AND MUST STAY SO ──────────────────────────────────────
//
// A service worker sits between every request this origin makes and the network. That is a lot of
// power for a file whose job is a notification, so this one takes NONE of it: there is no `fetch`
// handler, no cache, no offline shell. Adding one would mean the page a person sees could come from
// here rather than from the server, and a room that renders from a cache is a room that can show a
// briefing, a decision or a spend figure that is no longer true. The app is not offline-capable and
// this file must not quietly make it look like it is.
//
// ── WHAT IT IS ALLOWED TO KNOW ───────────────────────────────────────────────────────
//
// The payload carries a room id, an urgency word and a timestamp. Nothing else — no interrupt body,
// no briefing, no message text, no mandate content (S-PUSH's payload ruling). So the notification
// says that something needs you, in which room, and when. WHAT it is lives in the room, behind the
// tap, where the fabric can decide who may read it.

self.addEventListener('push', (event) => {
  // A push with no data, or data this worker does not recognise, still deserves to surface: a
  // silent drop is the failure mode that makes a notification channel untrustworthy. So the
  // fallbacks below are deliberately vague rather than absent.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const room = typeof payload.room === 'string' ? payload.room : '';
  const urgency = payload.urgency === 'BLOCKER' ? 'BLOCKER' : 'DECISION';
  const at = typeof payload.at === 'string' ? payload.at : '';

  // The words are built HERE, from the three fields, and never sent over the wire — one less thing
  // travelling through a vendor's infrastructure.
  const title = urgency === 'BLOCKER' ? 'Someone is blocked' : 'Something needs a decision';
  const body = room ? `In ${room}. Open Playroom to see what.` : 'Open Playroom to see what.';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // A stable tag per room collapses a burst into one notification rather than a stack of them:
      // a loop that raises three hands in a minute should claim attention once.
      tag: room ? `playroom-${room}` : 'playroom',
      renotify: true,
      timestamp: at ? Date.parse(at) || Date.now() : Date.now(),
      data: { room },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const room = event.notification.data && event.notification.data.room;
  const url = room ? `/r/${encodeURIComponent(room)}` : '/';
  // Focus an existing tab on this origin rather than opening a second one — a person who already
  // has Playroom open does not want two of it.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes(url) && 'focus' in w) return w.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
