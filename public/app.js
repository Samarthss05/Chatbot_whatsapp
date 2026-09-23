const $ = (s) => document.querySelector(s);
let token = "",
  selected = null,
  page = 0,
  total = 0,
  view = "inbox",
  tz = "Asia/Singapore",
  refreshing = false;
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const drafts = new Map(),
  noteDrafts = new Map();
const labels = {
  NEW: "New contact",
  AWAITING_SLOT: "Choosing time",
  AWAITING_RESCHEDULE: "Changing time",
  BOOKING_PENDING: "Confirming",
  AWAITING_DETAILS: "Needs details",
  BOOKED: "Booked",
  HUMAN: "Needs a person",
  DECLINED: "Opted out",
  CANCELLED: "Cancelled",
  pending: "Confirming",
  confirmed: "Confirmed",
  cancel_pending: "Cancelling",
  cancelled: "Cancelled",
  failed: "Failed",
  dead: "Needs attention",
  retry: "Retry scheduled",
  queued: "Waiting",
  processing: "In progress",
};
const kind = {
  inbox: "Process message",
  wa: "Send reply",
  calendar_create: "Confirm calendar visit",
  calendar_cancel: "Cancel calendar visit",
  calendar_update: "Update visit details",
  notify: "Notify the team",
};
const badge = (s) =>
  `<span class="badge ${["HUMAN", "dead", "failed"].includes(s) ? "bad" : ["BOOKED", "confirmed", "done"].includes(s) ? "good" : ["AWAITING_DETAILS", "BOOKING_PENDING", "pending", "retry", "cancel_pending"].includes(s) ? "warning" : ""}">${esc(labels[s] || s)}</span>`;
