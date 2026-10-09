// Service worker for the VorteX Axis web client. It does one job: when Axis
// sends this browser a push message while the page is closed, show it as a
// notification, and carry the person's answer back when it was a question.
// Nothing is cached here: the page always loads fresh from Axis.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : "" };
  }
  const ask = message.ask;
  event.waitUntil(
    self.registration.showNotification(message.title || "Vortex", {
      body: message.body || "",
      tag: message.tag || "vortex",
      icon: "/web/icon-192.png",
      badge: "/web/icon-192.png",
      data: { ask },
      // A question stays until it is dealt with; a remark may fade.
      requireInteraction: Boolean(ask),
      // Buttons where the system has them (Android, desktop). An iPhone shows none: tapping opens the page, which offers the choices.
      actions: ask ? ask.choices.slice(0, 2).map((choice) => ({ action: `choice:${choice}`, title: choice })) : [],
    }).then(async () => {
      // The number on the app's icon: how many notifications are waiting to be read.
      const waiting = await self.registration.getNotifications();
      await self.navigator.setAppBadge?.(waiting.length || 1);
    }).catch(() => undefined),
  );
});

/** Sends a choice back to Axis. The token came in the notification and works once. */
function answer(ask, choice) {
  return fetch("/v1/push/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: ask.id, token: ask.token, choice }),
  });
}

self.addEventListener("notificationclick", (event) => {
  const ask = event.notification.data && event.notification.data.ask;
  event.notification.close();
  if (ask && event.action && event.action.startsWith("choice:")) {
    event.waitUntil(answer(ask, event.action.slice(7)).catch(() => undefined));
    return;
  }
  // Tapped the notification itself: bring the page forward, and hand it the question if there is one.
  const target = ask ? `/#ask=${encodeURIComponent(JSON.stringify(ask))}` : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).pathname === "/");
      if (open) {
        if (ask) open.postMessage({ ask });
        return open.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
