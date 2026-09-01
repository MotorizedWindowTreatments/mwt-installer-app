/* ============================================================
   MWT Installer - Weekly Itinerary (js/itinerary.js)
   ============================================================
   A self-contained feature module, deliberately NOT folded into the
   existing order-form schema system (formSchemas.js / renderJobForm) -
   Weekly Itinerary has a different shape (a week of days, each with
   its own jobs list and mileage) that doesn't fit that model without
   distorting it, per the explicit instruction to keep this a special
   workflow.

   Storage: its own IndexedDB object store ("itineraries", see db.js /
   MwtItineraryDB) - completely separate from the "jobs" store, so
   every existing job-listing function (sidebar, dashboard, Saved Jobs,
   search, Duplicate, Delete, Export/Import Backup) needed zero changes
   and can never show or touch an itinerary record.

   This file relies on globals already defined in app.js: el(), toast(),
   openModal(), uid(), nowStamp(), fmtTime(), state, goTo(), render(),
   MWT_CONFIG, getDeviceToken(), getAdminToken(), blobToBase64(),
   showPdfDocument(), buildItineraryPdfBlob() (added to pdf.js).

   Business logic below (hours = (finish-start) in decimal hours; work
   performed categorized by prefix: Install/Measure/"Cut-Down"+
   "Retrofit" combined/Service Call; daily Total Miles = Ending -
   Starting; weekly Mileage Reimbursement = Total Miles x $0.30; Total
   Reimbursable = Mileage Reimbursement + Parking/Fuel + Tolls) was
   read directly out of the formulas in Matthew's
   "Installer Weekly Itinerary Worksheet Sheet.xlsm" (COUNTIFS on the
   Work Performed columns, the per-day mileage formulas, and the
   Total dollar amount for Mileage (@ $0.30/mi) / Total Reimbursable
   Expenses cells), not re-derived from the prose description alone.
   ============================================================ */

const ITINERARY_INSTALLER_PRESETS = ["Bill", "Victor", "Matthew", "Carlos", "Other"];
const ITINERARY_WORK_PERFORMED_OPTIONS = ["Install", "Measure", "Service Call", "Cut-Down", "Retrofit"];
const ITINERARY_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat"];
const ITINERARY_DAY_LABELS = { mon: "MON", tue: "TUE", wed: "WED", thu: "THU", fri: "FRI", sat: "SAT" };
const ITINERARY_DAY_FULL_LABELS = { mon: "MONDAY", tue: "TUESDAY", wed: "WEDNESDAY", thu: "THURSDAY", fri: "FRIDAY", sat: "SATURDAY" };
const ITINERARY_LAST_PRESET_KEY = "mwt_last_itinerary_preset";
const ITINERARY_LAST_OTHER_NAME_KEY = "mwt_last_itinerary_other_name";

// ---------------------------------------------------------------
// Date / week utilities - computed dynamically forever, nothing about
// any specific year is hardcoded.
// ---------------------------------------------------------------

function itnPad2(n) { return String(n).padStart(2, "0"); }

function itnIsoDate(d) {
  return d.getFullYear() + "-" + itnPad2(d.getMonth() + 1) + "-" + itnPad2(d.getDate());
}

function itnParseIsoDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function itnAddDays(iso, n) {
  const d = itnParseIsoDate(iso);
  d.setDate(d.getDate() + n);
  return itnIsoDate(d);
}

// Monday of the week containing `date` (Sunday counts as the END of
// the prior Mon-Sat work week for this purpose, since the itinerary
// only ever covers Monday-Saturday).
function itnMondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function itnCurrentWeekStart() {
  return itnIsoDate(itnMondayOf(new Date()));
}

function itnFormatWeekRange(weekStartIso) {
  const start = itnParseIsoDate(weekStartIso);
  const end = itnParseIsoDate(itnAddDays(weekStartIso, 5));
  const startMonth = start.toLocaleDateString("en-US", { month: "short" });
  const endMonth = end.toLocaleDateString("en-US", { month: "short" });
  const crossYear = start.getFullYear() !== end.getFullYear();
  // A week spanning two calendar years shows both years explicitly
  // (e.g. "Dec 28, 2026 - Jan 2, 2027"); a normal week stays concise
  // ("Aug 31 - Sep 5, 2026" / "Aug 3 - 8, 2026").
  const startPart = startMonth + " " + start.getDate() + (crossYear ? ", " + start.getFullYear() : "");
  const endPart = (startMonth === endMonth && !crossYear ? "" : endMonth + " ") + end.getDate();
  return startPart + "\u2013" + endPart + ", " + end.getFullYear();
}

// Same as above but with a space around the en dash, used in headings/
// PDF text where the tighter inline form above reads a little cramped.
function itnFormatWeekRangeSpaced(weekStartIso) {
  return itnFormatWeekRange(weekStartIso).replace("\u2013", " \u2013 ");
}

function itnFormatDayTabLabel(dayKey, weekStartIso) {
  const idx = ITINERARY_DAY_KEYS.indexOf(dayKey);
  const date = itnParseIsoDate(itnAddDays(weekStartIso, idx));
  return ITINERARY_DAY_LABELS[dayKey] + " " + date.getDate();
}

// All Monday-Saturday weeks that ACTUALLY overlap the given month/year,
// for the "Choose Week" picker - weeks may cross into the next month
// (e.g. "Aug 31 - Sep 5") and are listed under the month their Monday
// falls in. Explicitly guards against the case where the 1st of the
// month is a Sunday: the Mon-Sat week "containing" that Sunday is
// entirely in the PREVIOUS month (e.g. Jul 26 - 31 for an August that
// starts on a Sunday) and must not be listed under this month.
function itnWeeksInMonth(year, monthIndex0) {
  const firstOfMonth = new Date(year, monthIndex0, 1);
  const lastOfMonth = new Date(year, monthIndex0 + 1, 0);
  let cursor = itnMondayOf(firstOfMonth);
  const weeks = [];
  while (cursor <= lastOfMonth) {
    const weekEnd = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 5); // Saturday
    if (weekEnd >= firstOfMonth) {
      weeks.push(itnIsoDate(cursor));
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7);
  }
  return weeks;
}

// ---------------------------------------------------------------
// Data model
// ---------------------------------------------------------------

function blankItineraryJob() {
  return { id: uid(), customer: "", workPerformed: "", product: "" };
}

