// The Inbox on the admin page: everything Axis recorded for a person (agent messages, reminders, questions, system and webhook notices).
// Titles and bodies come from outside (webhooks), so they are drawn as text only: no HTML, no markdown, no links.

import { html, useState } from "/web/preact.js";
import { Button, api, ask, enc } from "/web/adm-core.js";
import { PAGES, PageHead } from "/web/adm-shell.js";
import { Loading, useLoad } from "/web/adm-agent.js";

/** The unread count beside Inbox in the menu. */
export function useUnread() {
  const [data] = useLoad("/admin/notifications?unread=1&limit=1", 10_000);
  return data?.unread ?? 0;
}

export function InboxPage() {
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const query = `/admin/notifications?limit=100${source ? `&source=${enc(source)}` : ""}${name ? `&name=${enc(name)}` : ""}`;
  const [data, load, error] = useLoad(query, 10_000);
  const items = data?.items ?? [];
  const sources = data?.sources ?? [];
  const names = [...new Set(sources.filter((s) => !source || s.source === source).map((s) => s.name ?? s.from).filter(Boolean))];
  const act = async (action, body) => {
    await api("POST", `/admin/notifications/${action}`, body);
    await load();
  };
  const dismissAll = async () => {
    const scope = [source, name].filter(Boolean).join(" · ");
    if (!(await ask({ title: "Dismiss everything?", body: `This removes ${scope ? `every notice from ${scope}` : "every notice"} from the inbox, read or not.`, confirm: "Dismiss all", danger: true }))) return;
    await act("dismiss", { all: true, ...(source ? { source } : {}), ...(name ? { name } : {}) });
  };
  const sourceNames = [...new Set(sources.map((s) => s.source).filter(Boolean))];
  return html`<div class="page" id="inbox-page">
    <${PageHead} title=${PAGES.inbox.title} purpose=${PAGES.inbox.purpose} />
    ${error ? html`<p class="help bad">${error}</p>` : null}
    <div class="inbox-bar">
      <select class="field" aria-label="Source" data-inbox-source value=${source} onChange=${(e) => { setSource(e.currentTarget.value); setName(""); }}>
        <option value="">All sources</option>
        ${sourceNames.map((s) => html`<option key=${s} value=${s}>${s}</option>`)}
      </select>
      <select class="field" aria-label="Name" data-inbox-name value=${name} onChange=${(e) => setName(e.currentTarget.value)}>
        <option value="">Any name</option>
        ${names.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
      </select>
      <span class="dim sm">${data ? `${data.unread} unread` : ""}</span>
      <${Button} disabled=${!data?.unread} run=${() => act("read", { all: true, ...(source ? { source } : {}), ...(name ? { name } : {}) })}>Mark all read</${Button}>
      <${Button} class="btn danger" disabled=${!items.length} run=${dismissAll}>Dismiss all</${Button}>
    </div>
    ${!data ? html`<${Loading} />` : !items.length ? html`<p class="help" data-inbox-empty>Nothing in the inbox.</p>` : html`
      <section class="card"><div class="inbox-list">
        ${items.map((n) => html`<div key=${n.id} class=${`inbox-item${n.unread ? " unread" : ""}`} data-inbox-item=${n.id}>
          <div class="inbox-head">
            <b class="inbox-title">${n.title || n.from}</b>
            <span class="badge">${n.from}</span>
            ${n.priority && n.priority !== "normal" ? html`<span class=${`badge ${n.priority === "urgent" ? "bad" : ""}`}>${n.priority}</span>` : null}
            ${n.status && n.status !== "sent" ? html`<span class="badge">${n.status}</span>` : null}
            ${(n.devices ?? []).map((d) => html`<span class="badge" key=${d.name} title=${`${d.route} · ${d.state}`}>${d.name}</span>`)}
            <span class="dim sm">${n.age} ago</span>
          </div>
          ${n.body ? html`<div class="inbox-body">${n.body}</div>` : null}
          <div class="inbox-acts">
            ${n.unread ? html`<${Button} run=${() => act("read", { ids: [n.id] })}>Mark read</${Button}>` : null}
            <${Button} run=${() => act("dismiss", { ids: [n.id] })}>Dismiss</${Button}>
          </div>
        </div>`)}
      </div></section>`}
  </div>`;
}