const date = (value, short = false) => {
  if (!value) return "—";
  const d = new Date(
    typeof value === "string" && /^\d{4}-\d\d-\d\d \d/.test(value)
      ? value.replace(" ", "T") + "Z"
      : value,
  );
  return Number.isNaN(d.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en-SG", {
        timeZone: tz,
        month: "short",
        day: "numeric",
        ...(short ? {} : { hour: "numeric", minute: "2-digit" }),
      }).format(d);
};
function notice(text, error = false) {
  $("#notice").hidden = false;
  $("#notice").textContent = text;
  $("#notice").className = "notice" + (error ? " error-notice" : "");
}
async function api(path, body) {
  const res = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-admin-token": token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
function logout() {
  token = "";
  selected = null;
  drafts.clear();
  noteDrafts.clear();
  $("#workspace").hidden = true;
  $("#login").hidden = false;
  $("#access-token").value = "";
  $("#contacts").replaceChildren();
  $("#conversation").replaceChildren();
}
$("#logout").onclick = logout;
$("#mobile-logout").onclick = logout;
$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  token = $("#access-token").value.trim();
  $("#login-error").textContent = "";
  try {
    await refresh();
    $("#login").hidden = true;
    $("#workspace").hidden = false;
    $("#access-token").value = "";
  } catch (e) {
    token = "";
    $("#login-error").textContent = e.message;
  }
};
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [overview, leads] = await Promise.all([
      api("/overview"),
      api(
        "/leads?" +
          new URLSearchParams({
            q: $("#search").value,
            state: $("#state-filter").value,
            page,
          }),
      ),
    ]);
    tz = overview.timezone;
    $("#mode").textContent =
      overview.mode === "demo" ? "Demo · no messages sent" : "Live workspace";
    $("#connection").textContent = overview.worker.running
      ? "● Connected"
      : "● Worker offline";
    renderMetrics(overview);
    renderLeads(leads);
    renderAppointments(overview);
    renderIntegrations(overview);
    renderNotifications(overview.notifications);
    if (view === "operations") await loadOperations();
    if (
      selected &&
      !["TEXTAREA", "INPUT"].includes(document.activeElement.tagName)
    )
      await loadConversation(selected);
  } finally {
    refreshing = false;
  }
}
function renderMetrics(o) {
  const count = (s) => o.states.find((v) => v.state === s)?.count || 0;
  const sum = o.states.reduce((n, v) => n + v.count, 0);
  const failed = o.queues.find((q) => q.status === "dead")?.count || 0;
  const cards = [
    ["Active appointments", o.activeCount, "Confirmed or being arranged", "↗"],
    ["Conversations", sum, "Every shop, one shared view", "◫"],
    ["Needs a person", count("HUMAN"), "Ready for your personal touch", "✧"],
    [
      "Actions to review",
      failed,
      failed ? "Open activity & recovery" : "Everything is moving along",
      "◎",
    ],
  ];
  $("#metrics").innerHTML = cards
    .map(
      ([name, value, sub, icon]) =>
        `<article class="metric"><div class="metric-top"><span>${name}</span><span>${icon}</span></div><div class="metric-value">${value}</div><small>${sub}</small></article>`,
    )
    .join("");
}
function renderLeads(data) {
  total = data.total;
  $("#contact-count").textContent = total + " total";
  $("#contacts").innerHTML =
    data.items
      .map(
        (l) =>
          `<button class="contact ${selected === l.wa_id ? "selected" : ""}" data-contact="${esc(l.wa_id)}"><span class="avatar">${esc((l.shop_name || l.name || "?").slice(0, 1).toUpperCase())}</span><span class="contact-text"><span class="contact-name">${esc(l.shop_name || l.name || "New contact")}</span><span class="contact-phone">+${esc(l.wa_id)} · ${esc(l.lang.toUpperCase())}</span></span>${badge(l.state)}</button>`,
      )
      .join("") || '<p class="empty-list">No conversations here yet.</p>';
  $("#page-number").textContent =
    `${page + 1} / ${Math.max(1, Math.ceil(total / 50))}`;
  $("#previous").disabled = page === 0;
  $("#next").disabled = (page + 1) * 50 >= total;
}
async function loadConversation(id) {
  const data = await api("/leads/" + encodeURIComponent(id));
  if (selected !== id) return;
  const l = data.lead;
  const active = data.bookings.find((b) =>
    ["confirmed", "pending", "cancel_pending"].includes(b.status),
  );
  $("#conversation").innerHTML =
    `<div class="conversation-header"><div><h2>${esc(l.shop_name || l.name || "New contact")}</h2><p class="muted">+${esc(l.wa_id)} · ${esc(l.lang.toUpperCase())} ${badge(l.state)}</p></div><div class="actions"><button class="quiet" data-action="${l.human_takeover ? "resume" : "takeover"}" ${l.state === "DECLINED" ? "disabled" : ""}>${l.human_takeover ? "Resume assistant" : "Take over"}</button></div></div>${active ? `<div class="booking-strip"><span>▦ ${esc(date(active.start))} · ${esc(labels[active.status])}</span>${active.status === "confirmed" ? `<button class="quiet danger" data-cancel="${esc(active.id)}">Cancel visit</button>` : ""}</div>` : ""}<div class="messages">${data.messages.map((m) => `<div class="bubble ${m.direction === "out" ? "out" : ""}">${esc(m.body)}<small>${m.direction === "in" ? "Contact" : "Ledger"} · ${esc(date(m.at))}${m.delivery ? " · " + esc(m.delivery.status) : ""}</small></div>`).join("") || '<p class="empty-list">Messages will appear here.</p>'}</div><form id="reply-form" class="composer"><label for="reply-text">Your reply</label><textarea id="reply-text" maxlength="4096" placeholder="Write a personal reply…" ${!data.canReply || l.state === "DECLINED" ? "disabled" : ""} required>${esc(drafts.get(id) || "")}</textarea><div class="composer-bottom"><small>${!data.canReply ? "Reply window closed. Wait for a new message." : l.state === "DECLINED" ? "This contact has opted out." : "Sending a reply pauses the assistant for this conversation."}</small><button class="primary" ${!data.canReply || l.state === "DECLINED" ? "disabled" : ""}>Send reply ↗</button></div></form><details class="notes"><summary>Private team notes ${l.notes ? "· saved" : ""}</summary><textarea id="notes-text" maxlength="4000" aria-label="Private notes">${esc(noteDrafts.get(id) ?? l.notes ?? "")}</textarea><button class="quiet" data-action="notes">Save notes</button></details>`;
  $("#conversation").insertAdjacentHTML("beforeend", renderOnboarding(data));
  const area = $(".messages");
  area.scrollTop = area.scrollHeight;
  $("#reply-text").oninput = (e) => drafts.set(id, e.target.value);
  $("#notes-text").oninput = (e) => noteDrafts.set(id, e.target.value);
  $("#reply-form").onsubmit = async (e) => {
    e.preventDefault();
    await action("reply", { text: $("#reply-text").value });
  };
}
const importReasons = {
  no_consent: "No consent was on record when it arrived",
  not_a_chat_export: "The file did not read as a chat export",
  demo_mode: "Demo mode never contacts external services",
  operator: "Rejected during review",
  retention: "Retention period ended",
};
/**
 * Imports get their own labels rather than borrowing the booking ones: a
 * stored export is "ready to review", not "confirming", and an operator
 * reading the wrong word acts on the wrong thing.
 */