function blankItineraryDay() {
  return {
    startTime: "",
    finishTime: "",
    jobs: [],
    startMileage: "",
    endMileage: "",
    tolls: "",
    parkingFuel: ""
  };
}

function blankItinerary(installerPreset, weekStart) {
  const days = {};
  ITINERARY_DAY_KEYS.forEach((k) => { days[k] = blankItineraryDay(); });
  return {
    id: uid(),
    submissionId: uid(),
    // "" is a valid, intentional value here (no installer chosen yet on
    // a brand-new device) - only fall back when the argument wasn't
    // passed at all.
    installerPreset: installerPreset !== undefined ? installerPreset : "Bill",
    installerNameOther: "",
    weekStart: weekStart || itnCurrentWeekStart(),
    status: "draft",
    createdAt: nowStamp(),
    lastModified: nowStamp(),
    submittedAt: null,
    revision: 0,
    days
  };
}

function itineraryInstallerName(it) {
  if (it.installerPreset === "Other") return (it.installerNameOther || "").trim();
  return it.installerPreset || "";
}

function itineraryDisplayName(it) {
  const name = itineraryInstallerName(it) || "Unnamed";
  return name + " \u2013 " + itnFormatWeekRange(it.weekStart);
}

async function findItineraryByInstallerAndWeek(installerName, weekStart) {
  const needle = (installerName || "").trim().toLowerCase();
  if (!needle) return null;
  const all = await MwtItineraryDB.getAllItineraries();
  return all.find((it) => itineraryInstallerName(it).trim().toLowerCase() === needle && it.weekStart === weekStart) || null;
}

// ---------------------------------------------------------------
// Switching Installer or Week (preset buttons, Other name, week
// arrows, Choose Week) must NEVER mutate the currently-open record in
// place - Installer + Week IS the record's identity. This is the one
// place that identity is allowed to change, and it always does so by
// saving whatever is currently on screen under its OWN existing
// identity first, then finding-or-creating the record for the NEW
// identity and navigating there - never carrying days/jobs/hours/
// mileage across to a different installer or week.
// Requires an already-resolved, non-empty installer name - callers for
// "Other" must obtain that name via openOtherInstallerNameModal() BEFORE
// ever calling this, so this function is never in a position to touch
// itinerary.installerPreset/installerNameOther based on a still-blank
// name. That in-place mutation was the root cause of a real bug: it
// silently relabeled the CURRENT record as an unidentified "Other" with
// no name, and the next call then saw a blank identity and deleted that
// same (originally Bill's/etc) record. This function now either fully
// commits a real identity switch, or does nothing at all - never a
// half-mutated in-between state.
async function switchItineraryContext(itinerary, newPreset, newResolvedName, newWeekStart) {
  if (!newResolvedName) {
    console.warn("switchItineraryContext called without a resolved installer name - ignoring, nothing changed.");
    return;
  }

  const oldName = itineraryInstallerName(itinerary);
  if (oldName) {
    await persistItinerary(itinerary, { silent: true });
  } else {
    // This was only an unidentified placeholder (a brand-new device,
    // before any installer had ever been chosen) - remove it rather
    // than leaving an empty "Unnamed" record behind now that a real
    // identity is being chosen.
    try { await MwtItineraryDB.deleteItinerary(itinerary.id); } catch (e) { /* ignore */ }
  }

  try {
    localStorage.setItem(ITINERARY_LAST_PRESET_KEY, newPreset);
    localStorage.setItem(ITINERARY_LAST_OTHER_NAME_KEY, newPreset === "Other" ? newResolvedName : "");
  } catch (e) { /* ignore */ }

  let target = await findItineraryByInstallerAndWeek(newResolvedName, newWeekStart);
  if (!target) {
    target = blankItinerary(newPreset, newWeekStart);
    if (newPreset === "Other") target.installerNameOther = newResolvedName;
    await persistItinerary(target, { silent: true });
  }
  goTo({ type: "itineraryEditor", itineraryId: target.id });
}

// Changing the WEEK while no installer has been chosen yet (still on
// the unidentified placeholder) is safe to apply directly - there is no
// real identity, so there is nothing to protect from being overwritten.
// Once an installer IS chosen, week changes go through the same
// save-current + find-or-create flow as switching installer.
function changeItineraryWeek(itinerary, newWeekStart) {
  const name = itineraryInstallerName(itinerary);
  if (!name) {
    itinerary.weekStart = newWeekStart;
    scheduleItineraryAutosave(itinerary);
    renderItinerarySoft(itinerary);
    return;
  }
  switchItineraryContext(itinerary, itinerary.installerPreset, name, newWeekStart);
}

