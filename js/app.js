/* ============================================================
   MWT Installer Order Manager - app.js
   ============================================================ */

const state = {
  route: { type: "dashboard" },
  jobsCache: [],
  currentJob: null,
  currentSchema: null,
  dirty: false,
  autosaveTimer: null,
  sidebarFilter: ""
};

// ---------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------

function uid() {
  return "job_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function nowStamp() {
  return new Date().toISOString();
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined) return;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return node;
}

function toast(msg, kind) {
  const host = document.getElementById("toast-host");
  const t = el("div", { class: "toast" + (kind ? " " + kind : "") }, msg);
  host.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

function escapeHtml(s) {
  return (s || "").toString().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------
// Job model helpers
// ---------------------------------------------------------------

function blankJob(formType) {
  const schema = getFormSchema(formType);
  const job = {
    id: uid(),
    formType,
    displayName: "",
    manualName: "",
    status: "draft",
    createdAt: nowStamp(),
    lastModified: nowStamp(),
    submittedAt: null,
    revision: 0,
    projectNumber: "",
    // A stable identifier for this job's eventual submission, generated
    // once and reused across retries so the backend can tell "the same
    // submit, retried" apart from "a genuinely new submission" - this is
    // what prevents a duplicate email/archive if a response is lost and
    // the installer taps Submit & Send again.
    submissionId: uid(),
    fields: {},
    lineItems: [],
    motorization: {},
    attachments: []
  };
  if (schema.lineItems) {
    job.lineItems.push(makeBlankRow(schema.lineItems.columns));
  }
  return job;
}

function makeBlankRow(columns) {
  const row = { photos: [] };
  columns.forEach((c) => (row[c.id] = ""));
  return row;
}

function computeDisplayName(job) {
  if (job.manualName && job.manualName.trim()) return job.manualName.trim();
  const f = job.fields || {};
  const end = f.contact || f.endUserFirstLast || "";
  const firm = f.designFirm || "";
  const sidemark = f.sidemark || "";
  const projNum = job.projectNumber ? "MWT " + job.projectNumber : "";
  // Order: Design Firm first, then Sidemark (falling back to end-user
  // contact name if no sidemark) - e.g. "MWT \u2013 Kandl", never reversed.
  const parts = [];
  if (firm) parts.push(firm);
  if (sidemark) parts.push(sidemark);
  else if (end) parts.push(end);
  let name = parts.join(" \u2013 ");
  if (projNum) name = name ? projNum + " \u2013 " + name : projNum;
  return name || "Untitled Job";
}

// Email subject ONLY - always "Design Firm - Sidemark" built straight
// from the entered field values, e.g. "MWT \u2013 Kandl". Deliberately
// ignores job.manualName and never appends the form name, per Matthew's
// correction - ONLY used for the Submit & Send email subject, not for
// Saved Jobs, the sidebar, or the PDF's own "Job Name" line (those all
// still use computeDisplayName() above, unchanged).
function buildEmailSubject(job) {
  const f = job.fields || {};
  const firm = (f.designFirm || "").trim();
  const sidemark = (f.sidemark || "").trim();
  if (firm && sidemark) return firm + " \u2013 " + sidemark;
  if (firm) return firm;
  if (sidemark) return sidemark;
  // Fallback for forms with no Design Firm / Sidemark fields (e.g.
  // Service / Retrofit / Cut-Down) - keeps the email subject meaningful
  // rather than blank.
  return computeDisplayName(job);
}

async function refreshJobsCache() {
  state.jobsCache = await MwtDB.getAllJobs();
  state.jobsCache.sort((a, b) => (b.lastModified || "").localeCompare(a.lastModified || ""));
}

async function persistJob(job, opts = {}) {
  job.lastModified = nowStamp();
  job.displayName = computeDisplayName(job);
  await MwtDB.saveJob(job);
  await refreshJobsCache();
  renderSidebar();
  if (!opts.silent) {
    setSaveIndicator("saved");
  }
}

function scheduleAutosave() {
  state.dirty = true;
  setSaveIndicator("unsaved");
  if (state.autosaveTimer) clearTimeout(state.autosaveTimer);
  state.autosaveTimer = setTimeout(async () => {
    if (state.currentJob) {
      collectFormData();
      await persistJob(state.currentJob);
      state.dirty = false;
    }
  }, 1200);
}

function setSaveIndicator(mode) {
  const indEl = document.getElementById("save-indicator");
  if (!indEl) return;
  indEl.classList.remove("saved", "unsaved");
  if (mode === "saved") {
    indEl.classList.add("saved");
    indEl.textContent = "Saved \u2713  \u00b7  Last saved " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } else if (mode === "unsaved") {
    indEl.classList.add("unsaved");
    indEl.textContent = "Unsaved changes\u2026";
  } else {
    indEl.textContent = "";
  }
}

// ---------------------------------------------------------------
// Routing
// ---------------------------------------------------------------

function goTo(route) {
  if (state.autosaveTimer) {
    clearTimeout(state.autosaveTimer);
    if (state.currentJob && state.dirty) {
      collectFormData();
      persistJob(state.currentJob, { silent: true });
    }
  }
  state.route = route;
  render();
}

async function render() {
  const content = document.getElementById("content");
  content.innerHTML = "";
  state.currentJob = null;
  state.currentSchema = null;

  if (state.route.type === "dashboard") {
    content.appendChild(await renderDashboard());
  } else if (state.route.type === "newJob") {
    const job = blankJob(state.route.formId);
    await persistJob(job, { silent: true }); // save immediately so it shows in Saved Jobs right away
    // Switch the route to editJob for this new job's id so that any later
    // re-render (e.g. after Submit, or Save) edits THIS job instead of
    // creating another blank one every time render() runs.
    state.route = { type: "editJob", jobId: job.id };
    state.currentJob = job;
    state.currentSchema = getFormSchema(job.formType);
    content.appendChild(renderJobForm(job, state.currentSchema, { isNew: true }));
  } else if (state.route.type === "editJob") {
    const job = await MwtDB.getJob(state.route.jobId);
    if (!job) {
      toast("That job could not be found - it may have been deleted.", "error");
      goTo({ type: "dashboard" });
      return;
    }
    state.currentJob = job;
    state.currentSchema = getFormSchema(job.formType);
    content.appendChild(renderJobForm(job, state.currentSchema, { isNew: false }));
  } else if (state.route.type === "savedJobs") {
    content.appendChild(await renderSavedJobsList(state.route.filterStatus || null));
  }

  document.getElementById("topbar-title").textContent = topbarTitle();
  renderSidebar();
  window.scrollTo(0, 0);
}

function topbarTitle() {
  if (state.route.type === "dashboard") return "Dashboard";
  if (state.route.type === "newJob") return "New " + (getFormSchema(state.route.formId)?.label || "Job");
  if (state.route.type === "editJob") return state.currentJob ? computeDisplayName(state.currentJob) : "Job";
  if (state.route.type === "savedJobs") return "Saved Jobs";
  return "MWT Installer";
}

// ---------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------

function renderSidebar() {
  const nav = document.getElementById("sidebar-nav");
  nav.innerHTML = "";

  const newGroup = el("div", { class: "nav-group" }, [
    el("h4", {}, "New Job")
  ]);
  MWT_FORM_SCHEMAS.forEach((schema) => {
    const btn = el(
      "button",
      {
        class: "nav-item" + (state.route.type === "newJob" && state.route.formId === schema.id ? " active" : ""),
        onclick: () => { closeSidebarMobile(); goTo({ type: "newJob", formId: schema.id }); }
      },
      "+ " + schema.shortLabel
    );
    newGroup.appendChild(btn);
  });
  nav.appendChild(newGroup);

  const dashBtn = el(
    "button",
    { class: "nav-item" + (state.route.type === "dashboard" ? " active" : ""), onclick: () => { closeSidebarMobile(); goTo({ type: "dashboard" }); } },
    "\u2302 Dashboard"
  );
  const savedGroup = el("div", { class: "nav-group" }, [
    el("h4", {}, "Saved Jobs"),
    el("div", { class: "search-box" }, el("input", {
      type: "text",
      placeholder: "Search saved jobs\u2026",
      value: state.sidebarFilter,
      oninput: (e) => { state.sidebarFilter = e.target.value; renderSidebarJobList(); }
    }))
  ]);
  const jobList = el("div", { id: "sidebar-job-list" });
  savedGroup.appendChild(jobList);

  nav.prepend(dashBtn);
  nav.appendChild(savedGroup);
  nav.appendChild(renderBackupGroup());
  nav.appendChild(renderAccountGroup());

  renderSidebarJobList();
}

// ---------------------------------------------------------------
// Backup: Export / Import saved jobs as a single JSON file.
// Purely local file I/O - does not change the offline architecture
// or require any server/account.
// ---------------------------------------------------------------

function renderBackupGroup() {
  const group = el("div", { class: "nav-group" }, [el("h4", {}, "Backup")]);
  group.appendChild(
    el("button", { class: "nav-item", onclick: exportBackup }, "\u2B07 Export Backup")
  );
  const importInput = el("input", {
    type: "file",
    accept: "application/json,.json",
    style: "display:none;",
    onchange: (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handleImportFile(file);
      e.target.value = "";
    }
  });
  group.appendChild(
    el("button", { class: "nav-item", onclick: () => importInput.click() }, "\u2B06 Import Backup")
  );
  group.appendChild(importInput);
  return group;
}

function renderAccountGroup() {
  const group = el("div", { class: "nav-group" }, [el("h4", {}, "Account")]);
  group.appendChild(
    el("button", {
      class: "nav-item",
      onclick: () => {
        openModal({
          title: "Log out of Installer Mode?",
          body: "This removes this iPad's Installer authorization. You'll need the 4-digit access code again to create or submit jobs on this device. Saved jobs already on this iPad are not affected.",
          confirmLabel: "Log Out",
          confirmClass: "btn-danger",
          onConfirm: logOutInstaller
        });
      }
    }, "\u23FB Log Out")
  );
  return group;
}

function logOutInstaller() {
  clearDeviceToken();
  location.reload();
}

function logOutAdmin() {
  clearAdminToken();
  location.reload();
}

async function exportBackup() {
  try {
    const jobs = await MwtDB.getAllJobs();
    if (!jobs.length) {
      toast("There are no saved jobs to back up yet.");
      return;
    }
    const payload = {
      app: "MWT Installer Order Manager",
      appVersion: MWT_CONFIG.appVersion,
      exportedAt: nowStamp(),
      jobCount: jobs.length,
      jobs
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    downloadBlob(blob, "mwt-installer-backup-" + stamp + ".json");
    toast("Backup file downloaded (" + jobs.length + " job" + (jobs.length === 1 ? "" : "s") + "). Store it somewhere safe off this tablet.", "success");
  } catch (err) {
    console.error(err);
    toast("Could not create the backup file: " + err.message, "error");
  }
}

async function handleImportFile(file) {
  let payload;
  try {
    const text = await file.text();
    payload = JSON.parse(text);
  } catch (err) {
    toast("That file could not be read as a backup - make sure it's an MWT Installer backup .json file.", "error");
    return;
  }
  if (!payload || !Array.isArray(payload.jobs) || payload.app !== "MWT Installer Order Manager") {
    toast("That doesn't look like an MWT Installer backup file.", "error");
    return;
  }

  const existing = await MwtDB.getAllJobs();
  const existingIds = new Set(existing.map((j) => j.id));
  const overlapCount = payload.jobs.filter((j) => existingIds.has(j.id)).length;

  const summary =
    "This file contains " + payload.jobs.length + " job" + (payload.jobs.length === 1 ? "" : "s") +
    " from " + (payload.exportedAt ? new Date(payload.exportedAt).toLocaleString() : "an unknown date") + "." +
    (overlapCount ? " " + overlapCount + " of them share an ID with a job already saved on this tablet and will be OVERWRITTEN with the backup's version." : " None of them conflict with jobs already on this tablet.") +
    " Jobs already on this tablet that are NOT in the backup are left untouched. Continue?";

  openModal({
    title: "Import backup?",
    body: summary,
    confirmLabel: "Import",
    confirmClass: "btn-primary",
    onConfirm: async () => {
      let imported = 0;
      for (const job of payload.jobs) {
        if (job && job.id) {
          await MwtDB.saveJob(job);
          imported++;
        }
      }
      await refreshJobsCache();
      renderSidebar();
      toast("Imported " + imported + " job" + (imported === 1 ? "" : "s") + " from backup.", "success");
      if (state.route.type === "dashboard" || state.route.type === "savedJobs") render();
    }
  });
}

function renderSidebarJobList() {
  const jobList = document.getElementById("sidebar-job-list");
  if (!jobList) return;
  jobList.innerHTML = "";
  const filter = state.sidebarFilter.trim().toLowerCase();
  let jobs = state.jobsCache;
  if (filter) {
    jobs = jobs.filter((j) => computeDisplayName(j).toLowerCase().includes(filter));
  }
  if (jobs.length === 0) {
    jobList.appendChild(el("div", { class: "empty-note" }, filter ? "No jobs match." : "No saved jobs yet."));
    return;
  }
  jobs.slice(0, 40).forEach((j) => {
    const active = state.route.type === "editJob" && state.route.jobId === j.id;
    const item = el(
      "button",
      {
        class: "nav-item job-item status-" + j.status + (active ? " active" : ""),
        onclick: () => { closeSidebarMobile(); goTo({ type: "editJob", jobId: j.id }); }
      },
      [
        el("span", { class: "name" }, computeDisplayName(j)),
        el("span", { class: "status-dot" })
      ]
    );
    jobList.appendChild(item);
  });
  if (state.jobsCache.length > 40) {
    jobList.appendChild(el("div", { class: "empty-note" }, "Showing 40 most recent. Use search or 'Saved Jobs' to see all."));
  }
}

function closeSidebarMobile() {
  document.getElementById("sidebar").classList.remove("open");
}

// ---------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------

async function renderDashboard() {
  await refreshJobsCache();
  const wrap = el("div", {});

  wrap.appendChild(el("h2", {}, "New Job"));
  const tiles = el("div", { class: "dash-grid" });
  MWT_FORM_SCHEMAS.forEach((schema) => {
    tiles.appendChild(
      el("button", { class: "dash-tile", onclick: () => goTo({ type: "newJob", formId: schema.id }) }, [
        el("div", { class: "tile-icon" }, "\uD83D\uDCCB"),
        el("h3", {}, schema.label),
        el("p", {}, schema.needsReview ? "Needs your review \u2013 see notes inside" : "Start a new order/measurement")
      ])
    );
  });
  wrap.appendChild(tiles);

  const recent = state.jobsCache.slice(0, 8);
  wrap.appendChild(
    el("div", { style: "display:flex;align-items:center;justify-content:space-between;" }, [
      el("h2", {}, "Recent Jobs"),
      el("button", { class: "btn btn-outline", onclick: () => goTo({ type: "savedJobs" }) }, "View All Saved Jobs")
    ])
  );

  if (recent.length === 0) {
    wrap.appendChild(el("div", { class: "empty-state" }, [
      el("div", { class: "big" }, "\uD83D\uDDC2\uFE0F"),
      el("div", {}, "No jobs yet. Tap a form above to create your first one.")
    ]));
  } else {
    wrap.appendChild(buildJobTable(recent));
  }

  return wrap;
}

async function renderSavedJobsList(filterStatus) {
  await refreshJobsCache();
  const wrap = el("div", {});
  wrap.appendChild(el("h2", {}, "Saved Jobs"));

  const filterBar = el("div", { class: "btn-row", style: "margin-bottom:14px;" });
  const statuses = [["all", "All"], ["draft", "Draft"], ["ready", "Ready"], ["submitted", "Submitted"]];
  statuses.forEach(([key, label]) => {
    filterBar.appendChild(
      el(
        "button",
        {
          class: "btn " + ((filterStatus || "all") === key ? "btn-navy" : "btn-outline"),
          onclick: () => goTo({ type: "savedJobs", filterStatus: key === "all" ? null : key })
        },
        label
      )
    );
  });
  wrap.appendChild(filterBar);

  let jobs = state.jobsCache;
  if (filterStatus) jobs = jobs.filter((j) => j.status === filterStatus);

  if (jobs.length === 0) {
    wrap.appendChild(el("div", { class: "empty-state" }, [
      el("div", { class: "big" }, "\uD83D\uDCC1"),
      el("div", {}, "No jobs in this view yet.")
    ]));
  } else {
    wrap.appendChild(buildJobTable(jobs));
  }
  return wrap;
}

function buildJobTable(jobs) {
  const table = el("table", { class: "job-table" });
  table.appendChild(
    el("thead", {}, el("tr", {}, [
      el("th", {}, "Project / Sidemark"), el("th", {}, "Form Type"), el("th", {}, "Status"),
      el("th", {}, "Last Modified"), el("th", {}, "Actions")
    ]))
  );
  const tbody = el("tbody", {});
  jobs.forEach((j) => {
    const schema = getFormSchema(j.formType);
    tbody.appendChild(
      el("tr", {}, [
        el("td", {}, el("a", { href: "javascript:void(0)", onclick: () => goTo({ type: "editJob", jobId: j.id }) }, computeDisplayName(j))),
        el("td", {}, schema ? schema.shortLabel : j.formType),
        el("td", {}, el("span", { class: "badge badge-" + j.status }, j.status)),
        el("td", {}, fmtTime(j.lastModified)),
        el("td", {}, [
          el("button", { class: "btn btn-ghost", onclick: () => goTo({ type: "editJob", jobId: j.id }) }, "Open"),
          el("button", { class: "btn btn-ghost", onclick: () => duplicateJob(j.id) }, "Duplicate"),
          el("button", { class: "btn btn-ghost", onclick: () => deleteJobConfirm(j.id) }, "Delete")
        ])
      ])
    );
  });
  table.appendChild(tbody);
  return el("div", { class: "card", style: "overflow-x:auto;" }, table);
}

async function duplicateJob(id) {
  const orig = await MwtDB.getJob(id);
  if (!orig) return;
  const copy = JSON.parse(JSON.stringify(orig));
  copy.id = uid();
  copy.status = "draft";
  copy.createdAt = nowStamp();
  copy.lastModified = nowStamp();
  copy.submittedAt = null;
  copy.revision = 0;
  // A duplicate is a distinct future submission, not a retry of the
  // original - it must get its own submissionId so it can never be
  // treated as "already processed" by the backend's idempotency check.
  copy.submissionId = uid();
  copy.manualName = (orig.manualName || computeDisplayName(orig)) + " (copy)";
  await MwtDB.saveJob(copy);
  await refreshJobsCache();
  toast("Job duplicated.", "success");
  goTo({ type: "editJob", jobId: copy.id });
}

function deleteJobConfirm(id) {
  openModal({
    title: "Delete this job?",
    body: "This permanently deletes the job and any attached photos from this tablet. This cannot be undone.",
    confirmLabel: "Delete",
    confirmClass: "btn-danger",
    onConfirm: async () => {
      await MwtDB.deleteJob(id);
      await refreshJobsCache();
      toast("Job deleted.");
      if (state.route.type === "editJob" && state.route.jobId === id) {
        goTo({ type: "dashboard" });
      } else {
        render();
      }
    }
  });
}

// ---------------------------------------------------------------
// Job form rendering
// ---------------------------------------------------------------

function renderJobForm(job, schema, opts) {
  const wrap = el("div", {});

  const header = el("div", { class: "form-header" }, [
    el("h2", {}, schema.pdfTitle),
    el("div", { class: "job-name-edit" }, [
      "Job name: ",
      el("input", {
        type: "text",
        value: job.manualName || "",
        placeholder: computeDisplayName(job),
        style: "background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.3);color:#fff;border-radius:6px;padding:6px 10px;min-width:220px;",
        oninput: (e) => { job.manualName = e.target.value; scheduleAutosave(); document.getElementById("topbar-title").textContent = computeDisplayName(job); }
      })
    ])
  ]);
  wrap.appendChild(header);

  const body = el("div", { class: "form-body" });

  if (schema.needsReview) {
    body.appendChild(el("div", { class: "needs-review-banner" }, "\u26A0\uFE0F " + schema.reviewNote));
  }

  // MWT Project # + status row
  const metaGrid = el("div", { class: "field-grid" }, [
    fieldBlock({ id: "__projectNumber", label: "MWT Project #", type: "text" }, job.projectNumber, (v) => { job.projectNumber = v; scheduleAutosave(); }),
    el("div", { class: "field" }, [
      el("label", {}, "Status"),
      el("div", {}, el("span", { class: "badge badge-" + job.status }, job.status))
    ])
  ]);
  body.appendChild(metaGrid);

  if (schema.instructions) {
    body.appendChild(el("div", { class: "needs-review-banner", style: "background:#eef1fb;border-color:#c7d1f0;color:#243a80;" }, schema.instructions));
  }

  if (schema.mainHeaderTitle) {
    body.appendChild(el("div", { class: "fixed-info-box", style: "margin-bottom:16px;" }, [
      el("div", { style: "font-size:17px;font-weight:700;color:var(--mwt-navy);margin-bottom:3px;" }, schema.mainHeaderTitle),
      el("div", {}, MWT_CONFIG.companyPhone + "  \u00b7  " + MWT_CONFIG.shipTo.companyName)
    ]));
  }

  // Sections
  schema.sections.forEach((section) => {
    body.appendChild(el("div", { class: "section-title" }, section.title));
    const grid = el("div", { class: "field-grid" });
    section.fields.forEach((f) => {
      grid.appendChild(fieldBlock(f, job.fields[f.id] || "", (v) => { job.fields[f.id] = v; scheduleAutosave(); }));
    });
    body.appendChild(grid);
  });

  // Ship To (fixed, read-only)
  body.appendChild(el("div", { class: "section-title" }, "Ship To Location"));
  body.appendChild(renderShipToBox());

  // Service-request specific: request type checkboxes
  if (schema.requestTypeField) {
    body.appendChild(el("div", { class: "section-title" }, "Request Type"));
    body.appendChild(renderCheckboxGroup(schema.requestTypeField, job));
  }
  if (schema.fields) {
    body.appendChild(el("div", { class: "section-title" }, "Service Details"));
    const grid = el("div", { class: "field-grid" });
    schema.fields.forEach((f) => {
      if (f.type === "checkbox-group") {
        grid.appendChild(el("div", { class: "field full" }, [
          el("label", {}, f.label),
          renderCheckboxGroup(f, job)
        ]));
      } else if (f.type === "yesno-count") {
        grid.appendChild(renderYesNoCount(f, job));
      } else {
        grid.appendChild(fieldBlock(f, job.fields[f.id] || "", (v) => { job.fields[f.id] = v; scheduleAutosave(); }));
      }
    });
    body.appendChild(grid);
  }

  // Line items
  if (schema.lineItems) {
    body.appendChild(el("div", { class: "section-title" }, schema.lineItems.title));
    if (schema.lineItems.note) {
      body.appendChild(el("div", { class: "needs-review-banner" }, "\u26A0\uFE0F " + schema.lineItems.note));
    }
    body.appendChild(renderLineItemsTable(job, schema.lineItems));
  }

  // Motorization control devices (drapery)
  if (schema.motorizationControlDevices) {
    body.appendChild(el("div", { class: "section-title" }, schema.motorizationControlDevices.title));
    const grid = el("div", { class: "field-grid" });
    schema.motorizationControlDevices.fields.forEach((f) => {
      grid.appendChild(fieldBlock(f, job.motorization[f.id] || "", (v) => { job.motorization[f.id] = v; scheduleAutosave(); }));
    });
    body.appendChild(grid);
  }

  // Attachments
  body.appendChild(el("div", { class: "section-title" }, "Photos / Files"));
  if (schema.attachmentsHint) {
    body.appendChild(el("div", { class: "help-text", style: "margin:-6px 0 10px;" }, schema.attachmentsHint));
  }
  body.appendChild(renderAttachments(job));

  // Additional notes
  body.appendChild(el("div", { class: "section-title" }, schema.additionalNotesLabel || "Additional Notes"));
  body.appendChild(el("div", { class: "field full" }, [
    el("textarea", {
      rows: 4,
      oninput: (e) => { job.fields.__additionalNotes = e.target.value; scheduleAutosave(); }
    }, job.fields.__additionalNotes || "")
  ]));

  // Action bar
  body.appendChild(renderActionBar(job, schema));

  wrap.appendChild(body);
  return wrap;
}

function fieldBlock(f, value, onChange) {
  const wrapper = el("div", { class: "field" + (f.fullWidth ? " full" : "") });
  const label = el("label", {}, [f.label, f.required ? el("span", { class: "req" }, "*") : null]);
  wrapper.appendChild(label);
  let input;
  if (f.type === "textarea") {
    input = el("textarea", { rows: 3, oninput: (e) => onChange(e.target.value) }, value || "");
  } else {
    input = el("input", {
      type: f.type === "email" ? "email" : f.type === "date" ? "date" : f.type === "number" ? "number" : "text",
      value: value || "",
      oninput: (e) => onChange(e.target.value)
    });
  }
  wrapper.appendChild(input);
  if (f.help) wrapper.appendChild(el("div", { class: "help-text" }, f.help));
  return wrapper;
}

function renderShipToBox() {
  const s = MWT_CONFIG.shipTo;
  return el("div", { class: "fixed-info-box" }, [
    el("div", {}, [el("span", { class: "lbl" }, "Company Name: "), s.companyName]),
    el("div", {}, [el("span", { class: "lbl" }, "Contact: "), s.contact]),
    el("div", {}, [el("span", { class: "lbl" }, "Street: "), s.street]),
    el("div", {}, [el("span", { class: "lbl" }, "City/State/Zip: "), s.cityStateZip]),
    el("div", {}, [el("span", { class: "lbl" }, "Phone: "), s.phone]),
    el("div", { style: "margin-top:6px;" }, [el("span", { class: "lbl" }, "Shipping Notes: "), s.shippingNotes])
  ]);
}

function renderCheckboxGroup(f, job) {
  const groupWrap = el("div", { class: "checkbox-group" });
  const current = new Set(job.fields[f.id] ? job.fields[f.id].split("|||") : []);
  f.options.forEach((opt) => {
    const checked = current.has(opt);
    const pill = el("label", { class: "checkbox-pill" + (checked ? " checked" : "") }, [
      el("input", {
        type: "checkbox",
        checked: checked ? "checked" : null,
        onchange: (e) => {
          if (e.target.checked) current.add(opt); else current.delete(opt);
          job.fields[f.id] = Array.from(current).join("|||");
          pill.classList.toggle("checked", e.target.checked);
          scheduleAutosave();
        }
      }),
      opt
    ]);
    groupWrap.appendChild(pill);
  });
  return groupWrap;
}

function renderYesNoCount(f, job) {
  const wrapper = el("div", { class: "field full" });
  wrapper.appendChild(el("label", {}, f.label));
  const val = job.fields[f.id] || "";
  const [yn, count] = val.split("|||");
  const row = el("div", { class: "yesno-row" });
  ["Yes", "No"].forEach((opt) => {
    row.appendChild(
      el("label", { class: "radio-opt" }, [
        el("input", {
          type: "radio",
          name: f.id,
          checked: yn === opt ? "checked" : null,
          onchange: () => { job.fields[f.id] = opt + "|||" + (countInput.value || ""); scheduleAutosave(); }
        }),
        opt
      ])
    );
  });
  const countInput = el("input", {
    type: "number",
    placeholder: "If yes, how many?",
    value: count || "",
    oninput: (e) => { const currentYn = (job.fields[f.id] || "").split("|||")[0] || ""; job.fields[f.id] = currentYn + "|||" + e.target.value; scheduleAutosave(); }
  });
  row.appendChild(countInput);
  wrapper.appendChild(row);
  if (f.help) wrapper.appendChild(el("div", { class: "help-text" }, f.help));
  return wrapper;
}

// ---------------------------------------------------------------
// Line items table
// ---------------------------------------------------------------

function renderLineItemsTable(job, spec) {
  const container = el("div", {});
  if (spec.columns.length > 8) {
    container.appendChild(el("div", { class: "scroll-hint" }, "\u2190  Swipe or scroll to view all columns  \u2192"));
  }
  const scroll = el("div", { class: "table-scroll" });
  const table = el("table", { class: "line-table" });

  const thead = el("thead", {});
  const headRow = el("tr", {});
  headRow.appendChild(el("th", {}, "#"));
  spec.columns.forEach((c) => {
    headRow.appendChild(el("th", {}, [c.label, c.hint ? el("span", { class: "col-hint" }, c.hint) : null]));
  });
  if (spec.hasPhotoColumn) {
    headRow.appendChild(el("th", {}, "Photo"));
  }
  headRow.appendChild(el("th", {}, ""));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody", {});
  table.appendChild(tbody);

  function redrawRows() {
    tbody.innerHTML = "";
    job.lineItems.forEach((row, idx) => {
      if (!row.photos) row.photos = [];
      const tr = el("tr", {});
      tr.appendChild(el("td", { class: "rownum" }, String(idx + 1)));
      spec.columns.forEach((c) => {
        const td = el("td", {});
        if (c.type === "select") {
          const select = el("select", {
            onchange: (e) => { row[c.id] = e.target.value; scheduleAutosave(); }
          });
          select.appendChild(el("option", { value: "" }, "\u2014"));
          c.options.forEach((opt) => {
            select.appendChild(el("option", { value: opt, selected: row[c.id] === opt ? "selected" : null }, opt));
          });
          td.appendChild(select);
        } else {
          td.appendChild(
            el("input", {
              type: "text",
              value: row[c.id] || "",
              oninput: (e) => { row[c.id] = e.target.value; scheduleAutosave(); }
            })
          );
        }
        tr.appendChild(td);
      });

      if (spec.hasPhotoColumn) {
        const photoTd = el("td", { class: "photo-col" });
        const photoBtn = el("button", {
          class: "photo-row-btn" + ((row.photos && row.photos.length) ? " has-photos" : ""),
          title: "Photos for line " + (idx + 1),
          onclick: () => openLinePhotoManager(job, row, idx + 1, redrawRows)
        }, photoButtonLabel(row));
        photoTd.appendChild(photoBtn);
        tr.appendChild(photoTd);
      }

      const removeTd = el("td", { class: "remove-col" });
      removeTd.appendChild(
        el("button", {
          class: "remove-row-btn",
          title: "Remove row",
          onclick: () => {
            if (job.lineItems.length <= 1) {
              toast("At least one row must remain.");
              return;
            }
            const photoCount = (row.photos || []).length;
            openModal({
              title: "Remove line " + (idx + 1) + "?",
              body: "This removes line " + (idx + 1) + " from this job" +
                (photoCount ? ", including its " + photoCount + " attached photo" + (photoCount === 1 ? "" : "s") : "") +
                ". This cannot be undone.",
              confirmLabel: "Remove Line",
              confirmClass: "btn-danger",
              onConfirm: () => {
                job.lineItems.splice(idx, 1);
                scheduleAutosave();
                redrawRows();
              }
            });
          }
        }, "\u2715")
      );
      tr.appendChild(removeTd);
      tbody.appendChild(tr);
    });
  }
  redrawRows();

  scroll.appendChild(table);
  container.appendChild(scroll);

  const addBar = el("div", { class: "add-row-bar" });
  addBar.appendChild(
    el("button", {
      class: "btn btn-navy",
      onclick: () => {
        job.lineItems.push(makeBlankRow(spec.columns));
        scheduleAutosave();
        redrawRows();
      }
    }, "+ Add Row")
  );
  container.appendChild(addBar);
  return container;
}

// ---------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------

function renderAttachments(job) {
  const wrap = el("div", {});
  const list = el("div", { class: "attach-list" });

  function redraw() {
    list.innerHTML = "";
    job.attachments.forEach((att) => {
      const isImg = att.type && att.type.startsWith("image/");
      const chip = el("div", { class: "attach-chip" }, [
        isImg ? el("img", { class: "thumb", src: att.dataUrl }) : null,
        el("span", {}, att.name + " (" + humanSize(att.size) + ")"),
        el("button", {
          class: "remove",
          title: "Remove attachment",
          onclick: () => {
            job.attachments = job.attachments.filter((a) => a.id !== att.id);
            scheduleAutosave();
            redraw();
          }
        }, "\u2715")
      ]);
      list.appendChild(chip);
    });
  }
  redraw();

  const drop = el("div", { class: "file-drop" }, "Tap to add photos or files (JPG, PNG, PDF, MOV, MP4)");
  const input = el("input", {
    type: "file",
    accept: "image/*,video/*,.pdf",
    multiple: "multiple",
    style: "display:none;",
    onchange: async (e) => {
      const files = Array.from(e.target.files || []);
      for (const file of files) {
        try {
          const dataUrl = await fileToDataUrl(file);
          job.attachments.push({
            id: uid(),
            name: file.name,
            type: file.type,
            size: file.size,
            dataUrl
          });
        } catch (err) {
          toast("Could not read " + file.name + ": " + err.message, "error");
        }
      }
      const totalBytes = totalJobPhotoBytes(job);
      if (totalBytes > MWT_CONFIG.attachmentWarningBytes) {
        toast("Heads up: attachments on this job are getting large (" + humanSize(totalBytes) + "). Storage may become slow on this tablet.", "error");
      }
      scheduleAutosave();
      redraw();
      e.target.value = "";
    }
  });
  drop.addEventListener("click", () => input.click());

  wrap.appendChild(list);
  wrap.appendChild(drop);
  wrap.appendChild(input);
  return wrap;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function humanSize(bytes) {
  if (!bytes) return "0 KB";
  const kb = bytes / 1024;
  if (kb < 1024) return Math.round(kb) + " KB";
  return (kb / 1024).toFixed(1) + " MB";
}

// ---------------------------------------------------------------
// Per-line-item photos (Blinds & Shades "camera" column)
// ---------------------------------------------------------------

function photoButtonLabel(row) {
  const n = (row.photos || []).length;
  if (!n) return "\uD83D\uDCF7";
  return "\uD83D\uDCF7 " + n;
}

// Downscales + re-compresses a photo before it's stored, so a job with
// several full-resolution phone photos doesn't balloon local storage or
// the generated PDF. Applied only to the new per-line-item photo feature;
// the general Photos/Files attachments elsewhere are left untouched.
function compressImageFile(file, maxDim, quality) {
  maxDim = maxDim || 1600;
  quality = quality || 0.82;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round(height * (maxDim / width));
            width = maxDim;
          } else {
            width = Math.round(width * (maxDim / height));
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        try {
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error("could not load image"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function totalJobPhotoBytes(job) {
  let total = (job.attachments || []).reduce((sum, a) => sum + (a.size || 0), 0);
  (job.lineItems || []).forEach((row) => {
    total += (row.photos || []).reduce((sum, p) => sum + (p.size || 0), 0);
  });
  return total;
}

function openLinePhotoManager(job, row, lineNumber, onChange) {
  if (!row.photos) row.photos = [];
  const overlay = el("div", { class: "modal-overlay", onclick: (e) => { if (e.target === overlay) close(); } });
  const modal = el("div", { class: "modal" });
  modal.appendChild(el("h3", {}, "Photos \u2014 Line " + lineNumber));

  const grid = el("div", { class: "attach-list" });
  modal.appendChild(grid);

  function redraw() {
    grid.innerHTML = "";
    if (!row.photos.length) {
      grid.appendChild(el("div", { class: "help-text" }, "No photos yet for this line."));
    }
    row.photos.forEach((p) => {
      const chip = el("div", { class: "attach-chip" }, [
        el("img", { class: "thumb thumb-lg", src: p.dataUrl }),
        el("span", {}, (p.name || "Photo") + " (" + humanSize(p.size) + ")"),
        el("button", {
          class: "remove",
          title: "Remove this photo",
          onclick: () => {
            row.photos = row.photos.filter((x) => x.id !== p.id);
            scheduleAutosave();
            redraw();
            if (onChange) onChange();
          }
        }, "\u2715")
      ]);
      grid.appendChild(chip);
    });
  }
  redraw();

  const fileInput = el("input", {
    type: "file",
    accept: "image/*",
    multiple: "multiple",
    style: "display:none;",
    onchange: async (e) => {
      const files = Array.from(e.target.files || []);
      for (const file of files) {
        try {
          const dataUrl = await compressImageFile(file);
          row.photos.push({
            id: uid(),
            name: file.name,
            type: "image/jpeg",
            size: Math.round(dataUrl.length * 0.75),
            dataUrl
          });
        } catch (err) {
          toast("Could not process " + file.name + ": " + err.message, "error");
        }
      }
      const totalBytes = totalJobPhotoBytes(job);
      if (totalBytes > MWT_CONFIG.attachmentWarningBytes) {
        toast("Heads up: photos on this job are getting large (" + humanSize(totalBytes) + "). Storage may become slow on this tablet.", "error");
      }
      scheduleAutosave();
      redraw();
      if (onChange) onChange();
      e.target.value = "";
    }
  });

  // A single generic file input works, but on iPad it's not always
  // obvious that tapping it can open the camera - so we offer two
  // explicit, clearly-labeled buttons instead. "Take Photo" uses the
  // capture attribute to jump straight to the camera; "Choose Photo"
  // opens the normal photo library picker (and still allows selecting
  // several photos at once). Both funnel into the same fileInput above,
  // just toggling the capture attribute right before opening it.
  const takePhotoBtn = el("button", {
    class: "btn btn-navy",
    style: "margin-top:10px;",
    onclick: () => {
      fileInput.removeAttribute("multiple");
      fileInput.setAttribute("capture", "environment");
      fileInput.click();
    }
  }, "\uD83D\uDCF7 Take Photo");

  const choosePhotoBtn = el("button", {
    class: "btn btn-outline",
    style: "margin-top:10px;",
    onclick: () => {
      fileInput.removeAttribute("capture");
      fileInput.setAttribute("multiple", "multiple");
      fileInput.click();
    }
  }, "\uD83D\uDDBC Choose Photo");

  const photoBtnRow = el("div", { class: "btn-row" });
  photoBtnRow.appendChild(takePhotoBtn);
  photoBtnRow.appendChild(choosePhotoBtn);
  modal.appendChild(photoBtnRow);
  modal.appendChild(fileInput);

  const btnRow = el("div", { class: "btn-row" });
  btnRow.appendChild(el("button", { class: "btn btn-outline", onclick: close }, "Close"));
  modal.appendChild(btnRow);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() { overlay.remove(); }
}

// ---------------------------------------------------------------
// Form -> job data collection (reads any inputs not bound live)
// ---------------------------------------------------------------

function collectFormData() {
  // Most fields write directly into state.currentJob via closures as the
  // installer types, so there's usually nothing left to pull here. This
  // exists so Save/PDF/Submit always work from a fully up-to-date object
  // even if a change event hasn't fired yet (e.g. a field still focused).
  return state.currentJob;
}

function validateRequired(job, schema) {
  const missing = [];
  (schema.sections || []).forEach((section) => {
    section.fields.forEach((f) => {
      if (f.required && !(job.fields[f.id] || "").toString().trim()) {
        missing.push(f.label);
      }
    });
  });
  return missing;
}

// ---------------------------------------------------------------
// Action bar: Save / PDF / Submit
// ---------------------------------------------------------------

function renderActionBar(job, schema) {
  const bar = el("div", { class: "action-bar" });

  const saveBtn = el("button", {
    class: "btn btn-outline",
    onclick: async () => {
      collectFormData();
      await persistJob(job);
      toast("Job saved.", "success");
    }
  }, "\uD83D\uDCBE  Save");

  const pdfBtn = el("button", {
    class: "btn btn-navy",
    onclick: async () => {
      collectFormData();
      await persistJob(job, { silent: true });
      await previewPdf(job, schema);
    }
  }, "\uD83D\uDCC4  Preview PDF");

  const submitBtn = el("button", {
    class: "btn btn-primary",
    onclick: () => confirmSubmit(job, schema)
  }, "\u2713  Submit & Send");

  bar.appendChild(saveBtn);
  bar.appendChild(pdfBtn);
  bar.appendChild(el("div", { class: "spacer" }));
  bar.appendChild(submitBtn);
  return bar;
}

// Detects a touch/mobile device (iPhone, iPad/iPadOS, Android phone or
// tablet) so PDF viewing can use a different, more reliable path there -
// see showPdfDocument() below for why.
function isMobileDevice() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  // iPadOS 13+ reports itself as "Macintosh" in the UA string, but is
  // still a touch device with no mouse - this catches that case too.
  return /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
}

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); // full "data:application/pdf;base64,...." string
    reader.onerror = () => reject(reader.error || new Error("Could not read the PDF."));
    reader.readAsDataURL(blob);
  });
}

// Shows a generated PDF (job.attachments preview or a fetched archived
// PDF - either way, just a Blob) to the installer/admin.
//
// Desktop keeps the original approach: a Blob URL in an <iframe> inside
// a modal - this already works correctly and is left exactly as it was.
//
// Mobile (iPhone, iPad, Android) does NOT use an iframe or a Blob URL at
// all. Both turned out to be unreliable there in real testing: Safari's
// iframe-embedded PDF renderer only shows the first page, and a Blob URL
// handed to a new tab/window can't be resolved outside the tab that
// created it (that's the Android "Open" button that does nothing).
// Instead, the PDF is converted to a self-contained data: URI (which,
// unlike a Blob URL, carries its own data and works across tabs/apps),
// and the installer/admin is given explicit actions: "Open PDF" (a real
// top-level navigation to a new tab, which lets the device's own full
// PDF viewer render every page correctly instead of a cramped iframe),
// "Share / Save PDF" via the native share sheet where supported, and
// "Download PDF" as a dependable last resort - never a dead end.
async function showPdfDocument(blob, opts) {
  opts = opts || {};
  const title = opts.title || "PDF";
  const filename = opts.filename || "document.pdf";

  if (!isMobileDevice()) {
    const url = URL.createObjectURL(blob);
    openModal({
      title,
      wide: true,
      bodyNode: el("iframe", { class: "pdf-preview-frame", src: url }),
      confirmLabel: "Close",
      onConfirm: () => URL.revokeObjectURL(url),
      hideCancel: true
    });
    return;
  }

  // Mobile path - build the data: URI once and reuse it for every
  // action below (nothing here is revoked/invalidated by using it).
  let dataUri;
  try {
    dataUri = await blobToDataUri(blob);
  } catch (err) {
    toast("Could not prepare the PDF for viewing: " + err.message, "error");
    return;
  }

  // Known platform limitation (still true as of 2026, confirmed across
  // several years of WebKit bug reports with no full fix): window.open()
  // is unreliable specifically inside an iOS PWA that's been installed
  // to the Home Screen (standalone mode) - it can silently do nothing,
  // independent of anything this app does. "Open PDF" below is still
  // offered since it works fine in an ordinary browser tab (and often in
  // standalone mode too), but it is NOT treated as the only or primary
  // option - Share and Download do not depend on window.open at all, so
  // one of them is guaranteed to work everywhere as a dependable
  // fallback rather than leaving anyone stuck on a dead screen.
  let shareFile = null;
  if (navigator.canShare) {
    try {
      const candidate = new File([blob], filename, { type: "application/pdf" });
      if (navigator.canShare({ files: [candidate] })) shareFile = candidate;
    } catch (e) { /* navigator.canShare threw on this file type - just skip this option */ }
  }

  const actions = el("div", { class: "mobile-pdf-actions" });

  // Native share sheet (Save to Files, AirDrop, Open in..., print, etc.)
  // hands the actual file to the OS directly rather than navigating to
  // it, so it isn't affected by the window.open/PWA issue above - where
  // it's available (current iOS Safari/PWA and Android Chrome), it's the
  // most dependable single action and is shown first.
  if (shareFile) {
    actions.appendChild(
      el("button", {
        class: "btn btn-navy",
        onclick: async () => {
          try {
            await navigator.share({ files: [shareFile], title: filename });
          } catch (shareErr) {
            // user cancelled the share sheet - not an error
          }
        }
      }, "\u2B06 Share / Save PDF")
    );
  }

  actions.appendChild(
    el("button", {
      class: shareFile ? "btn btn-outline" : "btn btn-navy",
      onclick: () => {
        window.open(dataUri, "_blank");
        // Deliberately no "did it work?" check here - a blocked/failed
        // window.open() on some platforms (see note above) does not
        // throw or return a reliable falsy value to detect, so Download
        // PDF below is always present as the dependable path instead of
        // guessing at an error message that may not be accurate.
      }
    }, "\uD83D\uDCC4 Open PDF")
  );

  actions.appendChild(
    el("button", {
      class: "btn btn-outline",
      onclick: () => {
        const a = document.createElement("a");
        a.href = dataUri;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    }, "\u2B07 Download PDF")
  );

  openModal({
    title,
    body: shareFile
      ? "Choose how you'd like to view or save this PDF. Share / Save PDF is the most reliable option on this device."
      : "Choose how you'd like to view or save this PDF. If Open PDF doesn't do anything, use Download PDF instead - it always works.",
    bodyNode: actions,
    confirmLabel: "Close",
    hideCancel: true
  });
}

async function previewPdf(job, schema) {
  try {
    const blob = buildJobPdfBlob(job, schema);
    await showPdfDocument(blob, { title: "PDF Preview", filename: pdfFileName(job, schema) });
  } catch (err) {
    console.error(err);
    toast("Could not generate the PDF preview: " + err.message, "error");
  }
}

// Reads the Designer's email from whichever field holds it on this
// form (Blinds & Shades / Drapery use "email" in Sold To / Bill To;
// Service / Retrofit / Cut-Down uses its own "designerEmail" field).
function getDesignerEmail(job) {
  return (job.fields.email || job.fields.designerEmail || "").trim();
}

function isValidEmailFormat(addr) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

function confirmSubmit(job, schema) {
  collectFormData();
  const missing = validateRequired(job, schema);
  if (missing.length) {
    toast("Please fill in required fields first: " + missing.join(", "), "error");
    return;
  }

  const designerEmail = getDesignerEmail(job);

  if (designerEmail && !isValidEmailFormat(designerEmail)) {
    // Do NOT submit, and do not even open a confirmation - the installer
    // must fix or clear the field first.
    toast("Please correct or remove the Designer Email before submitting.", "error");
    return;
  }

  if (!designerEmail) {
    openModal({
      title: "Designer email is missing.",
      body: "Are you sure you want to submit this job without sending a copy to the designer?",
      confirmLabel: "Submit Without Designer Email",
      confirmClass: "btn-primary",
      cancelLabel: "Go Back",
      onConfirm: () => doSubmit(job, schema)
    });
    return;
  }

  openModal({
    title: "Submit this project?",
    body: "You're about to finalize \u201c" + computeDisplayName(job) + "\u201d, generate the PDF, and send it to Matthew, Katie, MWT Measures, and the Designer on this job. You can still reopen and correct it after submitting if needed.",
    confirmLabel: "Submit & Send",
    confirmClass: "btn-primary",
    onConfirm: () => doSubmit(job, schema)
  });
}

async function doSubmit(job, schema) {
  await persistJob(job, { silent: true });

  if (!navigator.onLine) {
    job.status = "ready";
    await persistJob(job, { silent: true });
    toast("No internet connection. Your project is saved. Please submit when a connection is available.", "error");
    render();
    return;
  }

  const blob = buildJobPdfBlob(job, schema);
  const fileName = pdfFileName(job, schema);
  const jobName = computeDisplayName(job);
  const formType = schema.label || schema.pdfTitle;
  // Email subject is ONLY "Design Firm - Sidemark" (e.g. "MWT \u2013 Kandl"),
  // built directly from the entered field values - NOT the manually
  // entered Job Name, and with no form name appended. (The PDF's own
  // "Job Name" line still uses computeDisplayName() as before - this
  // only affects the email subject.)
  const subject = buildEmailSubject(job);
  const designerEmail = getDesignerEmail(job);

  // Backward-compat: a job saved before this update won't have a
  // submissionId yet - generate one now rather than block submission.
  if (!job.submissionId) job.submissionId = uid();

  try {
    const base64Pdf = await blobToBase64(blob);

    // The backend is a Google Apps Script Web App. Sending the request
    // with Content-Type "text/plain" (rather than "application/json")
    // keeps this a CORS "simple request" - Apps Script Web Apps don't
    // reliably answer the OPTIONS preflight a JSON content-type would
    // trigger, which silently breaks the request in the browser. The
    // body itself is still plain JSON text; Apps Script parses it with
    // JSON.parse(e.postData.contents) on the other end.
    //
    // Note: only the (optional, validated) designerEmail is sent - the
    // app never sends a recipient list. The three fixed company
    // addresses are hard-coded server-side and cannot be changed or
    // seen from here.
    const payloadBody = JSON.stringify({
      action: "submit",
      installerToken: getDeviceToken(),
      submissionId: job.submissionId,
      subject,
      filename: fileName,
      jobName,
      formType,
      designFirm: job.fields.designFirm || "",
      sidemark: job.fields.sidemark || "",
      projectNumber: job.projectNumber || "",
      designerEmail,
      pdfBase64: base64Pdf
    });

    const resp = await fetch(MWT_CONFIG.submitApiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: payloadBody
    });

    let payload = null;
    try { payload = await resp.json(); } catch (parseErr) { /* non-JSON error response, handled below */ }

    if (resp.ok && payload && payload.success) {
      job.status = "submitted";
      job.submittedAt = nowStamp();
      job.revision = (job.revision || 0) + 1;
      await persistJob(job, { silent: true });
      toast("Submitted successfully.", "success");
      render();
    } else {
      // Do NOT mark the job submitted, clear it, or claim success - the
      // email genuinely was not confirmed sent. The job stays saved so
      // the installer can simply try again once the issue is resolved.
      const errMsg = (payload && payload.error) ? payload.error : ("Server returned status " + resp.status);
      console.error("Submit & Send failed:", errMsg);
      toast("Submission could not be emailed. Your job is still saved. Please try again.", "error");
    }
  } catch (err) {
    // Network error, backend unreachable/not deployed yet, CORS failure, etc.
    console.error("Submit & Send failed:", err);
    toast("Submission could not be emailed. Your job is still saved. Please try again.", "error");
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function pdfFileName(job, schema) {
  const namePart = computeDisplayName(job).replace(/[^a-z0-9]+/gi, "_");
  const formPart = schema ? (schema.label || schema.pdfTitle || "").replace(/[^a-z0-9]+/gi, "_") : "";
  const combined = [namePart, formPart].filter(Boolean).join("_").replace(/_+/g, "_").slice(0, 90);
  return combined + ".pdf";
}

// Converts a Blob to a plain base64 string (no "data:...;base64," prefix)
// so it can travel inside a JSON payload to the Apps Script backend.
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const commaIdx = result.indexOf(",");
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Could not read PDF for upload."));
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------
// Modal
// ---------------------------------------------------------------

function openModal({ title, body, bodyNode, confirmLabel, confirmClass, onConfirm, hideCancel, cancelLabel, wide }) {
  const overlay = el("div", { class: "modal-overlay", onclick: (e) => { if (e.target === overlay) close(); } });
  const modal = el("div", { class: "modal", style: wide ? "max-width:900px;" : "" });
  modal.appendChild(el("h3", {}, title));
  if (bodyNode) modal.appendChild(bodyNode);
  else if (body) modal.appendChild(el("p", {}, body));

  const btnRow = el("div", { class: "btn-row" });
  if (!hideCancel) {
    btnRow.appendChild(el("button", { class: "btn btn-outline", onclick: close }, cancelLabel || "Cancel"));
  }
  btnRow.appendChild(
    el("button", {
      class: "btn " + (confirmClass || "btn-navy"),
      onclick: async () => { await onConfirm?.(); close(); }
    }, confirmLabel || "OK")
  );
  modal.appendChild(btnRow);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() { overlay.remove(); }
}

// ---------------------------------------------------------------
// Authorization: Installer (PIN) and Administrator (password) are two
// separate roles with separate tokens, separate localStorage keys, and
// separate server-side permissions - an Installer token can never be
// used for Admin actions and vice versa (enforced in Code.gs, not just
// hidden in this UI).
// ---------------------------------------------------------------

function getDeviceToken() {
  try {
    return localStorage.getItem(MWT_CONFIG.deviceTokenStorageKey) || "";
  } catch (e) {
    return ""; // private-browsing / storage disabled - falls through to asking for the PIN every time
  }
}

function setDeviceToken(token) {
  try {
    localStorage.setItem(MWT_CONFIG.deviceTokenStorageKey, token);
  } catch (e) {
    // Storage unavailable (e.g. some private-browsing modes) - the PIN
    // will simply be asked for again next time the app opens in that
    // case, which is a safe fallback rather than a broken state.
  }
}

function clearDeviceToken() {
  try { localStorage.removeItem(MWT_CONFIG.deviceTokenStorageKey); } catch (e) { /* ignore */ }
}

function getAdminToken() {
  try {
    return localStorage.getItem(MWT_CONFIG.adminTokenStorageKey) || "";
  } catch (e) {
    return "";
  }
}

function setAdminToken(token) {
  try {
    localStorage.setItem(MWT_CONFIG.adminTokenStorageKey, token);
  } catch (e) { /* ignore */ }
}

function clearAdminToken() {
  try { localStorage.removeItem(MWT_CONFIG.adminTokenStorageKey); } catch (e) { /* ignore */ }
}

function renderAccessTypeScreen() {
  document.getElementById("sidebar").style.display = "none";
  document.getElementById("topbar").style.display = "none";
  const content = document.getElementById("content");
  content.innerHTML = "";

  const wrap = el("div", { class: "auth-gate" });
  const card = el("div", { class: "auth-card access-type-card" });

  card.appendChild(el("div", { class: "auth-logo" }, ["MWT ", el("span", {}, "INSTALLER")]));
  card.appendChild(el("h2", {}, "Select Access Type"));

  card.appendChild(
    el("button", { class: "access-type-btn", onclick: () => renderAuthScreen("installer") }, [
      el("div", { class: "access-type-title" }, "Installer"),
      el("div", { class: "access-type-desc" }, "Create, edit and submit jobs")
    ])
  );
  card.appendChild(
    el("button", { class: "access-type-btn", onclick: () => renderAuthScreen("admin") }, [
      el("div", { class: "access-type-title" }, "Administrator"),
      el("div", { class: "access-type-desc" }, "View submitted jobs and archived PDFs")
    ])
  );

  wrap.appendChild(card);
  content.appendChild(wrap);
}

function renderAuthScreen(role) {
  const isAdmin = role === "admin";
  document.getElementById("sidebar").style.display = "none";
  document.getElementById("topbar").style.display = "none";
  const content = document.getElementById("content");
  content.innerHTML = "";

  const wrap = el("div", { class: "auth-gate" });
  const card = el("div", { class: "auth-card" });

  card.appendChild(el("div", { class: "auth-logo" }, ["MWT ", el("span", {}, "INSTALLER")]));
  card.appendChild(el("h2", {}, isAdmin ? "Administrator Login" : "Device Authorization"));
  card.appendChild(el("div", { class: "help-text", style: "margin-bottom:16px;" }, isAdmin ? "Enter Admin Password" : "Enter Access Code"));

  const input = isAdmin
    ? el("input", { type: "password", autocomplete: "off", class: "auth-pin-input auth-password-input", placeholder: "Password" })
    : el("input", {
        type: "tel", inputmode: "numeric", pattern: "[0-9]*", maxlength: "4", autocomplete: "off",
        class: "auth-pin-input", placeholder: "\u2022\u2022\u2022\u2022"
      });

  input.addEventListener("input", () => {
    if (!isAdmin) input.value = input.value.replace(/[^0-9]/g, "").slice(0, 4);
    errorBox.textContent = "";
  });
  card.appendChild(input);

  const errorBox = el("div", { class: "auth-error" }, "");
  card.appendChild(errorBox);

  const authorizeBtn = el("button", { class: "btn btn-primary auth-btn" }, isAdmin ? "Authorize Administrator" : "Authorize iPad");
  card.appendChild(authorizeBtn);
  card.appendChild(el("button", { class: "btn btn-ghost auth-back-btn", onclick: () => renderAccessTypeScreen() }, "\u2190 Back"));

  function setBusy(busy) {
    authorizeBtn.disabled = busy;
    input.disabled = busy;
    authorizeBtn.textContent = busy ? "Checking\u2026" : (isAdmin ? "Authorize Administrator" : "Authorize iPad");
  }

  async function attemptAuthorize() {
    const value = input.value.trim();
    if (!isAdmin && value.length !== 4) {
      errorBox.textContent = "Enter the 4-digit access code.";
      return;
    }
    if (isAdmin && !value) {
      errorBox.textContent = "Enter the administrator password.";
      return;
    }
    if (!navigator.onLine) {
      errorBox.textContent = "No internet connection. Connect this device to the internet once to authorize it.";
      return;
    }
    setBusy(true);
    errorBox.textContent = "";
    try {
      const bodyObj = isAdmin
        ? { action: "authorizeAdmin", password: value }
        : { action: "authorizeInstaller", pin: value };
      const resp = await fetch(MWT_CONFIG.submitApiUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(bodyObj)
      });
      let payload = null;
      try { payload = await resp.json(); } catch (parseErr) { /* handled below */ }

      if (resp.ok && payload && payload.success && payload.token) {
        if (isAdmin) setAdminToken(payload.token);
        else setDeviceToken(payload.token);

        content.innerHTML = "";
        content.appendChild(el("div", { class: "auth-gate" }, el("div", { class: "auth-card" }, [
          el("div", { class: "auth-logo" }, ["MWT ", el("span", {}, "INSTALLER")]),
          el("h2", {}, isAdmin ? "This device has been authorized as Administrator." : "This iPad has been authorized."),
          el("div", { class: "help-text" }, "Opening the dashboard\u2026")
        ])));
        setTimeout(async () => {
          if (isAdmin) {
            renderAdminDashboard();
          } else {
            document.getElementById("sidebar").style.display = "";
            document.getElementById("topbar").style.display = "";
            await refreshJobsCache();
            await cleanupOldSubmittedJobs();
            render();
          }
        }, 900);
      } else {
        errorBox.textContent = (payload && payload.error) ? payload.error : ("Incorrect " + (isAdmin ? "password" : "access code") + ".");
        input.value = "";
        input.focus();
      }
    } catch (err) {
      errorBox.textContent = "Could not reach the server. Check your connection and try again.";
    } finally {
      setBusy(false);
    }
  }

  authorizeBtn.addEventListener("click", attemptAuthorize);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") attemptAuthorize(); });

  wrap.appendChild(card);
  content.appendChild(wrap);
  input.focus();
}

// ---------------------------------------------------------------
// Local retention: submitted jobs are kept locally for convenience for
// a limited time, then their local copy (and photos) are removed - the
// central Drive/Sheet archive is untouched and Admins keep seeing them
// there. Drafts and "ready" (offline-pending) jobs are NEVER
// auto-deleted, no matter how old.
// ---------------------------------------------------------------
async function cleanupOldSubmittedJobs() {
  try {
    const jobs = await MwtDB.getAllJobs();
    const cutoffMs = (MWT_CONFIG.submittedJobRetentionDays || 60) * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const job of jobs) {
      if (job.status !== "submitted" || !job.submittedAt) continue;
      const age = now - new Date(job.submittedAt).getTime();
      if (age > cutoffMs) {
        await MwtDB.deleteJob(job.id);
      }
    }
  } catch (err) {
    console.warn("Local retention cleanup skipped:", err);
  }
}

// ---------------------------------------------------------------
// Administrator Dashboard - "Submitted Jobs"
// Only ever loads paginated metadata from the backend; the actual PDF
// for a row is fetched only when that row's "View PDF" is tapped.
// Installer drafts/local jobs are never shown here and never queried -
// this view talks only to the central archive via the Admin token.
// ---------------------------------------------------------------

const adminState = {
  page: 1,
  pageSize: 25,
  designFirm: "",
  sidemark: "",
  projectNumber: "",
  formType: "",
  rows: [],
  total: 0,
  loading: false,
  error: ""
};

async function renderAdminDashboard() {
  document.getElementById("sidebar").style.display = "none";
  document.getElementById("topbar").style.display = "none";
  const content = document.getElementById("content");
  content.innerHTML = "";

  const wrap = el("div", { class: "admin-wrap" });

  const header = el("div", { class: "admin-header" }, [
    el("div", { class: "admin-title" }, "Submitted Jobs"),
    el("button", {
      class: "btn btn-outline",
      onclick: () => {
        openModal({
          title: "Log out of Administrator Mode?",
          body: "This removes this device's Administrator authorization. You'll need the admin password again to view Submitted Jobs.",
          confirmLabel: "Log Out",
          confirmClass: "btn-danger",
          onConfirm: logOutAdmin
        });
      }
    }, "\u23FB Log Out")
  ]);
  wrap.appendChild(header);

  const filterBar = el("div", { class: "admin-filter-bar" });
  const dfInput = el("input", { type: "text", placeholder: "Design Firm", value: adminState.designFirm });
  const sideInput = el("input", { type: "text", placeholder: "Sidemark", value: adminState.sidemark });
  const projInput = el("input", { type: "text", placeholder: "MWT Project #", value: adminState.projectNumber });
  const formSelect = el("select", {}, [
    el("option", { value: "" }, "All form types"),
    ...MWT_FORM_SCHEMAS.map((s) => el("option", { value: s.label, selected: adminState.formType === s.label ? "selected" : null }, s.label))
  ]);
  const searchBtn = el("button", { class: "btn btn-navy" }, "Search");
  [dfInput, sideInput, projInput].forEach((inp) => {
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  });
  function doSearch() {
    adminState.designFirm = dfInput.value.trim();
    adminState.sidemark = sideInput.value.trim();
    adminState.projectNumber = projInput.value.trim();
    adminState.formType = formSelect.value;
    adminState.page = 1;
    loadAndRenderResults();
  }
  searchBtn.addEventListener("click", doSearch);
  formSelect.addEventListener("change", doSearch);

  filterBar.appendChild(dfInput);
  filterBar.appendChild(sideInput);
  filterBar.appendChild(projInput);
  filterBar.appendChild(formSelect);
  filterBar.appendChild(searchBtn);
  wrap.appendChild(filterBar);

  const resultsBox = el("div", { class: "admin-results" });
  wrap.appendChild(resultsBox);

  content.appendChild(wrap);

  async function loadAndRenderResults() {
    resultsBox.innerHTML = "";
    if (!navigator.onLine) {
      resultsBox.appendChild(el("div", { class: "needs-review-banner" }, "No internet connection. Submitted Jobs requires an internet connection to load - please reconnect and search again."));
      return;
    }
    resultsBox.appendChild(el("div", { class: "help-text" }, "Loading\u2026"));

    try {
      const resp = await fetch(MWT_CONFIG.submitApiUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "listSubmissions",
          adminToken: getAdminToken(),
          page: adminState.page,
          pageSize: adminState.pageSize,
          designFirm: adminState.designFirm,
          sidemark: adminState.sidemark,
          projectNumber: adminState.projectNumber,
          formType: adminState.formType
        })
      });
      let payload = null;
      try { payload = await resp.json(); } catch (e) { /* handled below */ }

      resultsBox.innerHTML = "";
      if (!resp.ok || !payload || !payload.success) {
        resultsBox.appendChild(el("div", { class: "needs-review-banner" }, (payload && payload.error) ? payload.error : "Could not load submitted jobs."));
        return;
      }

      adminState.rows = payload.rows || [];
      adminState.total = payload.total || 0;
      renderResultsTable(resultsBox);
    } catch (err) {
      resultsBox.innerHTML = "";
      resultsBox.appendChild(el("div", { class: "needs-review-banner" }, "Could not reach the server. Check your connection and try again."));
    }
  }

  function renderResultsTable(box) {
    box.innerHTML = "";
    if (!adminState.rows.length) {
      box.appendChild(el("div", { class: "empty-state" }, [
        el("div", { class: "big" }, "\uD83D\uDCC1"),
        el("div", {}, "No submitted jobs match this search.")
      ]));
      return;
    }

    const table = el("table", { class: "job-table" });
    table.appendChild(el("thead", {}, el("tr", {}, [
      el("th", {}, "Submitted"), el("th", {}, "Design Firm"), el("th", {}, "Sidemark"),
      el("th", {}, "Project #"), el("th", {}, "Form Type"), el("th", {}, "Designer Email"), el("th", {}, "")
    ])));
    const tbody = el("tbody", {});
    adminState.rows.forEach((r) => {
      tbody.appendChild(el("tr", {}, [
        el("td", {}, fmtTime(r.timestamp)),
        el("td", {}, r.designFirm || "\u2014"),
        el("td", {}, r.sidemark || "\u2014"),
        el("td", {}, r.projectNumber || "\u2014"),
        el("td", {}, r.formType || "\u2014"),
        el("td", {}, r.designerEmail || "\u2014"),
        el("td", {}, el("button", { class: "btn btn-ghost", onclick: () => viewSubmittedPdf(r) }, "View PDF"))
      ]));
    });
    table.appendChild(tbody);
    box.appendChild(el("div", { class: "card", style: "overflow-x:auto;" }, table));

    const totalPages = Math.max(1, Math.ceil(adminState.total / adminState.pageSize));
    const pager = el("div", { class: "btn-row", style: "margin-top:12px;" }, [
      el("button", { class: "btn btn-outline", disabled: adminState.page <= 1 ? "disabled" : null, onclick: () => { adminState.page--; loadAndRenderResults(); } }, "\u2190 Prev"),
      el("div", { class: "help-text", style: "align-self:center;" }, "Page " + adminState.page + " of " + totalPages + " (" + adminState.total + " total)"),
      el("button", { class: "btn btn-outline", disabled: adminState.page >= totalPages ? "disabled" : null, onclick: () => { adminState.page++; loadAndRenderResults(); } }, "Next \u2192")
    ]);
    box.appendChild(pager);
  }

  async function viewSubmittedPdf(row) {
    if (!navigator.onLine) {
      toast("No internet connection. Connect to view the PDF.", "error");
      return;
    }
    toast("Loading PDF\u2026");
    try {
      const resp = await fetch(MWT_CONFIG.submitApiUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "getSubmissionPdf", adminToken: getAdminToken(), submissionId: row.submissionId })
      });
      let payload = null;
      try { payload = await resp.json(); } catch (e) { /* handled below */ }
      if (!resp.ok || !payload || !payload.success) {
        toast((payload && payload.error) ? payload.error : "Could not load that PDF.", "error");
        return;
      }
      const byteChars = atob(payload.pdfBase64);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/pdf" });
      await showPdfDocument(blob, {
        title: "Submitted PDF \u2014 " + (row.designFirm || "") + " \u2013 " + (row.sidemark || ""),
        filename: payload.filename || row.pdfFilename || (row.submissionId + ".pdf")
      });
    } catch (err) {
      toast("Could not reach the server. Check your connection and try again.", "error");
    }
  }

  await loadAndRenderResults();
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------

function updateOfflineBanner() {
  const banner = document.getElementById("offline-banner");
  if (!banner) return;
  banner.classList.toggle("show", !navigator.onLine);
}

window.addEventListener("online", updateOfflineBanner);
window.addEventListener("offline", updateOfflineBanner);

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("menu-btn").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });
  updateOfflineBanner();

  if (getDeviceToken()) {
    // Already authorized as Installer on this iPad - go straight to the
    // dashboard, no network call needed (keeps app opening fully
    // offline-capable).
    await refreshJobsCache();
    await cleanupOldSubmittedJobs();
    render();
  } else if (getAdminToken()) {
    // Already authorized as Administrator - Submitted Jobs itself needs
    // a connection to load, but opening the app does not.
    renderAdminDashboard();
  } else {
    renderAccessTypeScreen();
  }
});