const importLabels = {
  pending: "Downloading",
  stored: "Ready to review",
  accepted: "Accepted",
  rejected: "Not kept",
  purged: "Text deleted",
  failed: "Could not read",
};
const importBadge = (state) => {
  const tone =
    state === "stored"
      ? "warning"
      : state === "accepted"
        ? "good"
        : state === "failed"
          ? "bad"
          : "";
  return `<span class="badge ${tone}">${esc(importLabels[state] || state)}</span>`;
};
/**
 * Everything gathered at the visit, in one place: whether we may keep an export
 * at all, which outlet this shop is in the order pipeline, the supplier numbers
 * they shared, and the exports themselves.
 */
function renderOnboarding(data) {
  const l = data.lead;
  const imports = data.imports || [];
  const contacts = data.supplierContacts || [];
  const consented = Boolean(l.import_consent_at);
  const waiting = contacts.filter((c) => c.state === "captured").length;
  const consentCard = `<div class="onboarding-card"><h3>Import consent</h3><p class="${consented ? "" : "muted"}">${
    consented
      ? `Recorded ${esc(date(l.import_consent_at))}${l.import_consent_method ? " · " + esc(l.import_consent_method) : ""}`
      : "Not recorded. An export sent now is logged and discarded."
  }</p><button class="quiet${consented ? " danger" : ""}" data-consent="${consented ? "withdraw" : "grant"}">${consented ? "Withdraw consent" : "Record consent"}</button></div>`;
  const outletCard = `<div class="onboarding-card"><h3>Outlet link</h3><p class="muted">Joins this conversation to the order pipeline.</p><div class="inline-row"><input id="outlet-id" maxlength="64" placeholder="outlet id" value="${esc(l.outlet_id || "")}"><button class="quiet" data-outlet="1">Save</button></div></div>`;
  const contactList = contacts.length
    ? `<ul class="plain-list">${contacts
        .map(
          (c) =>
            `<li><span><strong>${esc(c.name || "Unnamed")}</strong> · +${esc(c.phone)}</span>${
              c.state === "captured"
                ? `<span class="actions"><button class="quiet" data-contact-act="accept" data-contact-id="${esc(c.id)}">Keep</button><button class="quiet danger" data-contact-act="reject" data-contact-id="${esc(c.id)}">Discard</button></span>`
                : badge(c.state === "accepted" ? "confirmed" : "cancelled")
            }</li>`,
        )
        .join("")}</ul>`
    : '<p class="empty-list">No supplier contacts shared yet.</p>';
  const importList = imports.length
    ? `<ul class="plain-list">${imports
        .map((b) => {
          const s = b.summary ? JSON.parse(b.summary) : null;
          return `<li><span><strong>${esc(b.supplier_label || b.filename || "Chat export")}</strong><br><small class="muted">${esc(date(b.created_at))}${s ? ` · ${s.messageCount} messages over ${s.distinctDays} days` : ""}${b.reason ? ` · ${esc(importReasons[b.reason] || b.reason)}` : ""}</small></span><span class="actions">${importBadge(b.state)}${b.has_raw ? `<button class="quiet" data-import="${esc(b.id)}">Open</button>` : ""}</span></li>`;
        })
        .join("")}</ul>`
    : '<p class="empty-list">No chat exports received yet.</p>';
  return `<details class="onboarding"${imports.length || contacts.length ? " open" : ""}><summary>Onboarding data${waiting ? ` · ${waiting} to review` : ""}</summary><div class="onboarding-grid">${consentCard}${outletCard}</div><h3>Supplier contacts</h3>${contactList}<h3>Chat exports</h3>${importList}<div id="import-detail"></div></details>`;
}
/**
 * One export, opened.
 *
 * The ranked phrase list is the point: it is the shop's own vocabulary, which
 * is what seeds their alias table. Which author is the shop is a judgement the
 * operator makes here, because the file cannot tell us on its own.
 */