// Small modal used ONLY to collect a confirmed "Other" installer name -
// nothing about the current itinerary record is touched unless/until
// the user actually confirms a non-empty name here. Cancelling (or
// tapping outside) leaves the current installer/week completely
// unchanged.
function openOtherInstallerNameModal(currentName, onConfirm) {
  const overlay = el("div", { class: "modal-overlay", onclick: (e) => { if (e.target === overlay) close(); } });
  const modal = el("div", { class: "modal" });
  modal.appendChild(el("h3", {}, "Installer Name"));
  const errorBox = el("div", { class: "itinerary-error" }, "");
  const input = el("input", {
    type: "text",
    class: "itinerary-other-input",
    placeholder: "Installer Name",
    value: currentName || ""
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") confirm(); });
  modal.appendChild(input);
  modal.appendChild(errorBox);

  const btnRow = el("div", { class: "btn-row" });
  btnRow.appendChild(el("button", { class: "btn btn-outline", onclick: () => close() }, "Cancel"));
  btnRow.appendChild(el("button", { class: "btn btn-primary", onclick: () => confirm() }, "Continue"));
  modal.appendChild(btnRow);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  input.focus();

  function confirm() {
    const name = input.value.trim();
    if (!name) {
      errorBox.textContent = "Enter an installer name, or tap Cancel.";
      return;
    }
    close();
    onConfirm(name);
  }
  function close() { overlay.remove(); }
}

// ---------------------------------------------------------------
// Calculations (from the workbook's formulas - see file header)
// ---------------------------------------------------------------

// (Finish - Start) in decimal hours. Returns { hours, error } - error is
// a user-facing string when Finish is not after Start, rather than
// silently producing zero or a negative number.
function itnComputeDayHours(day) {
  if (!day.startTime || !day.finishTime) return { hours: 0, error: null };
  const [sh, sm] = day.startTime.split(":").map(Number);
  const [fh, fm] = day.finishTime.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const finishMin = fh * 60 + fm;
  if (finishMin <= startMin) {
    return { hours: 0, error: "Finish Time must be after Start Time." };
  }
  return { hours: (finishMin - startMin) / 60, error: null };
}

function itnComputeDayMiles(day) {
  const start = parseFloat(day.startMileage);
  const end = parseFloat(day.endMileage);
  if (isNaN(start) || isNaN(end)) return { miles: 0, error: null };
  if (end < start) return { miles: 0, error: "Ending Mileage cannot be less than Starting Mileage." };
  return { miles: end - start, error: null };
}

function itnWorkPerformedCategory(value) {
  const v = (value || "").trim().toLowerCase();
  if (!v) return null;
  if (v.indexOf("install") === 0) return "installs";
  if (v.indexOf("measure") === 0) return "measures";
  if (v.indexOf("cut") === 0 || v.indexOf("retro") === 0) return "cutDownRetrofits";
  if (v.indexOf("service") === 0) return "serviceCalls";
  return null;
}

function computeItineraryTotals(itinerary) {
  const totals = {
    totalHours: 0, installs: 0, measures: 0, cutDownRetrofits: 0, serviceCalls: 0,
    totalMiles: 0, mileageReimbursement: 0, parkingFuel: 0, tolls: 0, totalReimbursable: 0
  };
  ITINERARY_DAY_KEYS.forEach((k) => {
    const day = itinerary.days[k];
    const h = itnComputeDayHours(day);
    if (!h.error) totals.totalHours += h.hours;
    const m = itnComputeDayMiles(day);
    if (!m.error) totals.totalMiles += m.miles;
    totals.parkingFuel += parseFloat(day.parkingFuel) || 0;
    totals.tolls += parseFloat(day.tolls) || 0;
    (day.jobs || []).forEach((j) => {
      const cat = itnWorkPerformedCategory(j.workPerformed);
      if (cat) totals[cat] += 1;
    });
  });
  totals.mileageReimbursement = totals.totalMiles * 0.3;
  totals.totalReimbursable = totals.mileageReimbursement + totals.parkingFuel + totals.tolls;
  return totals;
}

// ---------------------------------------------------------------
// Persistence (mirrors persistJob()/scheduleAutosave() in app.js, but
// against the separate itineraries store)
// ---------------------------------------------------------------

async function persistItinerary(itinerary, opts) {
  opts = opts || {};
  itinerary.lastModified = nowStamp();
  await MwtItineraryDB.saveItinerary(itinerary);
  if (!opts.silent) setSaveIndicator("saved");
}

let _itineraryAutosaveTimer = null;
function scheduleItineraryAutosave(itinerary) {
  setSaveIndicator("unsaved");
  if (_itineraryAutosaveTimer) clearTimeout(_itineraryAutosaveTimer);
  _itineraryAutosaveTimer = setTimeout(async () => {
    await persistItinerary(itinerary);
  }, 1200);
}

// Same 60-day local retention philosophy as regular jobs - only ever
// removes ones that were successfully SUBMITTED; drafts are never
// touched regardless of age. Completely independent of
// cleanupOldSubmittedJobs() in app.js.
async function cleanupOldSubmittedItineraries() {
  try {
    const all = await MwtItineraryDB.getAllItineraries();
    const cutoffMs = (MWT_CONFIG.submittedJobRetentionDays || 60) * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const it of all) {
      if (it.status !== "submitted" || !it.submittedAt) continue;
      if (now - new Date(it.submittedAt).getTime() > cutoffMs) {
        await MwtItineraryDB.deleteItinerary(it.id);
      }
    }
  } catch (err) {
    console.warn("Itinerary retention cleanup skipped:", err);
  }
}

// ---------------------------------------------------------------
// Dashboard tile + sidebar entry (called from app.js's renderDashboard()
// / renderSidebar() with a single extra line each - see app.js)
// ---------------------------------------------------------------

function renderItineraryDashboardTile() {
  return el("button", { class: "dash-tile", onclick: () => goTo({ type: "itineraryHome" }) }, [
    el("div", { class: "tile-icon" }, "\uD83D\uDDD3\uFE0F"),
    el("h3", {}, "Weekly Itinerary"),
    el("p", {}, "Weekly hours, jobs & expenses")
  ]);
}

// ---------------------------------------------------------------
// Routing entry points (called from app.js's render() with a couple of
// extra `else if` branches - see app.js)
// ---------------------------------------------------------------

async function renderItineraryHomeRoute(content) {
  let lastPreset = "";
  let lastOtherName = "";
  try {
    lastPreset = localStorage.getItem(ITINERARY_LAST_PRESET_KEY) || "";
    lastOtherName = localStorage.getItem(ITINERARY_LAST_OTHER_NAME_KEY) || "";
  } catch (e) { /* ignore */ }

  const weekStart = itnCurrentWeekStart();

  if (!lastPreset) {
    // Brand-new device - no installer has ever been chosen here yet.
    // Do NOT silently assume "Bill": show the editor on an unidentified
    // placeholder record so the installer can pick who they are. This
    // placeholder is saved so its id is always resolvable, but has no
    // real installer identity yet, and is cleaned up automatically
    // (see switchItineraryContext) the moment a real one is chosen.
    const placeholder = blankItinerary("", weekStart);
    await persistItinerary(placeholder, { silent: true });
    state.route = { type: "itineraryEditor", itineraryId: placeholder.id };
    content.appendChild(renderItineraryEditor(placeholder));
    return;
  }

  const installerName = lastPreset === "Other" ? lastOtherName : lastPreset;
  let itinerary = await findItineraryByInstallerAndWeek(installerName, weekStart);
  if (!itinerary) {
    itinerary = blankItinerary(lastPreset, weekStart);
    if (lastPreset === "Other") itinerary.installerNameOther = lastOtherName;
    await persistItinerary(itinerary, { silent: true });
  }
  state.route = { type: "itineraryEditor", itineraryId: itinerary.id };
  content.appendChild(await renderItineraryEditorRoute(itinerary));
}

async function renderItineraryEditorRoute(itineraryOrId) {
  const itinerary = typeof itineraryOrId === "string" ? await MwtItineraryDB.getItinerary(itineraryOrId) : itineraryOrId;
  if (!itinerary) {
    toast("That weekly itinerary could not be found - it may have been deleted.", "error");
    goTo({ type: "dashboard" });
    return el("div", {});
  }
  return renderItineraryEditor(itinerary);
}

async function renderItineraryListRoute() {
  const wrap = el("div", {});
  wrap.appendChild(el("h2", {}, "Weekly Itineraries"));

  const all = await MwtItineraryDB.getAllItineraries();
  all.sort((a, b) => (b.lastModified || "").localeCompare(a.lastModified || ""));

  wrap.appendChild(
    el("button", { class: "btn btn-navy", style: "margin-bottom:16px;", onclick: () => goTo({ type: "itineraryHome" }) }, "+ This Week's Itinerary")
  );

  if (all.length === 0) {
    wrap.appendChild(el("div", { class: "empty-state" }, [
      el("div", { class: "big" }, "\uD83D\uDDD3\uFE0F"),
      el("div", {}, "No weekly itineraries yet.")
    ]));
    return wrap;
  }

  const table = el("table", { class: "job-table" });
  table.appendChild(el("thead", {}, el("tr", {}, [
    el("th", {}, "Installer"), el("th", {}, "Week"), el("th", {}, "Status"), el("th", {}, "Last Modified"), el("th", {}, "Actions")
  ])));
  const tbody = el("tbody", {});
  all.forEach((it) => {
    tbody.appendChild(el("tr", {}, [
      el("td", {}, el("a", { href: "javascript:void(0)", onclick: () => goTo({ type: "itineraryEditor", itineraryId: it.id }) }, itineraryInstallerName(it) || "Unnamed")),
      el("td", {}, itnFormatWeekRange(it.weekStart)),
      el("td", {}, el("span", { class: "badge badge-" + it.status }, it.status)),
      el("td", {}, fmtTime(it.lastModified)),
      el("td", {}, [
        el("button", { class: "btn btn-ghost", onclick: () => goTo({ type: "itineraryEditor", itineraryId: it.id }) }, "Open"),
        el("button", {
          class: "btn btn-ghost",
          onclick: () => {
            openModal({
              title: "Delete this weekly itinerary?",
              body: "This permanently deletes this itinerary from this device. This cannot be undone.",
              confirmLabel: "Delete",
              confirmClass: "btn-danger",
              onConfirm: async () => {
                await MwtItineraryDB.deleteItinerary(it.id);
                toast("Weekly itinerary deleted.");
                render();
              }
            });
          }
        }, "Delete")
      ])
    ]));
  });
  table.appendChild(tbody);
  wrap.appendChild(el("div", { class: "card", style: "overflow-x:auto;" }, table));
  return wrap;
}

// ---------------------------------------------------------------
// Editor
// ---------------------------------------------------------------

const itineraryUiState = { activeDay: "mon" };

function renderItineraryEditor(itinerary) {
  const wrap = el("div", { class: "itinerary-editor" });

  // ---- Installer selector ----
  const installerCard = el("div", { class: "card itinerary-card" });
  installerCard.appendChild(el("h4", {}, "Installer"));
  const presetRow = el("div", { class: "itinerary-preset-row" });
  ITINERARY_INSTALLER_PRESETS.forEach((preset) => {
    presetRow.appendChild(
      el("button", {
        class: "itinerary-preset-btn" + (itinerary.installerPreset === preset ? " active" : ""),
        onclick: () => {
          if (preset === "Other") {
            // Collect a confirmed name via modal BEFORE touching the
            // current record at all - see openOtherInstallerNameModal().
            const currentOtherName = itinerary.installerPreset === "Other" ? itinerary.installerNameOther : "";
            openOtherInstallerNameModal(currentOtherName, (name) => {
              switchItineraryContext(itinerary, "Other", name, itinerary.weekStart);
            });
          } else {
            switchItineraryContext(itinerary, preset, preset, itinerary.weekStart);
          }
        }
      }, preset)
    );
  });
  installerCard.appendChild(presetRow);

  if (itinerary.installerPreset === "Other") {
    const otherInput = el("input", {
      type: "text",
      class: "itinerary-other-input",
      placeholder: "Installer Name",
      value: itinerary.installerNameOther,
      // Committed on blur (or Enter), not on every keystroke - typing a
      // name must not trigger a record switch/lookup mid-type. Clearing
      // the name is rejected outright (reverts the field) rather than
      // ever blanking/mutating the current record.
      onblur: (e) => {
        const newName = e.target.value.trim();
        const currentName = itineraryInstallerName(itinerary);
        if (!newName) {
          e.target.value = currentName;
          return;
        }
        if (newName === currentName) return;
        switchItineraryContext(itinerary, "Other", newName, itinerary.weekStart);
      },
      onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); }
    });
    installerCard.appendChild(el("label", { class: "itinerary-other-label" }, ["Installer Name", otherInput]));
  }
  wrap.appendChild(installerCard);

  // ---- Week selector ----
  const weekCard = el("div", { class: "card itinerary-card" });
  const weekNav = el("div", { class: "itinerary-week-nav" });
  weekNav.appendChild(el("button", {
    class: "btn btn-outline itinerary-week-arrow",
    onclick: () => changeItineraryWeek(itinerary, itnAddDays(itinerary.weekStart, -7))
  }, "\u2039"));
  weekNav.appendChild(el("div", { class: "itinerary-week-range" }, itnFormatWeekRangeSpaced(itinerary.weekStart)));
  weekNav.appendChild(el("button", {
    class: "btn btn-outline itinerary-week-arrow",
    onclick: () => changeItineraryWeek(itinerary, itnAddDays(itinerary.weekStart, 7))
  }, "\u203A"));
  weekCard.appendChild(weekNav);
  weekCard.appendChild(
    el("button", {
      class: "btn btn-outline",
      style: "width:100%;margin-top:10px;",
      onclick: () => openChooseWeekModal(itinerary)
    }, "Choose Week")
  );
  wrap.appendChild(weekCard);

  // ---- Day tabs ----
  const tabRow = el("div", { class: "itinerary-day-tabs" });
  ITINERARY_DAY_KEYS.forEach((dayKey) => {
    tabRow.appendChild(
      el("button", {
        class: "itinerary-day-tab" + (itineraryUiState.activeDay === dayKey ? " active" : ""),
        onclick: () => { itineraryUiState.activeDay = dayKey; renderItinerarySoft(itinerary); }
      }, itnFormatDayTabLabel(dayKey, itinerary.weekStart))
    );
  });
  wrap.appendChild(tabRow);

  // ---- Active day content ----
  wrap.appendChild(renderItineraryDayCard(itinerary, itineraryUiState.activeDay));

  // ---- Weekly summary ----
  wrap.appendChild(renderItineraryWeeklySummary(itinerary));

  // ---- Action bar ----
  wrap.appendChild(renderItineraryActionBar(itinerary));

  return wrap;
}

