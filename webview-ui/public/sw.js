/* agty (T-0039): Web Push. Shows the daemon's notice (title, body, the
 * character's id, the url of what it opens: never transcript text); a click
 * focuses an open office and opens that place (T-0043: a conversation, a job,
 * a Codex task, or the character), or opens the office at it. Nothing is cached. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// O3: a body may carry {time}: the event's own time, in this device's time zone.
function pushBody(data) {
  const body = typeof data.body === 'string' ? data.body : '';
  if (typeof data.at !== 'number' || !body.includes('{time}')) return body;
  return body.replace('{time}', new Date(data.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
}

// A picture link is a same-origin path the daemon signed; a browser whose notifications have no
// `image` (iOS Safari, Firefox) shows none, and says "[사진]" in the body instead.
function pushImage(data) {
  const ok = typeof data.image === 'string' && data.image.startsWith('/') && !data.image.startsWith('//');
  return ok && 'image' in Notification.prototype ? data.image : null;
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Not a agty payload: a plain notice.
  }
  const agentId = typeof data.agentId === 'number' ? data.agentId : null;
  // Same-origin paths only: a url is never followed off this office.
  const url =
    typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//')
      ? data.url
      : agentId === null
        ? '/'
        : `/?agent=${agentId}`;
  const image = pushImage(data);
  let body = pushBody(data);
  if (!image && typeof data.imageLabel === 'string' && !body.includes(data.imageLabel))
    body = body ? `${body}\n${data.imageLabel}` : data.imageLabel;
  event.waitUntil(
    self.registration.showNotification(typeof data.title === 'string' ? data.title : 'Agent Tycoon', {
      body,
      ...(image && { image }),
      // The daemon's tag: the same event again replaces the one shown instead of stacking.
      // renotify: the replacement still alerts (a new ask must not arrive silently).
      tag: typeof data.tag === 'string' && data.tag ? data.tag : agentId === null ? 'agty' : `agent-${agentId}`,
      renotify: true,
      icon: '/icons/icon-256.png?v=3',
      data: { agentId, url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const agentId = typeof data.agentId === 'number' ? data.agentId : null;
  const url = typeof data.url === 'string' ? data.url : agentId === null ? '/' : `/?agent=${agentId}`;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        // focus() may be refused (no user activation): the message goes anyway.
        await open.focus().catch(() => undefined);
        open.postMessage({ type: 'agty-open', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