async function openImport(id) {
  const data = await api("/imports/" + encodeURIComponent(id));
  const s = data.summary;
  const columns = (s?.authors ?? [])
    .map((a) => {
      const phrases = data.phrases?.[a.name] ?? [];
      return `<div class="phrase-column"><h4>${esc(a.name)} <small class="muted">${a.count} messages</small></h4>${
        phrases.length
          ? `<ol class="phrase-list">${phrases.map((p) => `<li><span>${esc(p.phrase)}</span><b>${p.count}</b></li>`).join("")}</ol>`
          : '<p class="empty-list">Nothing repeated.</p>'
      }</div>`;
    })
    .join("");
  const warning = s?.dateOrderAmbiguous
    ? '<p class="warn-line">Dates here could be day-first or month-first. Check one against the conversation before trusting any timing.</p>'
    : "";
  const act = (name, label, cls = "quiet") =>
    `<button class="${cls}" data-import-act="${name}" data-import-id="${esc(data.batch.id)}">${label}</button>`;
  $("#import-detail").innerHTML =
    `<div class="import-detail"><div class="import-detail-head"><div><h3>${esc(data.batch.supplier_label || data.batch.filename || "Chat export")}</h3><p class="muted">${s ? `${s.messageCount} messages · ${s.distinctDays} days · ${esc(s.firstMessageAt || "")} to ${esc(s.lastMessageAt || "")}` : "No summary"}</p></div><div class="actions">${act("accept", "Accept")}${act("reject", "Reject")}${act("purge", "Delete text now", "quiet danger")}</div></div>${warning}<div class="inline-row"><input id="supplier-label" maxlength="120" placeholder="Which supplier is this thread?" value="${esc(data.batch.supplier_label || "")}">${act("label", "Save name")}</div><div class="phrase-columns">${columns}</div><p class="muted small">Text is deleted ${esc(date(data.batch.retention_expires_at))}. The counts above are kept.</p></div>`;
}
async function action(name, body = {}) {
  try {
    await api(`/leads/${encodeURIComponent(selected)}/${name}`, body);
    if (name === "reply") drafts.delete(selected);
    if (name === "notes") noteDrafts.delete(selected);
    notice(
      name === "reply"
        ? "Your reply is queued for delivery."
        : "Conversation updated.",
    );
    await loadConversation(selected);
    await refresh();
  } catch (e) {
    notice(e.message, true);
  }
}
function renderAppointments(o) {
  $("#timezone").textContent =
    `All times in ${o.timezone}. A reservation remains held while calendar changes are pending.`;
  $("#appointments").innerHTML = o.upcoming.length
    ? `<div class="table-wrap"><table><thead><tr><th>Visit</th><th>Shop / contact</th><th>Location</th><th>Status</th><th></th></tr></thead><tbody>${o.upcoming.map((b) => `<tr><td><strong>${esc(date(b.start))}</strong><br><span class="muted">${Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60000)} minutes</span></td><td><strong>${esc(b.shop_name || b.name || "Details pending")}</strong><br><span class="muted">+${esc(b.wa_id)}</span></td><td>${esc(b.shop_address || "Awaiting address")}</td><td>${badge(b.status)}</td><td><button class="quiet" data-open="${esc(b.wa_id)}">View →</button></td></tr>`).join("")}</tbody></table></div>`
    : '<p class="empty-list">Your next shop visit will appear here.</p>';
}
function renderIntegrations(o) {
  $("#integrations").innerHTML = [
    [
      "WhatsApp",
      o.mode === "demo" ? "Safe demo" : "Live",
      "Demo mode never contacts external services.",
    ],
    [
      "Google Calendar",
      o.calendar ? "Connected" : "Local reservations",
      "Calendar failures never produce a confirmed visit.",
    ],
    [
      "Language assistant",
      o.llm ? "Enabled" : "Ready for your key",
      "Core booking commands work without an LLM.",
    ],
  ]
    .map(
      ([name, state, desc]) =>
        `<div class="integration"><h3>${name}</h3><span class="badge">${state}</span><p>${desc}</p></div>`,
    )
    .join("");
}
function renderNotifications(items) {
  $("#notifications").innerHTML =
    items
      .map(
        (n) =>
          `<div class="item"><div><strong>${esc(n.body)}</strong><p>${n.wa_id ? "+" + esc(n.wa_id) + " · " : ""}${esc(date(n.created_at))}</p></div>${!n.read_at ? `<button class="quiet" data-read="${esc(n.id)}">Mark read</button>` : "<small>Read</small>"}</div>`,
      )
      .join("") || '<p class="empty-list">You’re all caught up.</p>';
}
async function loadOperations() {
  const [jobs, activity] = await Promise.all([api("/jobs"), api("/activity")]);
  $("#jobs").innerHTML =
    jobs
      .map(
        (j) =>
          `<div class="item"><div><strong>${esc(kind[j.kind] || j.kind)}</strong> ${badge(j.status)}<p>${esc(j.last_error || "This action is waiting to run.")}</p><small>Attempt ${j.attempts} · ${esc(date(j.updated_at))}</small></div>${j.status === "dead" ? `<button class="secondary" data-retry="${j.id}">Retry action</button>` : ""}</div>`,
      )
      .join("") ||
    '<p class="empty-list">No pending or failed actions. You’re up to date.</p>';
  $("#activity").innerHTML =
    activity
      .map(
        (a) =>
          `<div class="item"><div><strong>${esc(a.action.replaceAll("_", " "))}</strong><p>${esc(a.actor === "operator" ? "Team action" : "Assistant action")}</p></div><small>${esc(date(a.at))}</small></div>`,
      )
      .join("") ||
    '<p class="empty-list">Activity appears as the desk gets to work.</p>';
}
async function setView(name) {
  view = name;
  for (const el of document.querySelectorAll(".view"))
    el.hidden = el.id !== name + "-view";
  for (const el of document.querySelectorAll(".nav"))
    el.classList.toggle("active", el.dataset.view === name);
  const names = {
    inbox: ["Conversations", "Keep the conversation going."],
    appointments: ["Appointments", "Good visits start with a clear plan."],
    operations: [
      "Activity & recovery",
      "A little attention. Everything in motion.",
    ],
  };
  $("#page-label").textContent = names[name][0];
  $("#page-title").textContent = names[name][1];
  if (name === "operations") await loadOperations();
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.view) await setView(b.dataset.view);
    if (b.dataset.contact) {
      selected = b.dataset.contact;
      await refresh();
      await loadConversation(selected);
    }
    if (b.dataset.open) {
      selected = b.dataset.open;
      await setView("inbox");
      await refresh();
      await loadConversation(selected);
    }
    if (b.dataset.action)
      await action(
        b.dataset.action,
        b.dataset.action === "notes" ? { notes: $("#notes-text").value } : {},
      );
    if (
      b.dataset.cancel &&
      confirm(
        "Cancel this appointment? It stays reserved until any calendar cancellation succeeds.",
      )
    ) {
      await api("/bookings/" + b.dataset.cancel + "/cancel", {});
      notice("Cancellation requested.");
      await refresh();
    }
    if (b.dataset.retry) {
      await api("/jobs/" + b.dataset.retry + "/retry", {});
      notice("The action is queued to try again.");
      await refresh();
    }
    if (b.dataset.read) {
      await api("/notifications/" + b.dataset.read + "/read", {});
      await refresh();
    }
    if (b.dataset.consent) {
      const grant = b.dataset.consent === "grant";
      if (
        !grant ||
        confirm(
          "Confirm you have told this shop what you will keep from their chats, why, and for how long.",
        )
      ) {
        await action("consent", { granted: grant, method: "in_person" });
        await loadConversation(selected);
      }
    }
    if (b.dataset.outlet) {
      await action("outlet", { outletId: $("#outlet-id").value.trim() });
      await loadConversation(selected);
    }
    if (b.dataset.contactAct) {
      await api(`/contacts/${b.dataset.contactId}/${b.dataset.contactAct}`, {});
      await loadConversation(selected);
    }
    if (b.dataset.import) await openImport(b.dataset.import);
    if (b.dataset.importAct) {
      const name = b.dataset.importAct;
      if (
        name !== "purge" ||
        confirm(
          "Delete the exported text now? The counts are kept. This cannot be undone.",
        )
      ) {
        await api(`/imports/${b.dataset.importId}/${name}`, {
          supplierLabel: $("#supplier-label")?.value ?? "",
        });
        notice(
          name === "purge" ? "The exported text has been deleted." : "Saved.",
        );
        await loadConversation(selected);
      }
    }
  } catch (e) {
    notice(e.message, true);
  }
});
$("#refresh").onclick = () => refresh().catch((e) => notice(e.message, true));
$("#previous").onclick = () => {
  page--;
  $("#refresh").click();
};
$("#next").onclick = () => {
  page++;
  $("#refresh").click();
};
let searchTimer;
$("#search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page = 0;
    $("#refresh").click();
  }, 250);
};
$("#state-filter").onchange = () => {
  page = 0;
  $("#refresh").click();
};
$("#export").onclick = async () => {
  try {
    const res = await fetch("/api/export", {
      headers: { "x-admin-token": token },
    });
    if (!res.ok) throw new Error("Export failed");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = "ledger-leads.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    notice(e.message, true);
  }
};
setInterval(() => {
  if (token && !document.hidden)
    refresh().catch((e) => notice(e.message, true));
}, 10000);