function renderItineraryDayCard(itinerary, dayKey) {
  const day = itinerary.days[dayKey];
  const card = el("div", { class: "card itinerary-card" });
  card.appendChild(el("h3", {}, ITINERARY_DAY_FULL_LABELS[dayKey] + " \u00b7 " + itnFormatDayTabLabel(dayKey, itinerary.weekStart)));

  // Work hours
  card.appendChild(el("h4", {}, "Work Hours"));
  const timeRow = el("div", { class: "itinerary-time-row" });
  timeRow.appendChild(el("label", { class: "itinerary-time-field" }, [
    "Start Time",
    el("input", {
      type: "time", value: day.startTime,
      // Live-updates only the small computed displays (hours/miles/
      // summary numbers) via direct text updates below - deliberately
      // does NOT re-render the whole editor on every keystroke, which
      // would rebuild this very input out from under the installer's
      // finger and kick focus/the keyboard out after every character.
      oninput: (e) => { day.startTime = e.target.value; scheduleItineraryAutosave(itinerary); refreshItineraryLiveDisplays(itinerary); }
    })
  ]));
  timeRow.appendChild(el("label", { class: "itinerary-time-field" }, [
    "Finish Time",
    el("input", {
      type: "time", value: day.finishTime,
      oninput: (e) => { day.finishTime = e.target.value; scheduleItineraryAutosave(itinerary); refreshItineraryLiveDisplays(itinerary); }
    })
  ]));
  card.appendChild(timeRow);

  card.appendChild(el("div", { id: "itinerary-hours-live" }, renderItineraryHoursNode(day)));

  // Jobs
  card.appendChild(el("h4", { style: "margin-top:18px;" }, "Jobs"));
  const jobsWrap = el("div", { class: "itinerary-jobs-wrap" });
  (day.jobs || []).forEach((job, idx) => {
    jobsWrap.appendChild(renderItineraryJobRow(itinerary, day, job, idx));
  });
  card.appendChild(jobsWrap);
  card.appendChild(
    el("button", {
      class: "btn btn-outline",
      style: "width:100%;margin-top:8px;",
      onclick: () => {
        day.jobs.push(blankItineraryJob());
        scheduleItineraryAutosave(itinerary);
        renderItinerarySoft(itinerary);
      }
    }, "+ Add Another Job")
  );

  // Mileage & Expenses
  card.appendChild(el("h4", { style: "margin-top:18px;" }, "Mileage & Expenses"));
  const mileGrid = el("div", { class: "itinerary-mileage-grid" });

  mileGrid.appendChild(el("label", { class: "itinerary-field" }, [
    "Starting Mileage",
    el("input", {
      type: "number", inputmode: "decimal", min: "0", value: day.startMileage,
      oninput: (e) => { day.startMileage = e.target.value; scheduleItineraryAutosave(itinerary); refreshItineraryLiveDisplays(itinerary); }
    })
  ]));
  mileGrid.appendChild(el("label", { class: "itinerary-field" }, [
    "Ending Mileage",
    el("input", {
      type: "number", inputmode: "decimal", min: "0", value: day.endMileage,
      oninput: (e) => { day.endMileage = e.target.value; scheduleItineraryAutosave(itinerary); refreshItineraryLiveDisplays(itinerary); }
    })
  ]));

  mileGrid.appendChild(el("div", { class: "itinerary-field-static", id: "itinerary-miles-live" }, renderItineraryMilesNode(day)));

  mileGrid.appendChild(el("label", { class: "itinerary-field" }, [
    "Tolls ($)",
    el("input", {
      type: "number", inputmode: "decimal", min: "0", step: "0.01", value: day.tolls,
      oninput: (e) => { day.tolls = e.target.value; scheduleItineraryAutosave(itinerary); refreshItineraryLiveDisplays(itinerary); }
    })
  ]));
  mileGrid.appendChild(el("label", { class: "itinerary-field" }, [
    "Parking / Fuel ($)",
    el("input", {
      type: "number", inputmode: "decimal", min: "0", step: "0.01", value: day.parkingFuel,
      oninput: (e) => { day.parkingFuel = e.target.value; scheduleItineraryAutosave(itinerary); refreshItineraryLiveDisplays(itinerary); }
    })
  ]));
  card.appendChild(mileGrid);

  return card;
}

function renderItineraryHoursNode(day) {
  const hoursResult = itnComputeDayHours(day);
  return hoursResult.error
    ? el("div", { class: "itinerary-error" }, hoursResult.error)
    : el("div", { class: "itinerary-hours-display" }, "Hours Worked: " + hoursResult.hours.toFixed(2));
}

function renderItineraryMilesNode(day) {
  const milesResult = itnComputeDayMiles(day);
  return milesResult.error
    ? el("div", { class: "itinerary-error" }, milesResult.error)
    : el("div", { class: "itinerary-hours-display" }, "Total Miles: " + milesResult.miles);
}

// Updates only the small computed-value displays (this day's Hours
// Worked / Total Miles, and every number in the Weekly Summary card)
// directly via their stable ids/data attributes - no DOM teardown, so
// typing in a time/mileage/tolls/parking field never loses focus or
// dismisses the on-screen keyboard mid-entry.
function refreshItineraryLiveDisplays(itinerary) {
  const day = itinerary.days[itineraryUiState.activeDay];

  const hoursLive = document.getElementById("itinerary-hours-live");
  if (hoursLive) {
    hoursLive.innerHTML = "";
    hoursLive.appendChild(renderItineraryHoursNode(day));
  }
  const milesLive = document.getElementById("itinerary-miles-live");
  if (milesLive) {
    milesLive.innerHTML = "";
    milesLive.appendChild(renderItineraryMilesNode(day));
  }

  const totals = computeItineraryTotals(itinerary);
  const summaryValues = {
    totalHours: totals.totalHours.toFixed(2),
    installs: String(totals.installs),
    measures: String(totals.measures),
    cutDownRetrofits: String(totals.cutDownRetrofits),
    serviceCalls: String(totals.serviceCalls),
    totalMiles: totals.totalMiles.toFixed(1),
    mileageReimbursement: "$" + totals.mileageReimbursement.toFixed(2),
    parkingFuel: "$" + totals.parkingFuel.toFixed(2),
    tolls: "$" + totals.tolls.toFixed(2),
    totalReimbursable: "$" + totals.totalReimbursable.toFixed(2)
  };
  Object.keys(summaryValues).forEach((key) => {
    const node = document.querySelector('[data-summary-key="' + key + '"]');
    if (node) node.textContent = summaryValues[key];
  });
}

function renderItineraryJobRow(itinerary, day, job, idx) {
  const row = el("div", { class: "itinerary-job-row" });
  row.appendChild(el("input", {
    type: "text", placeholder: "Customer", class: "itinerary-job-customer", value: job.customer,
    oninput: (e) => { job.customer = e.target.value; scheduleItineraryAutosave(itinerary); }
  }));
  const workSelect = el("select", {
    class: "itinerary-job-work",
    // Only the summary counts (Installs/Measures/etc) need to update
    // when this changes - no structural change to the row itself, so a
    // lightweight live refresh is enough (and, unlike the full
    // renderItinerarySoft() used for Add/Remove Job below, this select
    // element itself is untouched, so its own dropdown/focus is fine
    // either way - kept consistent with the other fields for the same
    // no-flicker reasoning).
    onchange: (e) => { job.workPerformed = e.target.value; scheduleItineraryAutosave(itinerary); refreshItineraryLiveDisplays(itinerary); }
  });
  workSelect.appendChild(el("option", { value: "" }, "Work Performed"));
  ITINERARY_WORK_PERFORMED_OPTIONS.forEach((opt) => {
    workSelect.appendChild(el("option", { value: opt, selected: job.workPerformed === opt ? "selected" : null }, opt));
  });
  row.appendChild(workSelect);
  row.appendChild(el("input", {
    type: "text", placeholder: "Product", class: "itinerary-job-product", value: job.product,
    oninput: (e) => { job.product = e.target.value; scheduleItineraryAutosave(itinerary); }
  }));
  row.appendChild(el("button", {
    class: "itinerary-job-remove",
    title: "Remove this job",
    onclick: () => {
      day.jobs.splice(idx, 1);
      scheduleItineraryAutosave(itinerary);
      renderItinerarySoft(itinerary);
    }
  }, "\u2715"));
  return row;
}

function renderItineraryWeeklySummary(itinerary) {
  const totals = computeItineraryTotals(itinerary);
  const card = el("div", { class: "card itinerary-card itinerary-summary" });
  card.appendChild(el("h3", {}, "Weekly Summary"));
  const rows = [
    ["totalHours", "Total Hours", totals.totalHours.toFixed(2)],
    ["installs", "Installs", totals.installs],
    ["measures", "Measures", totals.measures],
    ["cutDownRetrofits", "Cut-Downs / Retrofits", totals.cutDownRetrofits],
    ["serviceCalls", "Service Calls", totals.serviceCalls],
    ["totalMiles", "Total Miles", totals.totalMiles.toFixed(1)],
    ["mileageReimbursement", "Mileage Reimbursement (@ $0.30/mi)", "$" + totals.mileageReimbursement.toFixed(2)],
    ["parkingFuel", "Parking / Fuel", "$" + totals.parkingFuel.toFixed(2)],
    ["tolls", "Tolls", "$" + totals.tolls.toFixed(2)],
    ["totalReimbursable", "Total Reimbursable Expenses", "$" + totals.totalReimbursable.toFixed(2)]
  ];
  const grid = el("div", { class: "itinerary-summary-grid" });
  rows.forEach(([key, label, value]) => {
    grid.appendChild(el("div", { class: "itinerary-summary-row" }, [
      el("span", { class: "itinerary-summary-label" }, label),
      el("span", { class: "itinerary-summary-value", "data-summary-key": key }, String(value))
    ]));
  });
  card.appendChild(grid);
  return card;
}

// Re-renders just the editor content in place (used after a keystroke-
// level change like typing mileage, so the Weekly Summary and computed
// fields stay live without losing input focus on every keystroke the
// way a full render() would).
function renderItinerarySoft(itinerary) {
  const content = document.getElementById("content");
  if (!content) return;
  content.innerHTML = "";
  content.appendChild(renderItineraryEditor(itinerary));
}

// ---------------------------------------------------------------
// Choose Week modal
// ---------------------------------------------------------------

function openChooseWeekModal(itinerary) {
  const current = itnParseIsoDate(itinerary.weekStart);
  const state_ = { year: current.getFullYear(), month: current.getMonth() };

  const body = el("div", { class: "itinerary-choose-week" });

  function renderBody() {
    body.innerHTML = "";
    const nav = el("div", { class: "itinerary-week-nav" }, [
      el("button", { class: "btn btn-outline itinerary-week-arrow", onclick: () => { state_.month--; if (state_.month < 0) { state_.month = 11; state_.year--; } renderBody(); } }, "\u2039"),
      el("div", { class: "itinerary-week-range" }, new Date(state_.year, state_.month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })),
      el("button", { class: "btn btn-outline itinerary-week-arrow", onclick: () => { state_.month++; if (state_.month > 11) { state_.month = 0; state_.year++; } renderBody(); } }, "\u203A")
    ]);
    body.appendChild(nav);

    const list = el("div", { class: "itinerary-week-list" });
    itnWeeksInMonth(state_.year, state_.month).forEach((weekStartIso) => {
      list.appendChild(
        el("button", {
          class: "btn btn-outline itinerary-week-option",
          onclick: () => {
            closeModalNow();
            changeItineraryWeek(itinerary, weekStartIso);
          }
        }, itnFormatWeekRangeSpaced(weekStartIso))
      );
    });
    body.appendChild(list);
  }
  renderBody();

  let closeModalNow = () => {};
  const overlay = el("div", { class: "modal-overlay", onclick: (e) => { if (e.target === overlay) closeModalNow(); } });
  const modal = el("div", { class: "modal" });
  modal.appendChild(el("h3", {}, "Choose Week"));
  modal.appendChild(body);
  const btnRow = el("div", { class: "btn-row" });
  btnRow.appendChild(el("button", { class: "btn btn-outline", onclick: () => closeModalNow() }, "Close"));
  modal.appendChild(btnRow);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  closeModalNow = () => overlay.remove();
}

// ---------------------------------------------------------------
// Action bar / Preview PDF / Submit & Send
// ---------------------------------------------------------------

function renderItineraryActionBar(itinerary) {
  const bar = el("div", { class: "action-bar" });
  bar.appendChild(el("button", { class: "btn btn-outline", onclick: () => goTo({ type: "itineraryList" }) }, "\u2190 Back"));
  bar.appendChild(el("button", {
    class: "btn btn-outline",
    onclick: async () => { await persistItinerary(itinerary); toast("Weekly itinerary saved.", "success"); }
  }, "Save"));
  bar.appendChild(el("button", {
    class: "btn btn-outline",
    onclick: () => previewItineraryPdf(itinerary)
  }, "Preview PDF"));
  bar.appendChild(el("button", {
    class: "btn btn-primary",
    onclick: () => confirmSubmitItinerary(itinerary)
  }, "Submit & Send"));
  return bar;
}

async function previewItineraryPdf(itinerary) {
  try {
    const blob = buildItineraryPdfBlob(itinerary);
    await showPdfDocument(blob, { title: "Weekly Itinerary Preview" });
  } catch (err) {
    console.error(err);
    toast("Could not generate the PDF preview: " + err.message, "error");
  }
}

function itineraryPdfFileName(itinerary) {
  const name = (itineraryInstallerName(itinerary) || "Installer").replace(/[^a-z0-9]+/gi, "_");
  const week = itnFormatWeekRange(itinerary.weekStart).replace(/[^a-z0-9]+/gi, "_");
  return (name + "_Weekly_Itinerary_" + week).replace(/_+/g, "_").slice(0, 100) + ".pdf";
}

function itineraryEmailSubject(itinerary) {
  return itineraryInstallerName(itinerary) + " \u2013 Weekly Itinerary \u2013 " + itnFormatWeekRangeSpaced(itinerary.weekStart);
}

// Full submit-time validation across all six days - the inline
// per-field messages shown while editing are a convenience, but this is
// the actual gate: nothing with an unresolved Start/Finish or Mileage
// problem is allowed to silently contribute zero and still submit.
function validateItineraryForSubmit(itinerary) {
  const errors = [];
  ITINERARY_DAY_KEYS.forEach((dayKey) => {
    const day = itinerary.days[dayKey];
    const dayLabel = ITINERARY_DAY_FULL_LABELS[dayKey];

    const hasStart = !!day.startTime;
    const hasFinish = !!day.finishTime;
    if (hasStart !== hasFinish) {
      errors.push(dayLabel + ": enter both a Start Time and a Finish Time, or leave both blank.");
    } else if (hasStart && hasFinish) {
      const result = itnComputeDayHours(day);
      if (result.error) errors.push(dayLabel + ": " + result.error);
    }

    const hasStartMile = day.startMileage !== "" && day.startMileage !== null && day.startMileage !== undefined;
    const hasEndMile = day.endMileage !== "" && day.endMileage !== null && day.endMileage !== undefined;
    if (hasStartMile !== hasEndMile) {
      errors.push(dayLabel + ": enter both Starting Mileage and Ending Mileage, or leave both blank.");
    } else if (hasStartMile && hasEndMile) {
      const result = itnComputeDayMiles(day);
      if (result.error) errors.push(dayLabel + ": " + result.error);
    }
  });
  return errors;
}

function confirmSubmitItinerary(itinerary) {
  const name = itineraryInstallerName(itinerary);
  if (!name) {
    toast("Please select or enter an Installer name before submitting.", "error");
    return;
  }

  const errors = validateItineraryForSubmit(itinerary);
  if (errors.length) {
    toast("Please fix the following before submitting: " + errors.join(" "), "error");
    return;
  }

  openModal({
    title: "Submit this weekly itinerary?",
    body: "You're about to finalize \u201c" + itineraryDisplayName(itinerary) + "\u201d, generate the PDF, and send it to Matthew.",
    confirmLabel: "Submit & Send",
    confirmClass: "btn-primary",
    onConfirm: () => doSubmitItinerary(itinerary)
  });
}

async function doSubmitItinerary(itinerary) {
  await persistItinerary(itinerary, { silent: true });

  if (!navigator.onLine) {
    itinerary.status = "ready";
    await persistItinerary(itinerary, { silent: true });
    toast("No internet connection. Your itinerary is saved. Please submit when a connection is available.", "error");
    render();
    return;
  }

  if (!itinerary.submissionId) itinerary.submissionId = uid();

  try {
    const blob = buildItineraryPdfBlob(itinerary, { statusOverride: "SUBMITTED" });
    const filename = itineraryPdfFileName(itinerary);
    const subject = itineraryEmailSubject(itinerary);
    const base64Pdf = await blobToBase64(blob);
    const totals = computeItineraryTotals(itinerary);

    const payloadBody = JSON.stringify({
      action: "submitItinerary",
      installerToken: getDeviceToken(),
      submissionId: itinerary.submissionId,
      subject,
      filename,
      installerName: itineraryInstallerName(itinerary),
      weekStart: itinerary.weekStart,
      weekEnd: itnAddDays(itinerary.weekStart, 5),
      totalHours: totals.totalHours,
      installs: totals.installs,
      measures: totals.measures,
      cutDownRetrofits: totals.cutDownRetrofits,
      serviceCalls: totals.serviceCalls,
      totalMiles: totals.totalMiles,
      mileageReimbursement: totals.mileageReimbursement,
      parkingFuel: totals.parkingFuel,
      tolls: totals.tolls,
      totalReimbursable: totals.totalReimbursable,
      pdfBase64: base64Pdf
    });

    const resp = await fetch(MWT_CONFIG.submitApiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: payloadBody
    });

    let payload = null;
    try { payload = await resp.json(); } catch (parseErr) { /* handled below */ }

    if (resp.ok && payload && payload.success) {
      itinerary.status = "submitted";
      itinerary.submittedAt = nowStamp();
      itinerary.revision = (itinerary.revision || 0) + 1;
      await persistItinerary(itinerary, { silent: true });
      toast("Submitted successfully.", "success");
      render();
    } else {
      const errMsg = (payload && payload.error) ? payload.error : ("Server returned status " + resp.status);
      console.error("Weekly Itinerary submit failed:", errMsg);
      toast("Submission could not be emailed. Your itinerary is still saved. Please try again.", "error");
    }
  } catch (err) {
    console.error("Weekly Itinerary submit failed:", err);
    toast("Submission could not be emailed. Your itinerary is still saved. Please try again.", "error");
  }
}

// ---------------------------------------------------------------
// Administrator: "Weekly Itineraries" tab content, called from
// app.js's renderAdminDashboard() (a small tab bar added there calls
// this instead of the existing submitted-jobs list when selected - the
// existing Submitted Jobs code path is untouched).
// ---------------------------------------------------------------

const itineraryAdminState = { page: 1, pageSize: 25, installerName: "", weekFrom: "", weekTo: "", rows: [], total: 0 };

async function renderItineraryAdminSection(resultsBox, filterBar) {
  filterBar.innerHTML = "";
  const nameInput = el("input", { type: "text", placeholder: "Installer Name", value: itineraryAdminState.installerName });
  const weekFromInput = el("input", { type: "date", value: itineraryAdminState.weekFrom, title: "Week starting on/after" });
  const weekToInput = el("input", { type: "date", value: itineraryAdminState.weekTo, title: "Week starting on/before" });
  const searchBtn = el("button", { class: "btn btn-navy" }, "Search");
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  function doSearch() {
    itineraryAdminState.installerName = nameInput.value.trim();
    itineraryAdminState.weekFrom = weekFromInput.value;
    itineraryAdminState.weekTo = weekToInput.value;
    itineraryAdminState.page = 1;
    loadAndRender();
  }
  searchBtn.addEventListener("click", doSearch);
  weekFromInput.addEventListener("change", doSearch);
  weekToInput.addEventListener("change", doSearch);
  filterBar.appendChild(nameInput);
  filterBar.appendChild(el("label", { class: "itinerary-admin-date-label" }, ["From week", weekFromInput]));
  filterBar.appendChild(el("label", { class: "itinerary-admin-date-label" }, ["To week", weekToInput]));
  filterBar.appendChild(searchBtn);

  async function loadAndRender() {
    resultsBox.innerHTML = "";
    if (!navigator.onLine) {
      resultsBox.appendChild(el("div", { class: "needs-review-banner" }, "No internet connection. Weekly Itineraries requires an internet connection to load - please reconnect and search again."));
      return;
    }
    resultsBox.appendChild(el("div", { class: "help-text" }, "Loading\u2026"));
    try {
      const resp = await fetch(MWT_CONFIG.submitApiUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "listItineraries",
          adminToken: getAdminToken(),
          page: itineraryAdminState.page,
          pageSize: itineraryAdminState.pageSize,
          installerName: itineraryAdminState.installerName,
          weekFrom: itineraryAdminState.weekFrom,
          weekTo: itineraryAdminState.weekTo
        })
      });
      let payload = null;
      try { payload = await resp.json(); } catch (e) { /* handled below */ }
      resultsBox.innerHTML = "";
      if (!resp.ok || !payload || !payload.success) {
        resultsBox.appendChild(el("div", { class: "needs-review-banner" }, (payload && payload.error) ? payload.error : "Could not load weekly itineraries."));
        return;
      }
      itineraryAdminState.rows = payload.rows || [];
      itineraryAdminState.total = payload.total || 0;
      renderTable();
    } catch (err) {
      resultsBox.innerHTML = "";
      resultsBox.appendChild(el("div", { class: "needs-review-banner" }, "Could not reach the server. Check your connection and try again."));
    }
  }

  function renderTable() {
    resultsBox.innerHTML = "";
    if (!itineraryAdminState.rows.length) {
      resultsBox.appendChild(el("div", { class: "empty-state" }, [
        el("div", { class: "big" }, "\uD83D\uDDD3\uFE0F"),
        el("div", {}, "No weekly itineraries match this search.")
      ]));
      return;
    }
    const table = el("table", { class: "job-table" });
    table.appendChild(el("thead", {}, el("tr", {}, [
      el("th", {}, "Submitted"), el("th", {}, "Installer"), el("th", {}, "Week"),
      el("th", {}, "Total Hours"), el("th", {}, "Total Reimbursable"), el("th", {}, "")
    ])));
    const tbody = el("tbody", {});
    itineraryAdminState.rows.forEach((r) => {
      tbody.appendChild(el("tr", {}, [
        el("td", {}, fmtTime(r.timestamp)),
        el("td", {}, r.installerName || "\u2014"),
        el("td", {}, (r.weekStart && r.weekEnd) ? itnFormatWeekRange(r.weekStart) : "\u2014"),
        el("td", {}, r.totalHours != null ? Number(r.totalHours).toFixed(2) : "\u2014"),
        el("td", {}, r.totalReimbursable != null ? "$" + Number(r.totalReimbursable).toFixed(2) : "\u2014"),
        el("td", {}, el("button", { class: "btn btn-ghost", onclick: () => viewItineraryPdf(r) }, "View PDF"))
      ]));
    });
    table.appendChild(tbody);
    resultsBox.appendChild(el("div", { class: "card", style: "overflow-x:auto;" }, table));

    const totalPages = Math.max(1, Math.ceil(itineraryAdminState.total / itineraryAdminState.pageSize));
    resultsBox.appendChild(el("div", { class: "btn-row", style: "margin-top:12px;" }, [
      el("button", { class: "btn btn-outline", disabled: itineraryAdminState.page <= 1 ? "disabled" : null, onclick: () => { itineraryAdminState.page--; loadAndRender(); } }, "\u2190 Prev"),
      el("div", { class: "help-text", style: "align-self:center;" }, "Page " + itineraryAdminState.page + " of " + totalPages + " (" + itineraryAdminState.total + " total)"),
      el("button", { class: "btn btn-outline", disabled: itineraryAdminState.page >= totalPages ? "disabled" : null, onclick: () => { itineraryAdminState.page++; loadAndRender(); } }, "Next \u2192")
    ]));
  }

  async function viewItineraryPdf(row) {
    if (!navigator.onLine) { toast("No internet connection. Connect to view the PDF.", "error"); return; }
    toast("Loading PDF\u2026");
    try {
      const resp = await fetch(MWT_CONFIG.submitApiUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "getItineraryPdf", adminToken: getAdminToken(), submissionId: row.submissionId })
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
      await showPdfDocument(blob, { title: "Weekly Itinerary \u2014 " + (row.installerName || "") });
    } catch (err) {
      toast("Could not reach the server. Check your connection and try again.", "error");
    }
  }

  await loadAndRender();
}
