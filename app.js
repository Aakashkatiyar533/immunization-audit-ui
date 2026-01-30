/*************************************************
 * IMMUNIZATION DATA QUALITY DASHBOARD (Plain JS)
 * ------------------------------------------------
 * What this file does:
 * 1) Loads immunization_data.json
 * 2) Initializes date pickers (Flatpickr) + quick range
 * 3) Runs a “report” (filters by date + missing element)
 * 4) Renders:
 *    - Table (plain HTML table)
 *    - AI explainable summary
 *    - Trend visualizations (ECharts)
 * 5) Opens a provider-facing “Record Guidance” modal on Patient click
 * 6) Tracks “Reviewed” per Doc ID in localStorage + timestamp
 * 7) Shows confirmation toasts
 *
 * Notes:
 * - Row highlight is automatic by risk category (high / medium / low)
 * - “Highlight by” feature is intentionally removed/disabled
 * - Race/Ethnicity are included in:
 *    - CSV export
 *    - Record Guidance panel
 *   (Table headers in your current HTML do not include Race/Ethnicity,
 *    so we do NOT render extra table columns here to avoid header mismatch.)
 *************************************************/

/* =========================
   Globals
========================= */
let allRecords = [];
let filteredRecords = [];
let displayRecords = []; // what the table is currently showing (after toggles)
let fromPicker = null;
let toPicker = null;
let lastVisibleCount = 0;
let countAnimFrame = null;
let isInitialLoad = true;
let isStartupComplete = false;
let activeSeverityFilter = null; // "high" | "medium" | "low" | "clean" | null
let suppressQuickRangeReset = false;
let isRefreshRestart = false;
let CURRENT_OPEN_DOC_ID = null;
let lotColorMap = {};

/* =========================
   Guidance + Scoring
========================= */
const HAS_SEEN_START_SCREEN = "hasSeenStartScreen";
const FIELD_GUIDANCE = {
  ndc: {
    label: "NDC",
    severity: "Medium",
    impact:
      "Product identification can fail for registry acceptance and inventory reconciliation.",
    fix: "Select the correct NDC from your vaccine master or barcode scan, aligned to the administered product.",
  },
  lot_number: {
    label: "Lot Number",
    severity: "High",
    impact:
      "Lot decrement and inventory reconciliation at the registry can fail, increasing audit risk.",
    fix: "Enter the lot from vial/carton. If unavailable, confirm via inventory log for that administration date.",
  },
  expiration_date: {
    label: "Exp Date",
    severity: "High",
    impact:
      "Missing or invalid expiration can trigger registry validation errors.",
    fix: "Enter expiration from vial/carton. Ensure expiration is after the administration date.",
  },
  vfc_status: {
    label: "VFC Eligibility",
    severity: "High",
    impact:
      "VFC accountability and public program reporting can be incomplete.",
    fix: "Confirm eligibility at time of administration and record the correct VFC code.",
  },
  funding_source: {
    label: "Funding Source",
    severity: "High",
    impact:
      "Funding attribution impacts reporting, reimbursements, and public program compliance.",
    fix: "Select the funding source aligned to eligibility and clinic program configuration.",
  },
  race: {
    label: "Race",
    severity: "Medium",
    impact:
      "Missing race can reduce registry data completeness and downstream reporting accuracy.",
    fix: "Update patient demographics in the EHR. If patient declines, record the appropriate refusal/unknown option per your workflow.",
  },
  ethnicity: {
    label: "Ethnicity",
    severity: "Medium",
    impact:
      "Missing ethnicity can reduce registry data completeness and downstream reporting accuracy.",
    fix: "Update patient demographics in the EHR. If patient declines, record the appropriate refusal/unknown option per your workflow.",
  },

  mobile: {
    label: "Mobile",
    severity: "Low",
    impact: "Patient reminders and series completion outreach are impacted.",
    fix: "Verify phone during check-in or via patient portal.",
  },
  email: {
    label: "Email",
    severity: "Low",
    impact: "Electronic reminders and follow-up may not reach the patient.",
    fix: "Verify email during check-in or via patient portal.",
  },
};
const trendCache = {
  bar: new Map(), // key = dateRangeKey
};
const echartsRegistry = {
  bar: null,
  treemap: null,
  heatmap: null,
};
// =========================
// ECharts lifecycle registry
// =========================
const echartInstances = {};
const TREND_VIEW_EXPLANATIONS = {
  bar: {
    title: "Missing documentation trends",
    text: `
      Stacked bars show how documentation gaps change over time.
      Each segment represents a missing field category.
    `,
  },

  treemap: {
    title: "Documentation gap concentration",
    text: `
      This view highlights which missing fields contribute most
      to documentation risk in the selected period.
    `,
  },

  lot_table: {
    title: "Weekly vaccine lot usage",
    text: `
      Rows show vaccine lot numbers and columns represent weeks.
      Isolated or one-time entries may indicate data entry errors.
    `,
  },
};

function getOrCreateChart(domId) {
  const el = document.getElementById(domId);
  if (!el) return null;

  if (echartInstances[domId]) {
    return echartInstances[domId];
  }

  const chart = echarts.init(el);
  echartInstances[domId] = chart;
  return chart;
}

function disposeChart(domId) {
  if (echartInstances[domId]) {
    echartInstances[domId].dispose();
    delete echartInstances[domId];
  }
}

/*************************************************
 * SEVERITY RULES (Feature 1)
 *************************************************/

const SEVERITY = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
};

const READINESS_WEIGHTS = [
  { field: "lot_number", weight: 25 },
  { field: "ndc", weight: 25 },
  { field: "expiration_date", weight: 10 },
  { field: "vfc_status", weight: 15 },
  { field: "funding_source", weight: 15 },
  { field: "mobile", weight: 5 },
  { field: "email", weight: 5 },
];

function computeReadiness(r) {
  let score = 100;

  for (const w of READINESS_WEIGHTS) {
    const val = r[w.field];
    if (!val) score -= w.weight;
  }

  // Basic date sanity check
  if (r.administered_date && r.expiration_date) {
    if (String(r.expiration_date) < String(r.administered_date)) {
      score = Math.max(0, score - 15);
    }
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Row category highlight:
 * - High: missing VFC or Funding (priority compliance/registry)
 * - Medium: missing Lot or NDC (inventory + reconciliation)
 * - Low: missing contact details (outreach)
 */
function isEmpty(val) {
  return val === undefined || val === null || String(val).trim() === "";
}

/**
 * Row category highlight aligned to your JSON contract:
 * - High: missing required vaccine/order fields (must not be empty)
 * - Medium: missing VFC/funding OR missing race/ethnicity (your requirement)
 * - Low: missing contact details (mobile/email)
 */
function riskClassFromRecord(r) {
  // HIGH: required for a usable immunization order record
  const highMissing =
    isEmpty(r.vaccine_name) ||
    isEmpty(r.quantity) ||
    isEmpty(r.units) ||
    isEmpty(r.ndc) ||
    isEmpty(r.lot_number) ||
    isEmpty(r.expiration_date);

  if (highMissing) return "high";

  // MEDIUM: allowed to be empty, but operationally important
  const mediumMissing =
    isEmpty(r.vfc_status) ||
    isEmpty(r.funding_source) ||
    isEmpty(r.race) ||
    isEmpty(r.ethnicity);

  if (mediumMissing) return "medium";

  // LOW: optional outreach fields
  const lowMissing = isEmpty(r.mobile) || isEmpty(r.email);
  if (lowMissing) return "low";

  return "";
}

/* =========================
   Reviewed (Resolved) tracking
========================= */
function reviewedKey(docId) {
  return `resolved:${docId}`;
}
function reviewedTsKey(docId) {
  return `resolved:${docId}:ts`;
}
function isReviewed(docId) {
  return localStorage.getItem(reviewedKey(docId)) === "1";
}
function setReviewed(docId, val) {
  localStorage.setItem(reviewedKey(docId), val ? "1" : "0");
  if (val) {
    localStorage.setItem(reviewedTsKey(docId), new Date().toISOString());
  } else {
    localStorage.removeItem(reviewedTsKey(docId));
  }
}
function getReviewedTimestamp(docId) {
  return localStorage.getItem(reviewedTsKey(docId));
}

/* =========================
   DOM helpers
========================= */

function $(sel) {
  return document.querySelector(sel);
}
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function openStartScreenModal() {
  const modal = document.getElementById("startScreenModal");
  if (!modal) {
    console.warn("[StartScreen] modal not found");
    return;
  }

  console.log("[StartScreen] opening modal");

  // Ensure it can render even if CSS or inline HTML has display:none
  modal.style.display = "flex";
  console.log(
    "[StartScreen] computed display =",
    getComputedStyle(modal).display
  );

  // Visual state
  modal.classList.remove("isClosing");
  modal.classList.add("isOpen");
  modal.setAttribute("aria-hidden", "false");

  // Backdrop blur state
  document.body.classList.add("startScreenActive");

  // Focus a safe control inside the modal (prevents ARIA focus warnings later)
  const focusTarget = modal.querySelector(
    "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
  );
  if (focusTarget) focusTarget.focus();
  initStartScreenCarousel();
}
function initStartScreenCarousel() {
  const modal = document.getElementById("startScreenModal");
  if (!modal) return;

  if (modal.dataset.carouselInit === "true") return;
  modal.dataset.carouselInit = "true";

  const slides = Array.from(modal.querySelectorAll(".startSlide"));
  const dotsWrap = modal.querySelector("#startDots");
  const prevBtn = modal.querySelector("#startPrevBtn");
  const nextBtn = modal.querySelector("#startNextBtn");
  const primary = modal.querySelector("#startBeginBtn");
  const pills = Array.from(modal.querySelectorAll(".startPill"));

  if (!slides.length || !dotsWrap) return;

  let idx = 0;
  let timer = null;
  const AUTO_MS = 5500;

  dotsWrap.innerHTML = slides
    .map(
      (_, i) =>
        `<span class="startDot" data-idx="${i}" aria-label="Slide ${
          i + 1
        }"></span>`
    )
    .join("");

  const dots = Array.from(dotsWrap.querySelectorAll(".startDot"));

  function setPills(activeIdx) {
    if (!pills.length) return;
    pills.forEach((p, i) => p.classList.toggle("isActive", i === activeIdx));
  }

  function applyNavState() {
    if (prevBtn) prevBtn.disabled = false; // looping, so never disabled
    if (nextBtn)
      nextBtn.textContent = idx === slides.length - 1 ? "Finish" : "Next";
  }

  function animateTo(nextIdx, direction) {
    if (slides.length <= 1) return;

    const current = slides[idx];
    const next = slides[nextIdx];

    // Clear transient classes
    slides.forEach((s) =>
      s.classList.remove(
        "leaveToLeft",
        "leaveToRight",
        "enterFromLeft",
        "enterFromRight"
      )
    );

    // Prepare next slide entry position
    next.classList.add(
      direction === "right" ? "enterFromRight" : "enterFromLeft"
    );
    next.classList.add("isActive");

    // Force style flush so the browser applies the start position before transitioning
    // eslint-disable-next-line no-unused-expressions
    next.offsetHeight;

    // Animate current out
    current.classList.add(
      direction === "right" ? "leaveToLeft" : "leaveToRight"
    );

    // Animate next in
    requestAnimationFrame(() => {
      next.classList.remove("enterFromRight", "enterFromLeft");
    });

    // Finalize after transition
    window.setTimeout(() => {
      current.classList.remove("isActive", "leaveToLeft", "leaveToRight");
      idx = nextIdx;

      dots.forEach((d, k) => d.classList.toggle("isActive", k === idx));
      setPills(idx);
      applyNavState();
    }, 270);
  }

  function show(nextIndex, direction) {
    const normalized = (nextIndex + slides.length) % slides.length;
    if (normalized === idx) return;

    animateTo(normalized, direction);
  }

  function startAuto() {
    stopAuto();
    timer = window.setInterval(() => {
      show(idx + 1, "right");
    }, AUTO_MS);
  }

  function stopAuto() {
    if (timer) window.clearInterval(timer);
    timer = null;
  }

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      show(idx - 1, "left");
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      show(idx + 1, "right");
    });
  }

  dotsWrap.addEventListener("click", (e) => {
    const dot = e.target.closest(".startDot");
    if (!dot) return;
    const n = Number(dot.getAttribute("data-idx"));
    if (!Number.isFinite(n)) return;
    show(n, n > idx ? "right" : "left");
  });

  // Pause auto-advance on hover/focus inside the card
  const card = modal.querySelector(".startScreenCard");
  if (card) {
    card.addEventListener("mouseenter", stopAuto);
    card.addEventListener("mouseleave", startAuto);
    card.addEventListener("focusin", stopAuto);
    card.addEventListener("focusout", startAuto);
  }

  // Ensure modal only closes via Start button (no overlay click close)
  modal.addEventListener("click", (e) => {
    const clickedOverlay = e.target === modal;
    if (clickedOverlay) {
      e.stopPropagation();
      e.preventDefault();
    }
  });

  // Initialize state
  slides.forEach((s, k) => s.classList.toggle("isActive", k === 0));
  dots.forEach((d, k) => d.classList.toggle("isActive", k === 0));
  setPills(0);
  applyNavState();

  // Start auto
  startAuto();

  // If Start Review is clicked, stop timers
  if (primary) {
    primary.addEventListener("click", () => {
      stopAuto();
    });
  }
}

function closeStartScreenModal() {
  const modal = document.getElementById("startScreenModal");
  if (!modal) return;

  console.log("[StartScreen] CLOSE");

  // Mark as seen on any dismissal (X, continue, lets go, etc.)
  try {
    localStorage.setItem(HAS_SEEN_START_SCREEN, "true");
  } catch (e) {
    // ignore storage errors
  }

  // Move focus OUT before hiding
  const safeFocusTarget =
    document.getElementById("refreshBtn") ||
    document.getElementById("helpLink") ||
    document.querySelector("button, a, input, select");

  if (safeFocusTarget) safeFocusTarget.focus();

  // Animate out
  modal.classList.remove("isOpen");
  modal.classList.add("isClosing");

  // Remove blur class now (so background becomes usable)
  document.body.classList.remove("startScreenActive");

  // After animation finishes, hide completely
  setTimeout(() => {
    modal.setAttribute("aria-hidden", "true");
    modal.style.display = "none";
    modal.classList.remove("isClosing");
  }, 250);
}

function hashStringToInt(str) {
  // Simple deterministic hash
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededPick(list, seedInt) {
  if (!list || !list.length) return "";
  const idx = seedInt % list.length;
  return list[idx];
}
// Add this helper once (if you do not already have it)
function seededBool(seedInt, bit) {
  return ((seedInt >>> bit) & 1) === 1;
}

function pluralWord(n, one, many) {
  return n === 1 ? one : many;
}

function formatRange(from, to) {
  if (from && to) return `${from} to ${to}`;
  if (from) return `from ${from}`;
  if (to) return `up to ${to}`;
  return "";
}

function isChild(age) {
  return age !== null && age !== undefined && Number(age) < 19;
}

function isVfcEligible(vfcStatus) {
  return vfcStatus && vfcStatus.startsWith("V0") && vfcStatus !== "V01";
}

function isPublicFunding(funding) {
  return ["VXC50", "VXC51", "VXC52"].includes(funding);
}

function wireRealtimeFilters() {
  // Filter by missing MUST restart pipeline
  const missingFilter = document.getElementById("filterMissing");
  if (missingFilter) {
    missingFilter.addEventListener("change", () => {
      applyDateFilters();
    });
  }

  // Hide Reviewed is view-only
  const reviewedToggle = document.getElementById("toggleCompletedRows");
  if (reviewedToggle) {
    reviewedToggle.addEventListener("change", () => {
      applyAllFiltersRealtime();
    });
  }
  const ageFilter = document.getElementById("filterAge");
  if (ageFilter) {
    ageFilter.addEventListener("change", () => {
      applyAllFiltersRealtime();
    });
  }

  // Date-driven filters
  ["fromDate", "toDate", "quickRange"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("change", () => {
        applyDateFilters();
      });
    }
  });
}
function wireViewOptionsDropdown() {
  const dropdown = document.querySelector(".viewDropdown");
  const toggle = document.querySelector(".viewToggle");

  if (!dropdown || !toggle) return;

  toggle.addEventListener("click", () => {
    const open = dropdown.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open);

    const menu = dropdown.querySelector(".viewMenu");
    if (menu) {
      if (open) {
        menu.removeAttribute("inert");
      } else {
        menu.setAttribute("inert", "");
      }
    }
  });

  // Close when clicking outside
  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");

      const menu = dropdown.querySelector(".viewMenu");
      if (menu) {
        menu.setAttribute("inert", "");
      }
    }
  });
}
function applyRelativeDateRange(daysBackStart, daysBackEnd = 0, quickValue) {
  const today = clampToToday(new Date());

  const start = new Date(today);
  start.setDate(today.getDate() - daysBackStart);

  const end = new Date(today);
  end.setDate(today.getDate() - daysBackEnd);

  suppressQuickRangeReset = true;

  if (fromPicker) fromPicker.setDate(start, true);
  if (toPicker) toPicker.setDate(end, true);

  const quickRange = document.getElementById("quickRange");
  if (quickRange && quickValue) {
    quickRange.value = quickValue;
  }

  setTimeout(() => {
    suppressQuickRangeReset = false;
  }, 0);
}

function applyLast7DaysRange() {
  applyRelativeDateRange(6, 0, "last7");
}
function applyTodayRange() {
  applyRelativeDateRange(0, 0, "today");
}

function applyYesterdayRange() {
  applyRelativeDateRange(1, 1, "yesterday");
}

function applyLast14DaysRange() {
  applyRelativeDateRange(13, 0, "last14");
}

function applyLast30DaysRange() {
  applyRelativeDateRange(29, 0, "last30");
}

function applyRelativeDateRange(daysBackStart, daysBackEnd = 0, quickValue) {
  const today = clampToToday(new Date());

  const start = new Date(today);
  start.setDate(today.getDate() - daysBackStart);

  const end = new Date(today);
  end.setDate(today.getDate() - daysBackEnd);

  suppressQuickRangeReset = true;

  if (fromPicker) fromPicker.setDate(start, true);
  if (toPicker) toPicker.setDate(end, true);

  const quickRange = document.getElementById("quickRange");
  if (quickRange && quickValue) {
    quickRange.value = quickValue;
  }

  setTimeout(() => {
    suppressQuickRangeReset = false;
  }, 0);
}

function forceSelectValue(selectEl, value) {
  if (!selectEl) return;

  Array.from(selectEl.options).forEach((opt) => {
    opt.selected = opt.value === value;
  });

  // Force repaint
  selectEl.blur();
  selectEl.focus();
}

/* =========================
   Welcome Modal: close + focus trap
========================= */
// Bug fix: removed duplicate openWelcomeModal() definition. The implementation below is the single source of truth.

function isWelcomeModalOpen() {
  const modal = document.getElementById("welcomeModal");
  return !!(modal && modal.style.display !== "none");
}

function openWelcomeModal() {
  const modal = document.getElementById("welcomeModal");
  if (!modal) return;

  modal.style.display = "flex";

  requestAnimationFrame(() => {
    modal.classList.remove("isClosing");
    modal.classList.add("isOpen");
    modal.setAttribute("aria-hidden", "false");
  });

  focusWelcomeModal();
}

function closeWelcomeModal() {
  const modal = document.getElementById("welcomeModal");
  if (!modal) return;

  modal.classList.remove("isOpen");
  modal.classList.add("isClosing");

  setTimeout(() => {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    modal.classList.remove("isClosing");
    releaseWelcomeModalFocusTrap();
  }, 250);
}

let welcomeTrapHandler = null;

function releaseWelcomeModalFocusTrap() {
  // Bug fix: ensure focus trap listener is always removed when the modal closes.
  // This prevents keyboard navigation from remaining trapped after the modal is dismissed.
  if (!welcomeTrapHandler) return;
  document.removeEventListener("keydown", welcomeTrapHandler, true);
  welcomeTrapHandler = null;
}

function focusWelcomeModal() {
  const modal = document.getElementById("welcomeModal");
  if (!modal) return;

  // Ensure modal is focusable
  modal.setAttribute("tabindex", "-1");
  modal.focus();

  // Trap focus inside the modal
  const focusable = modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  function onKeyDown(e) {
    // Enter or Escape closes the modal
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeWelcomeModal();
      document.removeEventListener("keydown", onKeyDown, true);
      return;
    }

    // Tab trap
    if (e.key === "Tab" && focusable.length) {
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  welcomeTrapHandler = onKeyDown;
  document.addEventListener("keydown", welcomeTrapHandler, true);
}

function dismissWelcomeModalOnRun() {}

/* Close button in modal */
(function wireWelcomeModalClose() {
  document.addEventListener("click", function (e) {
    if (e.target && e.target.id === "closeModalBtn") {
      closeWelcomeModal();
    }
  });
})();
function isCompleteRecord(r) {
  // Define "complete" using the same fields you score for readiness
  for (const w of READINESS_WEIGHTS) {
    if (!r[w.field]) return false;
  }
  return true;
}

function applyCompletedRowsToggle() {
  let rows = displayRecords.slice();

  const hideReviewed = document.getElementById("toggleCompletedRows")?.checked;

  if (hideReviewed) {
    rows = rows.filter((r) => !isReviewed(r.doc_id));
  }

  displayRecords = rows;
  renderTable(displayRecords);
  updateSeverityStrip();
  updateCounts();
}

/* =========================
   Disable “Highlight by” feature (removed)
========================= */
function disableHighlightByUI() {
  const el = document.getElementById("highlightMode");
  if (!el) return;
  el.value = "none";
  el.disabled = true;
  el.title =
    "Highlight-by mode is disabled. Rows are automatically highlighted by risk category.";
}

function applyAllFiltersRealtime() {
  console.log("[applyAllFiltersRealtime] started");

  showUpdatingLoader(); // Show the loader while applying filters

  let rows = filteredRecords.slice(); // Start with filteredRecords

  // Missing documentation filter
  const missing = document.getElementById("filterMissing")?.value || "all";
  if (missing !== "all") {
    rows = rows.filter((r) => {
      if (missing === "incomplete") return getSeverity(r) !== "clean";
      if (missing === "complete") return getSeverity(r) === "clean";
      if (missing === "vfc") return !r.vfc_status;
      if (missing === "funding") return !r.funding_source;
      if (missing === "race") return !r.race;
      if (missing === "ethnicity") return !r.ethnicity;
      if (missing === "contact") return !r.email || !r.mobile;
      return true;
    });

    if (activeSeverityFilter) {
      rows = rows.filter((r) => getSeverity(r) === activeSeverityFilter);
    }
  }

  // Age filter
  const ageValue = document.getElementById("filterAge")?.value || "all";
  if (ageValue !== "all") {
    rows = rows.filter((r) => {
      const age = Number(r.age) || 0;
      if (ageValue === "above18") return age > 18;
      if (ageValue === "belowEqual18") return age <= 18;
      return true;
    });
  }

  // Apply completed toggle, render table, AI, etc.
  displayRecords = rows;

  applyCompletedRowsToggle(); // Hide reviewed rows if toggle active
  autoRunAI(); // Trigger AI summary

  if (displayRecords.length === 0) {
    showNoDataNotification();
  } else {
    hideNoDataNotification();
    renderTable(displayRecords);
    updateSeverityStrip();
    updateCounts();
  }
}

function showNoDataNotification() {
  console.log(
    "[showNoDataNotification] No data found for the applied filters."
  );

  // Show the "No data found" notification
  const notification = document.getElementById("noDataNotification");
  notification.style.display = "block";

  // Listen for the OK button click to reset filters
  const resetButton = document.getElementById("resetFiltersBtn");
  resetButton.addEventListener("click", function () {
    console.log("[OK Button] Clicked, resetting filters...");

    // Reset filters and reload data
    resetAllFiltersAndRefresh();

    // Hide the notification after reset
    notification.style.display = "none";
  });
}

function hideNoDataNotification() {
  const notification = document.getElementById("noDataNotification");
  notification.style.display = "none"; // Hide the notification
}

function resetAllFiltersAndRefresh() {
  console.log("[resetAllFiltersAndRefresh] started");

  // Show loader while resetting
  showLoader("Resetting view. Preparing immunization documentation review…");

  // Apply default filters
  applyLast7DaysRange(); // Reset date range to "Last 7 days"

  const missingFilter = document.getElementById("filterMissing");
  if (missingFilter) {
    missingFilter.value = "all"; // Reset the missing filter to "all"
  }

  // Reset the toggle states (e.g., demographics, completed rows)
  const hideDemographics = document.getElementById("toggleDemographics");
  if (hideDemographics) {
    hideDemographics.checked = false; // Reset the checkbox if present
  }

  // After filters are reset, load the data again
  loadDataWithFilters();

  // Hide the loader after 500ms to ensure smooth UX
  setTimeout(() => {
    hideLoader();
  }, 500); // Briefly show loader for UX consistency
}
function loadDataWithFilters() {
  console.log("[loadDataWithFilters] started");

  // Fetch data based on the reset filters
  applyAllFiltersRealtime();

  // Reset modal visibility after applying filters
  hideNoDataNotification();

  // Fetch and render data (this should be your fetch logic)
  fetchDataAndRender();
}

function fetchDataAndRender() {
  // Placeholder for fetching data logic, use an API or mock data
  console.log("[fetchDataAndRender] Fetching data...");

  // After data is fetched, render the table and update other UI elements
  renderTable(displayRecords);
  updateSeverityStrip();
  updateCounts();
}

let realtimeLoaderTimer = null;

function showUpdatingLoader() {
  if (!isStartupComplete) return;

  showLoader("Refreshing…");

  if (realtimeLoaderTimer) {
    clearTimeout(realtimeLoaderTimer);
  }

  realtimeLoaderTimer = setTimeout(() => {
    hideLoader();
    realtimeLoaderTimer = null;
  }, 500); // informational only
}

function applyDateFilters() {
  const quickRange = document.getElementById("quickRange");
  showUpdatingLoader();

  const from = document.getElementById("fromDate")?.value || "";
  const to = document.getElementById("toDate")?.value || "";

  if (!from || !to) {
    filteredRecords = [];
    displayRecords = [];
    renderTable([]);
    updateCounts();
    showAIPlaceholder();
    return;
  }

  filteredRecords = allRecords.filter(
    (r) => r.administered_date >= from && r.administered_date <= to
  );

  applyAllFiltersRealtime();
  autoRunAI();
  // 🔹 Ensure Quick Range reflects Last 7 Days when applicable
  (function syncQuickRangeLabel() {
    const quickRange = document.getElementById("quickRange");
    const fromInput = document.getElementById("fromDate");
    const toInput = document.getElementById("toDate");

    if (!quickRange || !fromInput || !toInput) return;

    const from = fromInput.value;
    const to = toInput.value;

    if (!from || !to) return;

    const today = clampToToday(new Date());
    const start = new Date(today);
    start.setDate(today.getDate() - 6);

    const format = (d) => d.toISOString().slice(0, 10);

    if (from === format(start) && to === format(today)) {
      forceSelectValue(quickRange, "last7");
    }
  })();
}
function getSeverity(record) {
  // HIGH: compliance critical
  if (!record.vfc_status || !record.funding_source) {
    return "high";
  }

  // MEDIUM: demographics
  if (!record.race || !record.ethnicity) {
    return "medium";
  }

  // LOW: contact
  if (!record.mobile || !record.email) {
    return "low";
  }

  return "clean";
}

function updateSeverityStrip() {
  const strip = document.getElementById("severityStrip");
  if (!strip) return;

  // Guard: no records
  if (!Array.isArray(displayRecords) || displayRecords.length === 0) {
    strip.classList.add("empty");

    // IMPORTANT: do not override CSS with inline flex-grow
    ["high", "medium", "low", "clean"].forEach((k) => {
      const seg = strip.querySelector(`.severity-segment.${k}`);
      if (seg) seg.style.removeProperty("flex-grow");
    });

    // Also reset counts to 0 if you want a clean empty state
    ["High", "Medium", "Low", "Clean"].forEach((k) => {
      const el = document.getElementById(`sev${k}Count`);
      if (el) el.textContent = "0";
    });

    return;
  }

  strip.classList.remove("empty");

  // Count severities
  const counts = { high: 0, medium: 0, low: 0, clean: 0 };
  displayRecords.forEach((r) => {
    counts[getSeverity(r)]++;
  });

  // Update counts + animate
  const map = [
    ["high", counts.high],
    ["medium", counts.medium],
    ["low", counts.low],
    ["clean", counts.clean],
  ];

  map.forEach(([key, value]) => {
    const seg = strip.querySelector(`.severity-segment.${key}`);
    const countEl = document.getElementById(
      `sev${key.charAt(0).toUpperCase() + key.slice(1)}Count`
    );
    if (!seg || !countEl) return;

    const prev = Number(countEl.textContent) || 0;
    countEl.textContent = value;

    if (prev !== value) {
      seg.classList.remove("animating");
      void seg.offsetWidth; // force reflow
      seg.classList.add("animating");
    }

    // STATIC: equal widths always
    seg.style.flexGrow = "1";
  });
}

/* =========================
   Loader + Run button state
========================= */
function setFiltersEnabled(enabled) {
  const ids = ["fromDate", "toDate", "filterMissing", "quickRange"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  }
}

function showLoader(text) {
  const overlay = document.getElementById("tableLoader");
  const label = document.getElementById("loaderText");
  if (label) label.textContent = text || "";
  if (overlay) overlay.classList.add("active");
}

function hideLoader() {
  const overlay = document.getElementById("tableLoader");
  if (overlay) overlay.classList.remove("active");
}

function setRunButtonState(disabled, label) {
  const runBtn = document.getElementById("runBtn");
  if (!runBtn) return;

  if (label != null) runBtn.textContent = label;
  runBtn.disabled = !!disabled;
}

function updateRunButtonState() {
  const from = document.getElementById("fromDate")?.value || "";
  const to = document.getElementById("toDate")?.value || "";
  const ok = Boolean(from && to);
  setRunButtonState(!ok, "Run report");
}

function updateCounts() {
  const pill = document.getElementById("countPill");
  if (!pill) return;

  const target = displayRecords.length;
  const start = lastVisibleCount;

  if (start === target) {
    pill.textContent = target === 1 ? "1 record" : `${target} records`;
    return;
  }

  if (countAnimFrame) {
    cancelAnimationFrame(countAnimFrame);
  }

  const duration = 250;
  const startTime = performance.now();

  function animate(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // Ease-out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(start + (target - start) * eased);

    pill.textContent = current === 1 ? "1 record" : `${current} records`;

    if (progress < 1) {
      pill.classList.add("animating");
      countAnimFrame = requestAnimationFrame(animate);
    } else {
      lastVisibleCount = target;
      countAnimFrame = null;
      pill.classList.remove("animating");
    }
  }

  countAnimFrame = requestAnimationFrame(animate);
}

/* =========================
   Toasts (5 seconds + pause on hover)
========================= */
function showToast(message, type) {
  console.log("[Toast] ENTER", message, type);
  const container = document.getElementById("toastContainer");
  console.log("[Toast] container:", container);
  if (!container) {
    console.warn("[Toast] NO CONTAINER");
    return;
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type || "info"}`;
  toast.textContent = message;

  container.appendChild(toast);
  console.log("[Toast] appended:", toast);
  let remaining = 5000;
  let start = Date.now();
  let timer = null;

  function schedule() {
    timer = window.setTimeout(() => {
      toast.classList.add("hide");
      window.setTimeout(() => toast.remove(), 200);
    }, remaining);
  }

  function pause() {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = null;
    remaining -= Date.now() - start;
  }

  function resume() {
    if (timer) return;
    start = Date.now();
    schedule();
  }

  toast.addEventListener("mouseenter", pause);
  toast.addEventListener("mouseleave", resume);

  // Start
  schedule();
}
window.addEventListener("resize", () => {
  Object.values(echartInstances).forEach((chart) => {
    chart.resize();
  });
});

function evaluateRecordSeverity(record) {
  const issues = [];

  // HIGH priority: VFC + Funding gaps
  if (!record.vfc_status) {
    issues.push({ field: "vfc_status", severity: SEVERITY.HIGH });
  }
  if (!record.funding_source) {
    issues.push({ field: "funding_source", severity: SEVERITY.HIGH });
  }

  // MEDIUM priority: Demographics gaps
  if (!record.race) {
    issues.push({ field: "race", severity: SEVERITY.MEDIUM });
  }
  if (!record.ethnicity) {
    issues.push({ field: "ethnicity", severity: SEVERITY.MEDIUM });
  }

  // LOW priority: Contact gaps
  if (!record.mobile) {
    issues.push({ field: "mobile", severity: SEVERITY.LOW });
  }
  if (!record.email) {
    issues.push({ field: "email", severity: SEVERITY.LOW });
  }

  return issues;
}
function isRecordComplete(record) {
  const issues = evaluateRecordSeverity(record);
  return issues.length === 0;
}
// =========================
// Severity calculation (authoritative)
// =========================
function getRecordSeverity(rec) {
  // HIGH: both VFC + Funding missing
  if (!rec.vfc_status && !rec.funding_source) {
    return "HIGH";
  }

  // MEDIUM: race or ethnicity missing
  if (!rec.race || !rec.ethnicity) {
    return "MEDIUM";
  }

  // LOW: contact details incomplete
  if (!rec.mobile || !rec.email) {
    return "LOW";
  }

  // CLEAN
  return "CLEAN";
}

/* =========================
   Table rendering (Plain JS)
   - Keeps cells blank when value is missing
   - Keeps header order aligned with current index.html
========================= */
function renderTable(rows) {
  const tbody = document.querySelector("#tbl tbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  const fragment = document.createDocumentFragment();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tr = document.createElement("tr");
    const severity = getSeverity(r);

    tr.classList.remove("high", "medium", "low");

    if (severity !== "clean") {
      tr.classList.add(severity);
    }

    // Reviewed state
    if (isReviewed(r.doc_id)) tr.classList.add("resolved");

    // Get the reviewed timestamp
    const timestamp = getReviewedTimestamp(r.doc_id);
    const formattedTimestamp = timestamp
      ? `${escapeHtml(new Date(timestamp).toLocaleString())}`
      : "-";

    tr.innerHTML = `
      <td>
        <a href="#" class="docLink" data-doc="${escapeHtml(
          r.doc_id
        )}">${escapeHtml(r.doc_id)}</a>
      </td>
      <td>${escapeHtml(r.patient_id)}</td>
      <td>${escapeHtml(r.administered_date)}</td>
      <td>${escapeHtml(r.vaccine_name)}</td>
      <td>${escapeHtml(r.vfc_status || "-")}</td>
      <td>${escapeHtml(r.funding_source || "-")}</td>
      <td>${escapeHtml(r.quantity)}</td>
      <td>${escapeHtml(r.units)}</td>
      <td>${escapeHtml(r.ndc || "")}</td>
      <td>${escapeHtml(r.lot_number || "")}</td>
      <td>${escapeHtml(r.expiration_date || "")}</td>
      <td>${escapeHtml(r.status)}</td>
      <td>${r.race || '<span class="missing">-</span>'}</td>
      <td>${r.ethnicity || '<span class="missing">-</span>'}</td>
      <td class="demographics">${escapeHtml(r.age || "")}</td>
      <td class="demographics">${escapeHtml(r.mobile || "-")}</td>
      <td class="demographics">${escapeHtml(r.email || "-")}</td>
      <td style="text-align:center;">
        <input
          type="checkbox"
          class="resolvedToggle"
          data-doc="${escapeHtml(r.doc_id)}"
          ${
            isRecordComplete(r)
              ? "checked disabled"
              : isReviewed(r.doc_id)
              ? "checked"
              : ""
          }
        />
      </td>
      <td>${formattedTimestamp}</td> <!-- Add Timestamp -->
    `;

    fragment.appendChild(tr);
  }

  tbody.appendChild(fragment);

  // Re-apply demographics visibility after render
  applyDemographicsVisibility();
}

/* =========================
   Demographics toggle (Hide demographics)
========================= */
function applyDemographicsVisibility() {
  const toggle = document.getElementById("toggleDemographics");
  const hide = toggle ? toggle.checked : false;

  const demoCells = document.querySelectorAll("#tbl .demographics");
  for (const cell of demoCells) {
    cell.style.display = hide ? "none" : "";
  }
}

/* =========================
   AI Placeholder + Results display
========================= */
function showAIPlaceholder() {
  const report = document.getElementById("aiReport");
  const content = document.getElementById("aiReportContent");

  if (!report || !content) return;

  report.classList.remove("is-hidden");
  report.classList.add("is-visible");

  content.innerHTML = `
    <h3>Ready to review immunization data?</h3>
    <p style="font-size:12px;color:#555;">
      Select administration date range to generate the summary.
    </p>
  `;

  updateSeverityStrip();
}

function runExplainableAI(records, from, to) {
  const report = document.getElementById("aiReport");
  const content = document.getElementById("aiReportContent");
  const strip = document.getElementById("severityStrip");

  if (!report || !content || !strip) {
    console.error("[AI] report DOM not ready");
    return;
  }

  console.log("[AI] runExplainableAI invoked", {
    records: records?.length,
    from,
    to,
  });

  // Show AI panel
  report.classList.remove("is-hidden");
  report.classList.add("is-visible");

  const total = records.length;
  const miss = (field) => records.filter((r) => !r[field]).length;

  const summary = {
    vfcEligibility: miss("vfc_status"),
    funding: miss("funding_source"),
    email: miss("email"),
    mobile: miss("mobile"),
    race: miss("race"),
    ethnicity: miss("ethnicity"),
  };

  // Render shell (no insight text yet)
  content.innerHTML = `
    <div class="reportInner">

      <!-- OVERVIEW / AI INSIGHTS -->
      <div class="ai-card">
        <div class="ai-card-header">
  <div class="sectionTitle collapsible-header" id="aiInsightsToggle" role="button" aria-expanded="false">
    <h4 class="lot-header-title"><img
  id="aiInsightsIcon"
  src="https://cdn-icons-png.flaticon.com/512/7711/7711234.png"
  alt="Insights"
  width="24"
  height="24"
/>

      Table Insights
    </h4>

    <span class="collapse-indicator" id="aiInsightsCaret">
      Show insights ▴
    </span>
  </div>
</div>

<div class="ai-card-body" id="aiInsightsContent">
<div class="ai-reading"  id="aiReadingIndicator"  style="display:none;">
  Reading records…
</div>



          <div class="ai-insight-text" id="aiInsightText"></div>

          <div class="ai-gap-summary" id="aiGapsBlock" style="display:none;">
            <div class="ai-gap-title">
              <br><b>Documentation gaps identified</b>
            </div>
            <ul class="ai-gap-list" id="aiGapsList"></ul>
          </div>

        </div>
      
  </div>
      <!-- TRENDS -->
      <div class="ai-card">
              <div class="ai-card-header">
  
    <h4 class="lot-header-title">
    <img
  src="https://cdn-icons-png.flaticon.com/512/12349/12349923.png"
  alt="Data analytics"
  width="20"
  height="20"
/>Trends</h4>
        </div>

        <div class="ai-card-body">
          <a href="#" id="viewTrendAnalysis" class="trend-link">
            View documentation trends
          </a>
          <p class="mutedText">
            Explore how documentation gaps change across time, vaccines, and lot usage.
          </p>
        </div>
      </div>

  
         

      <!-- VACCINE INVENTORY -->
      <div class="ai-card">
        <div class="ai-card-header">
          <div
            class="sectionTitle collapsible-header"
            id="lotInventoryToggle"
            role="button"
            aria-expanded="false"
          >
            <div class="lot-header-left">
              <h4 class="lot-header-title"><div class="preview-icon">
              <img
                src="https://cdn-icons-png.flaticon.com/512/17739/17739518.png"
                alt="Vaccine lot insight"
                width="20"
                height="20"
              />
            </div>
                Inventory by lot
                <span id="lotInventoryCount" class="lot-count-badge"></span>
              </h4>
            </div>

            <span class="collapse-indicator" id="lotInventoryCaret">
              Show Vaccine inventory by lot ▴
            </span>
          </div>
        </div>

        <div class="ai-card-body">
          <div class="lot-inventory-preview" id="lotInventoryPreview">
            

            <div class="preview-text">
              <div class="preview-subtext">
                Review how vaccine lots are used across records.
                This helps identify one-time lots, inconsistent usage,
                and potential data entry issues.
              </div>
            </div>
          </div>

          <div class="collapsible-content" id="lotInventoryContent">
            <div class="ai-table-wrapper">
              <table class="ai-table lot-inventory-table">
                <thead>
                  <tr>
                    <th>Vaccine</th>
                    <th>Lot number</th>
                    <th>Records</th>
                    <th>First seen</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  ${buildVaccineLotTableRows(records)}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      
  `; // Sparkle the AI Insights icon once per render
  const icon = document.getElementById("aiInsightsIcon");
  if (icon) {
    icon.classList.remove("twinkle-thrice");
    void icon.offsetWidth; // force reflow so animation restarts
    icon.classList.add("twinkle-thrice");

    // Optional cleanup after it finishes
    setTimeout(() => icon.classList.remove("twinkle-thrice"), 2650);
  }

  /* ================================
   AI INSIGHTS COLLAPSE + TYPING
================================ */

  const aiToggle = document.getElementById("aiInsightsToggle");
  const aiContent = document.getElementById("aiInsightsContent");
  const aiCaret = document.getElementById("aiInsightsCaret");
  const aiReading = document.getElementById("aiReadingIndicator");

  let aiTypedOnce = false;

  if (aiToggle && aiContent && aiCaret) {
    aiToggle.style.cursor = "pointer";

    // Start collapsed
    aiContent.style.display = "none";
    aiCaret.textContent = "Show insights ▴";

    aiToggle.addEventListener("click", () => {
      const isOpen = aiContent.style.display === "block";

      if (isOpen) {
        aiContent.style.display = "none";
        aiCaret.textContent = "Show insights ▴";
        return;
      }

      // EXPAND
      aiContent.style.display = "block";
      aiCaret.textContent = "Hide insights ▾";

      // If already typed once, do nothing
      if (aiTypedOnce) return;

      // Show shimmer
      if (aiReading) aiReading.style.display = "block";

      // Delay → then type
      setTimeout(() => {
        if (aiReading) aiReading.style.display = "none";

        typeText(
          document.getElementById("aiInsightText"),
          buildOverviewInsight({ total, from, to, summary, records }),
          18,
          () => {
            renderDocumentationGapsAnimated(summary);
            aiTypedOnce = true;
          }
        );
      }, 700); // 👈 reading pause
    });
  }

  /* ================================
     LOT INVENTORY TOGGLE
  ================================ */

  const toggle = document.getElementById("lotInventoryToggle");
  const contentEl = document.getElementById("lotInventoryContent");
  const caret = document.getElementById("lotInventoryCaret");
  const preview = document.getElementById("lotInventoryPreview");
  const lotCountEl = document.getElementById("lotInventoryCount");

  if (lotCountEl) {
    const uniqueLots = new Set(
      records.map((r) => r.lot_number).filter((l) => l && l.trim())
    );
    lotCountEl.textContent = `(${uniqueLots.size} lots)`;
  }

  if (toggle) toggle.style.cursor = "pointer";

  if (toggle && contentEl && caret) {
    caret.textContent = "Show ▴";

    toggle.addEventListener("click", () => {
      const isExpanded = contentEl.classList.toggle("is-open");
      caret.textContent = isExpanded ? "Hide ▾" : "Show ▴";
      if (preview) preview.style.display = isExpanded ? "none" : "flex";
    });
  }

  /* ================================
     OPEN TRENDS MODAL
  ================================ */

  const trendLink = document.getElementById("viewTrendAnalysis");
  if (trendLink) {
    trendLink.onclick = (e) => {
      e.preventDefault();
      console.log("[AI] Opening trend modal");

      const modal = document.getElementById("trendAnalysisModal");
      if (!modal) return;

      modal.style.display = "flex";

      requestAnimationFrame(() => {
        renderTrendView(TREND_VIEWS.BAR, records);
      });
    };
  }

  updateSeverityStrip();
}
function renderDocumentationGapsAnimated(summary, delay = 450) {
  const listEl = document.getElementById("aiGapsList");
  const blockEl = document.getElementById("aiGapsBlock");

  if (!listEl || !blockEl || !summary) return;

  listEl.innerHTML = "";
  blockEl.style.display = "block";

  const gaps = [
    { label: "Missing VFC eligibility", value: summary.vfcEligibility },
    { label: "Missing funding source", value: summary.funding },
    { label: "Missing patient email", value: summary.email },
    { label: "Missing patient phone", value: summary.mobile },
    { label: "Missing race", value: summary.race },
    { label: "Missing ethnicity", value: summary.ethnicity },
  ].filter((g) => g.value > 0);

  let index = 0;

  function showNextGap() {
    if (index >= gaps.length) return;

    const g = gaps[index];

    const li = document.createElement("li");
    li.innerHTML = `<b>${g.label}:</b> ${g.value}`;
    li.style.opacity = "0";
    li.style.transform = "translateY(4px)";
    li.style.transition = "opacity 250ms ease, transform 250ms ease";

    listEl.appendChild(li);

    requestAnimationFrame(() => {
      li.style.opacity = "1";
      li.style.transform = "translateY(0)";
    });

    index += 1;
    setTimeout(showNextGap, delay);
  }

  showNextGap();
}

function typeInsightWithGaps({ total, from, to, summary }) {
  const insightEl = document.getElementById("aiInsightText");

  const html = buildOverviewInsight({ total, from, to, summary });

  typeText(insightEl, html, 18);

  // ⏱ Wait for main paragraph typing to finish
  const estimatedTime = html.length * 18 + 300;

  setTimeout(() => {
    renderDocumentationGapsAnimated(summary);
  }, estimatedTime);
}

function buildVaccineLotTableRows(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return `<tr><td colspan="5">No lot data available</td></tr>`;
  }

  const map = {};

  records.forEach((r) => {
    if (!r.vaccine_name || !r.lot_number || !r.administered_date) return;

    const key = `${r.vaccine_name}||${r.lot_number}`;
    const date = r.administered_date;

    if (!map[key]) {
      map[key] = {
        vaccine: r.vaccine_name,
        lot: r.lot_number,
        count: 0,
        first: date,
        last: date,
      };
    }

    map[key].count += 1;
    map[key].first = map[key].first < date ? map[key].first : date;
    map[key].last = map[key].last > date ? map[key].last : date;
  });

  return Object.values(map)
    .sort((a, b) => b.count - a.count)
    .map((row) => {
      const oneOff = row.count === 1;

      return `
        <tr class="${oneOff ? "lot-one-off" : ""}">
          <td>${escapeHtml(row.vaccine)}</td>
          <td>${escapeHtml(row.lot)}</td>
          <td>
            ${row.count}
            ${
              oneOff
                ? `<span class="why-flagged" title="Used only once. Possible typo or incorrect lot selection.">ⓘ</span>`
                : ""
            }
          </td>
          <td>${row.first}</td>
          <td>${row.last}</td>
        </tr>
      `;
    })
    .join("");
}

function buildOverviewInsight({ total, from, to, summary, records }) {
  const seedKey = [
    String(total || 0),
    String(from || ""),
    String(to || ""),
    String(summary?.vfcEligibility || 0),
    String(summary?.funding || 0),
    String(summary?.email || 0),
    String(summary?.mobile || 0),
    String(summary?.race || 0),
    String(summary?.ethnicity || 0),
  ].join("|");

  const seed = hashStringToInt(seedKey);
  const range = formatRange(from, to);

  // Severity counts
  const sev = { high: 0, medium: 0, low: 0, clean: 0 };
  if (Array.isArray(records) && typeof getSeverity === "function") {
    records.forEach((r) => {
      const s = getSeverity(r);
      if (sev[s] !== undefined) sev[s] += 1;
    });
  }

  // Gaps with explicit provider wording
  const gaps = [
    {
      key: "vfcEligibility",
      label: "Eligibility status (VFC)",
      action:
        "Open the patient chart, open the vaccine order, and document eligibility status (or patient declined, if appropriate).",
      value: summary?.vfcEligibility || 0,
      priority: 1,
    },
    {
      key: "funding",
      label: "Funding source",
      action:
        "Open the patient chart, open the vaccine order, and document the funding source for the vaccine.",
      value: summary?.funding || 0,
      priority: 2,
    },
    {
      key: "mobile",
      label: "Patient phone number",
      action:
        "Confirm the best reachable phone number in the patient chart and update demographics.",
      value: summary?.mobile || 0,
      priority: 4,
    },
    {
      key: "email",
      label: "Patient email",
      action:
        "Confirm the best email in the patient chart and update demographics.",
      value: summary?.email || 0,
      priority: 5,
    },
    {
      key: "race",
      label: "Race",
      action:
        "Update race in the patient chart, or select patient declined if appropriate.",
      value: summary?.race || 0,
      priority: 6,
    },
    {
      key: "ethnicity",
      label: "Ethnicity",
      action:
        "Update ethnicity in the patient chart, or select patient declined if appropriate.",
      value: summary?.ethnicity || 0,
      priority: 7,
    },
  ]
    .filter((g) => g.value > 0)
    .sort((a, b) => b.value - a.value);

  const needsEligibility = (summary?.vfcEligibility || 0) > 0;
  const needsFunding = (summary?.funding || 0) > 0;
  const hasDocumentationGaps =
    (summary?.vfcEligibility || 0) +
      (summary?.funding || 0) +
      (summary?.email || 0) +
      (summary?.mobile || 0) +
      (summary?.race || 0) +
      (summary?.ethnicity || 0) >
    0;

  // Use “paired requirement” when both apply
  const pairingLine = (function () {
    if (needsEligibility && needsFunding) {
      return "For affected records, document eligibility status (VFC) and funding source together, using a consistent valid pair.";
    }
    if (needsEligibility) {
      return "For affected records, document eligibility status (VFC) in the vaccine order.";
    }
    if (needsFunding) {
      return "For affected records, document the funding source in the vaccine order.";
    }
    return "";
  })();

  // Choose next action by priority, not only frequency
  const nextByPriority = gaps
    .slice()
    .sort((a, b) => (a.priority || 99) - (b.priority || 99))[0];
  const topDriversLimit = hasDocumentationGaps ? 2 : 3;
  const topDrivers = gaps.slice(0, topDriversLimit);

  const driversListHtml = topDrivers.length
    ? `<ul>
      ${topDrivers
        .map(
          (g) =>
            `<li>${g.label} <span class="mutedText">(${g.value})</span></li>`
        )
        .join("")}
    </ul>`
    : `<p class="mutedText">No recurring gaps detected.</p>`;

  // Sentence-length mode (stable per selection)
  const useShort = seededBool(seed, 1); // short vs medium mode

  // Phrase banks (more variety)
  const headerStarters = [
    "Clinical review snapshot",
    "Documentation review summary",
    "Clinical documentation readout",
    "Quality review snapshot",
    "Documentation quality summary",
    "Clinical review brief",
    "Review summary",
    "Clinical check summary",
    "Clinical documentation check",
    "Documentation quality readout",
  ];

  const contextStarters = [
    "Reviewing",
    "Looking at",
    "Assessing",
    "Summarizing",
    "From",
    "Across",
    "Within",
    "Based on",
  ];

  const riskLeadIns = [
    "Risk distribution",
    "Severity split",
    "Risk profile",
    "Overall risk picture",
    "Current mix",
  ];

  const actionLeadInsHighShort = [
    "Start with high-risk items.",
    "High risk comes first.",
    "Fix high risk first.",
    "Lead with high-risk fixes.",
    "Clear high risk first.",
  ];

  const actionLeadInsHighMed = [
    "Start with the high-risk items.",
    "First priority is high risk.",
    "Address high-risk items before anything else.",
    "High risk comes first in this selection.",
    "Lead with the high-risk fixes to prevent rework.",
  ];

  const actionLeadInsNoHighShort = [
    "High risk is clear.",
    "No high-risk flags.",
    "No high-risk items.",
    "High-risk is not present.",
  ];

  const actionLeadInsNoHighMed = [
    "High risk is clear in this selection.",
    "No high-risk flags surfaced here.",
    "There are no high-risk items in this slice.",
    "This selection has no high-risk issues.",
  ];

  const ehrShort = [
    "Open the chart and vaccine order. Update missing fields. Re-save.",
    "Open the chart. Open the vaccine order. Fill missing fields. Re-save.",
    "Open the patient chart. Update the vaccine order. Re-save the order.",
  ];

  const ehrMed = [
    "Open the patient chart in the EHR, open the vaccine order, update the missing fields, and re-save the order.",
    "In the EHR, open the patient chart, open the vaccine order, complete the missing fields, and re-save.",
    "Go to the patient chart, open the vaccine order, fill the missing fields, then re-save the order.",
    "Open the chart and vaccine order, update the missing elements, and re-save so the corrected data is captured.",
  ];

  const driversLeadIns = [
    "What is driving this",
    "Top drivers",
    "Most common gaps",
    "Main gaps",
    "Highest-yield gaps",
    "Key gaps",
  ];

  const whyLeadIns = [
    "Why it matters",
    "Clinical impact",
    "Operational impact",
    "Downstream impact",
    "Submission impact",
  ];

  const whyShort = [
    "These gaps can trigger rejections and rework.",
    "Missing fields often lead to follow-up corrections.",
    "Fixing these early reduces downstream cleanup.",
    "Incomplete fields can delay reporting.",
  ];

  const whyMed = [
    "These gaps can trigger rejected submissions, delayed reporting, or follow-up chart corrections after the visit.",
    "Small missing elements often lead to submission failures and avoidable rework for the clinic team.",
    "Addressing these early reduces registry rejections and decreases the time spent on cleanup later.",
    "When these fields are incomplete, clinics often see more rework and slower reporting timelines.",
  ];

  const clinicianNoteShort = [
    "Document eligibility status (VFC) and funding source together.",
    "Eligibility status (VFC) and funding source must be a valid pair.",
    "Update eligibility status (VFC) and funding source in the same vaccine order edit.",
  ];

  const clinicianNoteMed = [
    "Eligibility status (VFC) and funding source should be documented together as a valid, consistent pair.",
    "When eligibility status (VFC) is updated, verify the funding source matches a valid pair for this visit.",
    "Update eligibility status (VFC) and funding source together, then re-save the vaccine order.",
  ];

  const header = seededPick(headerStarters, seed);
  const context = seededPick(contextStarters, seed + 3);
  const riskLabel = seededPick(riskLeadIns, seed + 5);

  const driversLabel = seededPick(driversLeadIns, seed + 11);
  const whyLabel = seededPick(whyLeadIns, seed + 13);

  const whyLine = useShort
    ? seededPick(whyShort, seed + 17)
    : seededPick(whyMed, seed + 17);

  const titleLine = `<strong>${header}: ${context} ${total} selected ${pluralWord(
    total,
    "record",
    "records"
  )}${range ? ` (${range})` : ""}</strong>`;

  const riskLine =
    sev.high + sev.medium + sev.low + sev.clean > 0
      ? `<p class="mutedText"><strong>${riskLabel}:</strong> High risk (${sev.high}), Medium risk (${sev.medium}), Low risk (${sev.low}), No risk (${sev.clean}).</p>`
      : "";

  // Action line: split into short sentences, avoid repeating "Open" twice
  const ehrStep = useShort
    ? "In the EHR, open the patient chart, then the vaccine order."
    : "In the EHR, open the patient chart, then open the vaccine order, update the missing fields, and re-save.";

  let actionLine = "";
  if (sev.high > 0) {
    const opener = useShort
      ? seededPick(actionLeadInsHighShort, seed + 19)
      : seededPick(actionLeadInsHighMed, seed + 19);

    actionLine =
      `<p><strong>Action first:</strong> ${opener}</p>` +
      `<p>${ehrStep}</p>` +
      (pairingLine ? `<p>${pairingLine}</p>` : "") +
      `<p class="mutedText">(${sev.high} high-risk ${pluralWord(
        sev.high,
        "item",
        "items"
      )} in this selection.)</p>`;
  } else {
    const opener = useShort
      ? seededPick(actionLeadInsNoHighShort, seed + 23)
      : seededPick(actionLeadInsNoHighMed, seed + 23);

    actionLine =
      `<p><strong>Next step:</strong> ${opener}</p>` +
      `<p>${ehrStep}</p>` +
      (pairingLine ? `<p>${pairingLine}</p>` : "");
  }

  const driversBlock = `<p><strong>${driversLabel}:</strong></p>${driversListHtml}`;

  const nextActionLine = nextByPriority
    ? `<p><strong>Next best action:</strong> ${nextByPriority.action}</p>`
    : "";

  const clinicianNoteLine =
    needsEligibility && needsFunding
      ? `<p><strong>Clinician note:</strong> ${
          useShort
            ? seededPick(clinicianNoteShort, seed + 29)
            : seededPick(clinicianNoteMed, seed + 29)
        }</p>`
      : "";

  const whyLineHtml = `<p class="mutedText"><strong>${whyLabel}:</strong> ${whyLine}</p>`;

  // Layout variation, but always readable
  const layoutA = [
    `<p>${titleLine}</p>`,
    riskLine,
    actionLine,
    clinicianNoteLine,
    driversBlock,
    nextActionLine,
    whyLineHtml,
  ]
    .filter(Boolean)
    .join("");

  const layoutB = [
    `<p>${titleLine}</p>`,
    actionLine,
    clinicianNoteLine,
    riskLine,
    driversBlock,
    nextActionLine,
    whyLineHtml,
  ]
    .filter(Boolean)
    .join("");

  const layoutC = [
    `<p>${titleLine}</p>`,
    driversBlock,
    actionLine,
    clinicianNoteLine,
    riskLine,
    nextActionLine,
    whyLineHtml,
  ]
    .filter(Boolean)
    .join("");

  const layoutPick = seed % 3;
  if (layoutPick === 0) return layoutA;
  if (layoutPick === 1) return layoutB;
  return layoutC;
}

function getRiskLevel(summary) {
  const highRisk = summary.vfc + summary.funding;
  const mediumRisk = summary.race + summary.ethnicity;

  if (highRisk >= 5) return "high";
  if (mediumRisk >= 5) return "medium";
  return "low";
}
function emphasize(text, condition, className) {
  return condition ? `<span class="${className}">${text}</span>` : text;
}
function typeText(el, html, speed = 18, onDone) {
  el.innerHTML = "";
  let i = 0;

  const temp = document.createElement("div");
  temp.innerHTML = html;
  const text = temp.innerHTML;

  const interval = setInterval(() => {
    el.innerHTML = text.slice(0, i++);
    if (i > text.length) {
      clearInterval(interval);
      if (typeof onDone === "function") onDone();
    }
  }, speed);
}

function updateInsightForView(view) {
  const el = document.getElementById("aiInsightText");
  if (!el) return;

  let suffix = "";

  if (view === TREND_VIEWS.BAR) {
    suffix =
      " The stacked bar view highlights how these gaps change over time.";
  } else if (view === TREND_VIEWS.TREEMAP) {
    suffix =
      " The treemap emphasizes which documentation gaps contribute most to overall risk.";
  } else if (view === TREND_VIEWS.LOT_TABLE) {
    suffix =
      " The table below helps identify unusual vaccine lot usage patterns.";
  }

  el.innerHTML += `<span class="ai-view-hint">${suffix}</span>`;
}

/* =========================
   Record Guidance panel (modal)
   - Includes Race/Ethnicity here (no header mismatch)
========================= */
function openRecordPanel(rec) {
  const panel = document.getElementById("recordPanel");
  if (!panel) return;

  /* =========================
     TOGGLE BEHAVIOR
     Same document clicked again → close panel
  ========================= */
  if (
    panel.classList.contains("isOpen") &&
    CURRENT_OPEN_DOC_ID === rec.doc_id
  ) {
    closeRecordPanel();
    return;
  }

  CURRENT_OPEN_DOC_ID = rec.doc_id;

  const summaryTable = `
    <table class="recordSummaryTable">
      <tbody>
        <tr>
          <th>Patient ID</th>
          <td>${escapeHtml(rec.patient_id)}</td>
        </tr>
        <tr>
          <th>Age</th>
          <td>${escapeHtml(rec.age)} yrs</td>
        </tr>
        <tr>
          <th>Vaccine</th>
          <td>${escapeHtml(rec.vaccine_name)}</td>
        </tr>
        <tr>
          <th>Administration date</th>
          <td>${escapeHtml(rec.administered_date)}</td>
        </tr>
        <tr>
          <th>Dose</th>
          <td>${escapeHtml(rec.quantity)} ${escapeHtml(rec.units)}</td>
        </tr>
        <tr>
          <th>VFC Eligibility Source</th>
          <td>${escapeHtml(rec.vfc_status || "—")}</td>
        </tr>
        <tr>
          <th>Funding Source</th>
          <td>${escapeHtml(rec.funding_source || "—")}</td>
        </tr>
      </tbody>
    </table>
  `;

  /* =========================
     Severity + completeness
  ========================= */
  const issues = evaluateRecordSeverity(rec);
  const isComplete = issues.length === 0;

  const reviewed = isReviewed(rec.doc_id);
  const reviewedTs = getReviewedTimestamp(rec.doc_id);

  /* =========================
     Missing list
  ========================= */
  const missingList = issues.length
    ? issues
        .map((issue) => {
          const g = FIELD_GUIDANCE[issue.field];
          return `<li>${escapeHtml(g ? g.label : issue.field)}</li>`;
        })
        .join("")
    : "<li>No documentation gaps detected for this record.</li>";

  /* =========================
     Guidance items
  ========================= */
  const guidanceItems = issues.length
    ? issues
        .map((issue) => {
          const g = FIELD_GUIDANCE[issue.field];
          if (!g) return "";

          const severityLabel =
            issue.severity === SEVERITY.HIGH
              ? "High impact"
              : issue.severity === SEVERITY.MEDIUM
              ? "Medium impact"
              : "Low impact";

          return `
            <li class="guidanceItem">
              <div class="guidanceHead">
                ${escapeHtml(g.label)}
                <span class="sevTag sev${escapeHtml(issue.severity)}">
                  ${severityLabel}
                </span>
              </div>
              <div class="guidanceBody">
                <div>${escapeHtml(g.impact)}</div>
                <div><b>What to do:</b> ${escapeHtml(g.fix)}</div>
              </div>
            </li>
          `;
        })
        .join("")
    : "<li>No recommendations. This record is complete.</li>";

  const reviewedLine = reviewedTs
    ? `Reviewed on ${escapeHtml(new Date(reviewedTs).toLocaleString())}`
    : "";

  panel.innerHTML = `
    <div class="rgModal">
      <div class="rgHeader">
        <div class="rgIcon" aria-hidden="true">
          <svg viewBox="0 0 24 24" class="infoIcon">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
            <line x1="12" y1="10" x2="12" y2="16" stroke="currentColor" stroke-width="2"/>
            <circle cx="12" cy="7" r="1.2" fill="currentColor"/>
          </svg>
        </div>

        <div class="rgTitleGroup">
          <h3>Record Guidance</h3>
          <p class="rgSubtitle">
            Review documentation gaps that may affect immunization reporting or registry acceptance.
          </p>
        </div>

        <button
          class="rgCloseBtn rgCloseX"
          id="closePanelBtn"
          type="button"
          aria-label="Close record guidance"
        >
          <svg viewBox="0 0 24 24" class="rgCloseIcon" aria-hidden="true">
            <line x1="6" y1="6" x2="18" y2="18"/>
            <line x1="18" y1="6" x2="6" y2="18"/>
          </svg>
        </button>
      </div>

      <div class="rgBody">
        <div class="sectionTitle blueInfo">Patient & Visit Summary</div>
        <div class="kv"><b>Order ID:</b> ${escapeHtml(rec.doc_id)}</div>

        <div class="reviewRow">
          <b>Review status:</b>
          <span class="reviewStatus ${
            isComplete ? "isReviewed" : reviewed ? "isReviewed" : "needsReview"
          }">
            ${isComplete ? "Completed" : reviewed ? "Reviewed" : "Needs review"}
          </span>
          ${
            !isComplete && reviewedLine
              ? `<span class="hintText">(${reviewedLine})</span>`
              : ""
          }
        </div>

        ${summaryTable}

        <div class="sectionTitle blueInfo reportWarningLegend ${
          isComplete ? "isComplete" : reviewed ? "isReviewed" : ""
        }">
          <div class="legendTitle">
            ${
              isComplete
                ? "✓ Documentation complete"
                : reviewed
                ? "✓ Reviewed documentation gaps"
                : "⚠ Missing or risky elements"
            }
          </div>

          <ul class="list statusMessage">
            ${
              isComplete
                ? "<li>All required immunization documentation is complete.</li>"
                : reviewed
                ? "<li>Documentation gaps were reviewed and acknowledged by the provider.</li>"
                : missingList
            }
          </ul>
        </div>

        <div class="sectionTitle blueInfo">Why this matters</div>
        <ul class="list">${guidanceItems}</ul>
      </div>

      ${
        isComplete
          ? ""
          : `
        <div class="rgActions reviewActionRow">
          <button
            class="btn reviewBtn ${reviewed ? "reviewed" : "needsReview"}"
            id="toggleResolvedBtn"
            type="button"
          >
            ${reviewed ? "Reviewed" : "Mark as reviewed"}
          </button>

          <span class="reviewHint">
            Mark as reviewed after correcting this record in the EHR.
          </span>
        </div>
      `
      }
    </div>
  `;

  /* =========================
     Show panel
  ========================= */
  panel.style.display = "flex";

  requestAnimationFrame(() => {
    panel.classList.remove("isClosing");
    panel.classList.add("isOpen");
    panel.setAttribute("aria-hidden", "false");
    panel.setAttribute("tabindex", "-1");
    panel.focus();
  });

  const closeBtn = document.getElementById("closePanelBtn");
  if (closeBtn) closeBtn.addEventListener("click", closeRecordPanel);

  const toggleBtn = document.getElementById("toggleResolvedBtn");
  if (toggleBtn && !isComplete) {
    toggleBtn.addEventListener("click", function () {
      const next = !isReviewed(rec.doc_id);
      setReviewed(rec.doc_id, next);
      updateTimestampCell(rec.doc_id);

      const row = document
        .querySelector(
          `#tbl .resolvedToggle[data-doc="${CSS.escape(rec.doc_id)}"]`
        )
        ?.closest("tr");

      if (row) {
        row.classList.toggle("resolved", next);
        const chk = row.querySelector(".resolvedToggle");
        if (chk) chk.checked = next;
      }

      updateCounts();
      closeRecordPanel();

      showToast(
        next ? `Reviewed: ${rec.doc_id}` : `Need to review: ${rec.doc_id}`,
        next ? "success" : "info"
      );
    });
  }
}

function closeRecordPanel() {
  if (document.activeElement) {
    document.activeElement.blur();
  }

  const panel = document.getElementById("recordPanel");
  if (!panel) return;

  console.log("[RecordPanel] CLOSE");

  // 1️⃣ Move focus OUT first (CRITICAL)
  const safeFocusTarget =
    document.getElementById("refreshBtn") ||
    document.getElementById("runBtn") ||
    document.querySelector("button, a, input, select");

  if (safeFocusTarget) {
    safeFocusTarget.focus();
  } else {
    document.body.focus();
  }

  // 2️⃣ Animate out visually
  panel.classList.remove("isOpen");
  panel.classList.add("isClosing");

  // 3️⃣ AFTER animation, hide from AT + layout
  setTimeout(() => {
    panel.setAttribute("aria-hidden", "true");
    panel.style.display = "none";
    panel.classList.remove("isClosing");
    CURRENT_OPEN_DOC_ID = null;
  }, 250);
}
// Buttons
// Ensure the CSV button listener is added only once
const csvBtn = document.getElementById("csvBtn");
if (csvBtn) {
  // Add the event listener to the CSV button only once
  csvBtn.addEventListener("click", (e) => {
    e.preventDefault(); // Prevent default anchor behavior
    downloadCSV(); // Trigger the CSV download
  });
}

// =========================
// CSV export function
// =========================
function downloadCSV() {
  const rows = filteredRecords || [];
  if (!rows.length) {
    alert("No rows to export");
    return;
  }

  const headers = [
    "doc_id",
    "patient_id",
    "status",
    "age",
    "race",
    "ethnicity",
    "mobile",
    "email",
    "administered_date",
    "vaccine_name",
    "vfc_status",
    "funding_source",
    "quantity",
    "units",
    "ndc",
    "lot_number",
    "expiration_date",
    "readiness_score",
    "reviewed",
    "reviewed_timestamp",
  ];

  const lines = [];
  lines.push(headers.join(","));

  for (const r of rows) {
    const score = computeReadiness(r);
    const reviewed = isReviewed(r.doc_id) ? "1" : "0";
    const ts = getReviewedTimestamp(r.doc_id) || "";

    const vals = [
      r.doc_id,
      r.patient_id,
      r.status,
      r.age,
      r.race,
      r.ethnicity,
      r.mobile,
      r.email,
      r.administered_date,
      r.vaccine_name,
      r.vfc_status,
      r.funding_source,
      r.quantity,
      r.units,
      r.ndc,
      r.lot_number,
      r.expiration_date,
      score,
      reviewed,
      ts,
    ].map(csvEscape);

    lines.push(vals.join(","));
  }

  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "immunization_data_quality_export.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url); // Clean up the object URL after download starts
}

/* =========================
   Date pickers (Flatpickr)
   - Default: last 7 days
   - Prevent future dates
   - Auto-correct From > To
   - “T” shortcut sets today
========================= */
function clampToToday(d) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const x = new Date(d);
  x.setHours(0, 0, 0, 0);

  if (x > today) return today;
  return x;
}

function formatYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function handleTodayShortcut(inputId, picker) {
  const el = document.getElementById(inputId);
  if (!el || !picker) return;

  el.addEventListener("keydown", function (e) {
    if (e.key === "t" || e.key === "T") {
      e.preventDefault();
      const today = clampToToday(new Date());
      picker.setDate(today, true);
      updateRunButtonState();
    }
  });
}

function ensureFromToOrder() {
  const fromVal = document.getElementById("fromDate")?.value || "";
  const toVal = document.getElementById("toDate")?.value || "";
  if (!fromVal || !toVal) return;

  if (fromVal > toVal) {
    // Auto-correct: set To = From
    const fromDate = fromPicker
      ? fromPicker.selectedDates[0]
      : new Date(fromVal);
    if (toPicker) toPicker.setDate(fromDate, true);
  }
}

function applyQuickRange(days) {
  const today = clampToToday(new Date());
  const from = new Date(today);
  from.setDate(from.getDate() - (days - 1)); // inclusive range

  if (fromPicker) fromPicker.setDate(from, true);
  if (toPicker) toPicker.setDate(today, true);

  ensureFromToOrder();
  updateRunButtonState();
}

function initDatePickers() {
  if (typeof flatpickr !== "function") {
    // If Flatpickr is not loaded, fallback to native values
    updateRunButtonState();
    return;
  }

  const maxDate = clampToToday(new Date());

  fromPicker = flatpickr("#fromDate", {
    dateFormat: "Y-m-d",
    allowInput: true,
    maxDate,
    onChange: () => {
      ensureFromToOrder();
      updateRunButtonState();
      applyDateFilters();
    },
  });

  toPicker = flatpickr("#toDate", {
    dateFormat: "Y-m-d",
    allowInput: true,
    maxDate,
    onChange: () => {
      ensureFromToOrder();
      updateRunButtonState();
      applyDateFilters();
    },
  });

  handleTodayShortcut("fromDate", fromPicker);
  handleTodayShortcut("toDate", toPicker);

  const quick = document.getElementById("quickRange");

  if (quick) {
    quick.addEventListener("change", function () {
      const v = quick.value;

      switch (v) {
        case "today":
          applyTodayRange();
          break;

        case "yesterday":
          applyYesterdayRange();
          break;

        case "last7":
          applyLast7DaysRange();
          break;

        case "last14":
          applyLast14DaysRange();
          break;

        case "last30":
          applyLast30DaysRange();
          break;

        case "custom":
        default:
          // manual date editing will handle this
          return;
      }

      applyDateFilters();
    });
  }
}
let aiTimer = null;

function autoRunAI() {
  if (aiTimer) {
    clearTimeout(aiTimer);
  }

  aiTimer = setTimeout(() => {
    if (!displayRecords.length) {
      showAIPlaceholder();
      return;
    }

    runExplainableAI(
      displayRecords,
      document.getElementById("fromDate").value,
      document.getElementById("toDate").value
    );
  }, 300);
}
const TREND_VIEWS = {
  BAR: "bar",
  TREEMAP: "treemap",
  LOT_TABLE: "lot_table",
};

const TREND_VIEW_ORDER = [
  TREND_VIEWS.BAR,
  TREND_VIEWS.TREEMAP,
  TREND_VIEWS.LOT_TABLE,
];

let currentTrendView = TREND_VIEWS.BAR;

function setActiveTrendContainer(view) {
  const views = document.querySelectorAll(".trend-view");

  views.forEach((el) => {
    const elView = el.getAttribute("data-view");
    el.classList.remove("is-active", "slide-in-left", "slide-in-right");

    if (elView === view) {
      const currentIdx = TREND_VIEW_ORDER.indexOf(currentTrendView);
      const nextIdx = TREND_VIEW_ORDER.indexOf(view);

      if (nextIdx > currentIdx) {
        el.classList.add("slide-in-right");
      } else if (nextIdx < currentIdx) {
        el.classList.add("slide-in-left");
      }

      // Force reflow so animation triggers correctly
      void el.offsetWidth;

      el.classList.add("is-active");
    }
  });
}

function computeMissingSummary(records) {
  const summary = {
    vfc: 0,
    funding: 0,
    race: 0,
    ethnicity: 0,
    mobile: 0,
    email: 0,
  };

  for (const r of records || []) {
    if (!r.vfc_status) summary.vfc++;
    if (!r.funding_source) summary.funding++;
    if (!r.race) summary.race++;
    if (!r.ethnicity) summary.ethnicity++;
    if (!r.mobile) summary.mobile++;
    if (!r.email) summary.email++;
  }

  return summary;
}

function updateTrendNavigation() {
  const leftBtn = document.getElementById("trendPrev");
  const rightBtn = document.getElementById("trendNext");
  const leftTip = document.getElementById("leftArrowTooltip");
  const rightTip = document.getElementById("rightArrowTooltip");

  if (!leftBtn || !rightBtn) return;

  const idx = TREND_VIEW_ORDER.indexOf(currentTrendView);

  console.log("[TrendNav] view:", currentTrendView, "index:", idx);

  // --- Show / hide arrows ---
  leftBtn.hidden = idx <= 0;
  rightBtn.hidden = idx >= TREND_VIEW_ORDER.length - 1;

  // --- Reset tooltips ---
  if (leftTip) leftTip.textContent = "";
  if (rightTip) rightTip.textContent = "";

  // --- LEFT tooltip ---
  if (idx > 0 && leftTip) {
    const prev = TREND_VIEW_ORDER[idx - 1];

    if (prev === TREND_VIEWS.BAR) {
      leftTip.textContent = "Bar chart";
    } else if (prev === TREND_VIEWS.TREEMAP) {
      leftTip.textContent = "Treemap";
    }
  }

  // --- RIGHT tooltip ---
  if (idx < TREND_VIEW_ORDER.length - 1 && rightTip) {
    const next = TREND_VIEW_ORDER[idx + 1];

    if (next === TREND_VIEWS.TREEMAP) {
      rightTip.textContent = "Treemap";
    } else if (next === TREND_VIEWS.LOT_TABLE) {
      rightTip.textContent = "Lot usage";
    }
  }
}

function renderTrendView(view, records) {
  console.log("[TrendView] view change:", view);
  currentTrendView = view;

  setActiveTrendContainer(view);
  updateTrendHeader(view);
  updateTrendInfoBulb(view, records);

  requestAnimationFrame(() => {
    if (view === TREND_VIEWS.BAR) {
      renderStackedBarEChart("echartStackedBar", records);
    }
    if (view === TREND_VIEWS.TREEMAP) {
      renderTreemapEChart("echartTreemap", records);
    }
    if (view === TREND_VIEWS.LOT_TABLE) {
      renderWeeklyLotUsageTable(records);
    }
  });

  updateTrendNavigation();
}

function updateTrendInfoBulb(view, records) {
  const bulb = document.querySelector(".info-bulb");
  if (!bulb || !bulb.__setFullExplanation) return;

  const data = Array.isArray(records) ? records : [];
  let html = "<b>Graph insights.</b>";

  if (view === TREND_VIEWS.BAR) {
    html = buildBarInsight(data);
  } else if (view === TREND_VIEWS.TREEMAP) {
    html = buildTreemapInsight(data);
  } else if (view === TREND_VIEWS.LOT_TABLE) {
    html = buildLotTableInsight(data);
  }

  bulb.__setFullExplanation(html);
}

function buildTreemapInsight(records) {
  const s = computeMissingSummary(records);
  const total = Object.values(s).reduce((a, b) => a + b, 0);
  if (!total) {
    return `<b>No major gaps detected.</b>`;
  }

  const top = Object.entries(s).sort((a, b) => b[1] - a[1])[0];
  const pct = Math.round((top[1] / total) * 100);

  return `
    <b>${humanizeField(
      top[0]
    )}</b> accounts for ${pct}% of missing data.<ul><li>
    Larger tiles indicate higher documentation burden.</li>
    <li>Addressing the largest tile yields maximum impact.</li></ul>
  `;
}

function buildBarInsight(records) {
  const s = computeMissingSummary(records);
  const top = Object.entries(s).sort((a, b) => b[1] - a[1])[0];

  if (!top || top[1] === 0) {
    return `
      <b>No dominant trend.</b><br/>
      Missing documentation is evenly distributed over time.
    `;
  }

  return `
    <b>Primary trend:</b> ${humanizeField(top[0])}.
    <ul><li>Stacked bars show how missing fields change by date.</li>
    <li>Rising bars suggest workflow or intake issues during that period.</li></ul>
  `;
}

function buildLotTableInsight(records) {
  const counts = {};
  const weeksByLot = {};

  records.forEach((r) => {
    if (!r.lot_number || !r.administered_date) return;

    const lot = r.lot_number.trim();
    const week = getWeekLabel(r.administered_date);

    counts[lot] = (counts[lot] || 0) + 1;

    if (!weeksByLot[lot]) weeksByLot[lot] = new Set();
    weeksByLot[lot].add(week);
  });

  const oneOffLots = Object.entries(counts)
    .filter(([, v]) => v === 1)
    .map(([lot]) => lot);

  const singleWeekLots = Object.entries(weeksByLot).filter(
    ([, weeks]) => weeks.size === 1
  ).length;

  return `
    <b>Lot usage quality check.</b><br/>
    ${oneOffLots.length} lot numbers appear only once.
    ${singleWeekLots} lots appear in only a single week.
    <ul>
      <li>One-time or short-lived lots often indicate manual entry errors</li>
      <li>Consistent lots across weeks suggest normal inventory usage</li>
      <li>Review lots with sudden appearance or disappearance</li>
    </ul>
  `;
}

function humanizeField(key) {
  const map = {
    vfc: "VFC eligibility",
    funding: "Funding source",
    race: "Race",
    ethnicity: "Ethnicity",
    mobile: "Mobile number",
    email: "Email",
  };
  return map[key] || key;
}

function getOrCreateChart(view, elId) {
  const el = document.getElementById(elId);
  if (!el) {
    console.warn("[ECharts] container missing:", elId);
    return null;
  }

  if (!echartsRegistry[view]) {
    echartsRegistry[view] = echarts.init(el);
    console.log("[ECharts] init:", view);
  }

  return echartsRegistry[view];
}

function getChart(elId) {
  const el = document.getElementById(elId);
  if (!el) return null;
  return echarts.getInstanceByDom(el) || echarts.init(el);
}
function destroyTrendVisuals() {
  disposeChart("echartStackedBar");
  disposeChart("echartTreemap");
  disposeChart("echartHeatmap");
}

function resizeActiveEChart(view) {
  const chart = echartsRegistry[view];
  if (chart) {
    chart.resize();
    console.log("[ECharts] resized:", view);
  }
}

function openTrendModal(records) {
  const modal = document.getElementById("trendAnalysisModal");
  if (!modal) return;

  modal.style.display = "flex";

  requestAnimationFrame(() => {
    renderTrendView(TREND_VIEWS.BAR, records);
  });
}

function closeTrendModalAndCleanup(e) {
  if (e) e.preventDefault();

  const modal = document.getElementById("trendAnalysisModal");
  if (!modal) return;

  modal.style.display = "none";
  destroyTrendVisuals();
}

function getWeekLabel(dateStr) {
  const d = new Date(dateStr);
  const start = new Date(d);
  start.setDate(d.getDate() - d.getDay());
  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  return `${start.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })}–${end.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })}`;
}
function getLotColor(lot) {
  if (!lotColorMap[lot]) {
    const colors = [
      "#2563eb",
      "#059669",
      "#7c3aed",
      "#ea580c",
      "#0f766e",
      "#1e3a8a",
      "#9333ea",
      "#0284c7",
    ];
    lotColorMap[lot] = colors[Object.keys(lotColorMap).length % colors.length];
  }
  return lotColorMap[lot];
}

/* =========================
   UI Wiring
========================= */
function wireUI() {
  console.log(
    "[StartScreen] DOM check:",
    document.getElementById("startScreenModal")
  );

  /* =========================
     HELP / START SCREEN
  ========================== */

  const helpLink = document.getElementById("helpLink");
  if (helpLink) {
    helpLink.addEventListener("click", () => {
      openWelcomeModal();
    });
  }

  const startBeginBtn = document.getElementById("startBeginBtn");
  if (startBeginBtn) {
    startBeginBtn.addEventListener("click", () => {
      console.log("[StartScreen] user started review");

      closeStartScreenModal();

      showLoader("Preparing immunization documentation review…");
      setTimeout(hideLoader, 1200);
    });
  }

  const startHowToBtn = document.getElementById("startHowToBtn");
  if (startHowToBtn) {
    startHowToBtn.addEventListener("click", () => {
      closeStartScreenModal();
      openWelcomeModal();
    });
  }

  const closeStartScreenBtn = document.getElementById("closeStartScreenBtn");
  if (closeStartScreenBtn) {
    closeStartScreenBtn.addEventListener("click", closeStartScreenModal);
  }

  const continueBtn = document.getElementById("continueToDashboardBtn");
  if (continueBtn) {
    continueBtn.addEventListener("click", closeStartScreenModal);
  }

  const openHelpFromStart = document.getElementById("openHelpFromStartBtn");
  if (openHelpFromStart) {
    openHelpFromStart.addEventListener("click", () => {
      closeStartScreenModal();
      openWelcomeModal();
    });
  }

  /* =========================
     WELCOME MODAL CLOSE
  ========================== */

  const closeWelcomeBtn = document.getElementById("closeWelcomeBtn");
  if (closeWelcomeBtn) {
    closeWelcomeBtn.addEventListener("click", () => {
      const modal = document.getElementById("welcomeModal");
      if (!modal) return;

      modal.classList.add("isClosing");
      setTimeout(() => {
        modal.style.display = "none";
        modal.setAttribute("aria-hidden", "true");
        modal.classList.remove("isClosing");
      }, 250);
    });
  }

  /* =========================
     TABLE INTERACTIONS
  ========================== */

  const tbody = document.querySelector("#tbl tbody");
  if (tbody) {
    tbody.addEventListener("click", (e) => {
      const a = e.target.closest("a.docLink");
      if (!a) return;

      e.preventDefault();
      const doc = a.getAttribute("data-doc");
      const rec =
        filteredRecords.find((r) => r.doc_id === doc) ||
        allRecords.find((r) => r.doc_id === doc);

      if (rec) openRecordPanel(rec);
    });

    tbody.addEventListener("change", (e) => {
      const chk = e.target.closest(".resolvedToggle");
      if (!chk) return;

      const doc = chk.getAttribute("data-doc");
      const val = chk.checked;
      setReviewed(doc, val);
      updateTimestampCell(doc);

      applyCompletedRowsToggle();
      updateCounts();

      showToast(
        val ? `Reviewed: ${doc}` : `Need to review: ${doc}`,
        val ? "success" : "info"
      );
    });
  }

  const completedToggle = document.getElementById("toggleCompletedRows");
  if (completedToggle) {
    completedToggle.addEventListener("change", applyCompletedRowsToggle);
  }

  /* =========================
     TREND ANALYSIS MODAL + VIEW NAV (ARROWS)
  ========================== */

  // Expect these globals to exist (defined once elsewhere):
  // TREND_VIEWS, currentTrendView, renderTrendView(), updateTrendNavigation(), destroyTrendVisuals()
  // And your chart/treemap/wordcloud renderers:
  // generateMissingFieldsTrendChart(), renderTreemap(), renderWordCloud()

  /* =========================
   TREND ANALYSIS MODAL
========================== */

  const trendBtn = document.getElementById("trendAnalysisBtn");
  if (trendBtn) {
    trendBtn.addEventListener("click", () => {
      // Use the same filtered set you show in the table
      openTrendModal(displayRecords);
    });
  }

  const closeTrendModalBtn = document.getElementById("closeTrendModal");
  if (closeTrendModalBtn) {
    closeTrendModalBtn.addEventListener("click", closeTrendModalAndCleanup);
  }

  /* =========================
   TREND VIEW NAVIGATION
========================== */

  const prevBtn = document.getElementById("trendPrev");
  const nextBtn = document.getElementById("trendNext");

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      const idx = TREND_VIEW_ORDER.indexOf(currentTrendView);
      if (idx > 0) renderTrendView(TREND_VIEW_ORDER[idx - 1], displayRecords);
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      const idx = TREND_VIEW_ORDER.indexOf(currentTrendView);
      if (idx < TREND_VIEW_ORDER.length - 1) {
        renderTrendView(TREND_VIEW_ORDER[idx + 1], displayRecords);
      }
    });
  }

  /* =========================
     DEMOGRAPHICS VISIBILITY
  ========================== */

  const demoToggle = document.getElementById("toggleDemographics");
  if (demoToggle) {
    demoToggle.addEventListener("change", () => {
      showLoader("Updating visibility of patient identifiers...");
      applyDemographicsVisibility();
      setTimeout(hideLoader, 250);
    });
  }

  /* =========================
     DATE INPUTS
  ========================== */

  const fromEl = document.getElementById("fromDate");
  const toEl = document.getElementById("toDate");
  if (fromEl) fromEl.addEventListener("input", updateRunButtonState);
  if (toEl) toEl.addEventListener("input", updateRunButtonState);

  /* =========================
     FINAL SETUP
  ========================== */

  disableHighlightByUI();

  const wm = document.getElementById("welcomeModal");
  if (wm) {
    wm.style.display = "none";
    wm.setAttribute("aria-hidden", "true");
  }

  showAIPlaceholder();
  updateRunButtonState();
  wireInfoBulbBehavior();
}
// 1) Add this helper function (paste anywhere in app.js, outside wireUI/openRecordPanel)
function updateTimestampCell(docId) {
  const toggle = document.querySelector(
    `#tbl .resolvedToggle[data-doc="${CSS.escape(docId)}"]`
  );
  if (!toggle) return;

  const row = toggle.closest("tr");
  if (!row) return;

  const ts = getReviewedTimestamp(docId);
  const formatted = ts ? new Date(ts).toLocaleString() : "-";

  const tds = row.querySelectorAll("td");
  const timestampTd = tds[tds.length - 1]; // Timestamp column is last
  if (timestampTd) timestampTd.textContent = formatted;
}

function wireInfoBulbBehavior() {
  const bulb = document.querySelector(".info-bulb");
  const subtitle = document.getElementById("trendHeaderSubtitle");
  if (!bulb || !subtitle) return;

  let isOpen = false;
  let fullHtml = "";

  const HOVER_HINT = "What are you seeing?";

  // Hover → hint only
  bulb.addEventListener("mouseenter", () => {
    if (isOpen) return;
    subtitle.textContent = HOVER_HINT;
  });

  bulb.addEventListener("mouseleave", () => {
    if (isOpen) return;
    subtitle.textContent = "Graph Insights.";
  });

  // Click → full explanation (sticky)
  bulb.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    isOpen = true;
    subtitle.innerHTML = fullHtml || "<b>Graph insights.</b>";
    bulb.classList.add("is-sticky");
  });

  // Click outside → close
  document.addEventListener("click", () => {
    if (!isOpen) return;
    close();
  });

  // ESC → close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  function close() {
    isOpen = false;
    bulb.classList.remove("is-sticky");
    subtitle.textContent = "Graph Insights.";
  }

  // Public API to update explanation
  bulb.__setFullExplanation = (html) => {
    fullHtml = html;
    if (isOpen) subtitle.innerHTML = html;
  };
}

// Help link toggles the welcome modal
const helpLink = document.getElementById("helpLink");
if (helpLink) {
  helpLink.addEventListener("click", function () {
    if (isWelcomeModalOpen()) closeWelcomeModal();
    else openWelcomeModal();
  });
}

// Click outside dialog closes the modal
const welcomeModal = document.getElementById("welcomeModal");
if (welcomeModal) {
  welcomeModal.addEventListener("mousedown", function (e) {
    const dialog = welcomeModal.querySelector(".welcomeDialog");
    if (dialog && !dialog.contains(e.target)) {
      closeWelcomeModal();
    }
  });
}

/* =========================
   Load data + init
========================= */
const MIN_WELCOME_DURATION = 600;
let welcomeStartTime = performance.now();
welcomeStartTime = performance.now();
function hideWelcomeLoaderSafely() {
  const elapsed = performance.now() - welcomeStartTime;
  const remaining = Math.max(0, MIN_WELCOME_DURATION - elapsed);

  setTimeout(() => {
    isInitialLoad = false;
    isStartupComplete = true;
    hideLoader();
  }, remaining);
}
if (localStorage.getItem(HAS_SEEN_START_SCREEN) !== "true") {
  console.log(
    "[StartScreen] showing StartScreen (first visit in this browser)"
  );
  openStartScreenModal();
} else {
  console.log("[StartScreen] StartScreen skipped (already seen)");
}

fetch("./immunization_data.json")
  .then((res) => res.json())
  .then((data) => {
    const quickRangeEl = document.getElementById("quickRange");
    allRecords = Array.isArray(data) ? data : [];
    filteredRecords = allRecords.slice();

    // Date picker init (sets default last 7 days)
    initDatePickers();

    // Render initial table (optional: show all or keep empty)
    applyCompletedRowsToggle();
    updateCounts();

    // Wire handlers
    wireUI();
    wireRealtimeFilters();
    wireViewOptionsDropdown();
    applyLast7DaysRange();
    hideWelcomeLoaderSafely();

    // 🔒 Duplicate ID guard (must run once after DOM is ready)
    [
      "toggleCompletedRows",
      "toggleDemographics",
      "csvBtn",
      "countPill",
    ].forEach((id) => {
      const count = document.querySelectorAll(`#${id}`).length;
      if (count !== 1) {
        console.warn(`ID "${id}" count = ${count}`);
      }
    });
    // 🔒 Guard against inline style regressions
    const aiReport = document.getElementById("aiReport");
    if (aiReport) {
      console.assert(
        !aiReport.hasAttribute("style"),
        "aiReport must not use inline styles"
      );
    }

    const csvBtn = document.getElementById("csvBtn");
    if (csvBtn) {
      csvBtn.addEventListener("click", (e) => {
        e.preventDefault(); // 🔑 important for <a>
        downloadCSV();
      });
    }
    const refreshBtn = document.getElementById("refreshBtn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", (e) => {
        e.preventDefault();
        console.log("[Refresh Button] Click detected");

        // Uncheck "Hide records already reviewed" checkbox
        const completedToggle = document.getElementById("toggleCompletedRows");
        if (completedToggle) {
          completedToggle.checked = false; // Uncheck the checkbox
        }

        // Proceed to reset filters and refresh the data
        resetAllFiltersAndRefresh();
      });
    }

    // ✅ SHOW RIGHT PANE PLACEHOLDER IMMEDIATELY
    showAIPlaceholder();
  })
  .catch((err) => {
    console.error("JSON load failed:", err);
  });

const startScreenEl = document.getElementById("startScreenModal");
if (startScreenEl) {
  const observer = new MutationObserver(() => {
    console.log("[StartScreen] MUTATION hidden=", startScreenEl.hidden);
  });

  observer.observe(startScreenEl, {
    attributes: true,
    attributeFilter: ["hidden", "style", "aria-hidden"],
  });
}
// Function to generate the trend chart using Chart.js

function updateTrendHeader(view) {
  const titleEl = document.getElementById("trendHeaderTitle");
  const subtitleEl = document.getElementById("trendHeaderSubtitle");
  if (!titleEl || !subtitleEl) return;

  if (view === TREND_VIEWS.BAR) {
    titleEl.textContent = "Missing Documentation Trends";
  } else if (view === TREND_VIEWS.TREEMAP) {
    titleEl.textContent = "Documentation Gap Concentration";
  } else if (view === TREND_VIEWS.LOT_TABLE) {
    titleEl.textContent = "Weekly Vaccine Lot Usage";
  } else {
    titleEl.textContent = "Graph Insights";
  }

  // 🔒 Subtitle is always neutral until bulb click
  subtitleEl.textContent = "Graph Insights.";
}

function scaleFont(value, min, max) {
  const minSize = 14;
  const maxSize = 48;
  const ratio =
    (Math.sqrt(value) - Math.sqrt(min)) / (Math.sqrt(max) - Math.sqrt(min));
  return minSize + ratio * (maxSize - minSize);
}
function renderStackedBarEChart(containerId, records) {
  const el = document.getElementById(containerId);
  if (!el) {
    console.error("[StackedBar] container not found:", containerId);
    return;
  }

  console.log("[StackedBar] records:", records.length);

  const chart = echarts.init(el);

  // Aggregate missing fields by date
  const byDate = {};

  records.forEach((r) => {
    const date = r.administered_date?.split("T")[0];
    if (!date) return;

    if (!byDate[date]) {
      byDate[date] = {
        vfc: 0,
        funding: 0,
        race: 0,
        ethnicity: 0,
        contact: 0,
      };
    }

    if (!r.vfc_status) byDate[date].vfc++;
    if (!r.funding_source) byDate[date].funding++;
    if (!r.race) byDate[date].race++;
    if (!r.ethnicity) byDate[date].ethnicity++;
    if (!r.email || !r.mobile) byDate[date].contact++;
  });

  const dates = Object.keys(byDate).sort();

  const option = {
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
    },
    legend: {
      bottom: 0,
      data: [
        "Missing VFC",
        "Missing Funding",
        "Missing Race",
        "Missing Ethnicity",
        "Missing Contact",
      ],
    },
    grid: {
      left: "3%",
      right: "4%",
      bottom: "12%",
      containLabel: true,
    },
    xAxis: {
      type: "value",
      name: "Records",
    },
    yAxis: {
      type: "category",
      data: dates,
    },
    series: [
      {
        name: "Missing VFC",
        type: "bar",
        stack: "total",
        data: dates.map((d) => byDate[d].vfc),
      },
      {
        name: "Missing Funding",
        type: "bar",
        stack: "total",
        data: dates.map((d) => byDate[d].funding),
      },
      {
        name: "Missing Race",
        type: "bar",
        stack: "total",
        data: dates.map((d) => byDate[d].race),
      },
      {
        name: "Missing Ethnicity",
        type: "bar",
        stack: "total",
        data: dates.map((d) => byDate[d].ethnicity),
      },
      {
        name: "Missing Contact",
        type: "bar",
        stack: "total",
        data: dates.map((d) => byDate[d].contact),
      },
    ],
  };

  chart.setOption(option);

  window.__activeECharts = window.__activeECharts || {};
  window.__activeECharts[containerId] = chart;
}

function renderTreemapEChart(containerId, records) {
  const el = document.getElementById(containerId);
  if (!el) {
    console.error("[Treemap] container not found:", containerId);
    return;
  }

  console.log("[Treemap] records:", records.length);

  const chart = echarts.init(el);

  const summary = {
    "Missing VFC": 0,
    "Missing Funding": 0,
    "Missing Race": 0,
    "Missing Ethnicity": 0,
    "Missing Mobile": 0,
    "Missing Email": 0,
  };

  records.forEach((r) => {
    if (!r.vfc_status) summary["Missing VFC"]++;
    if (!r.funding_source) summary["Missing Funding"]++;
    if (!r.race) summary["Missing Race"]++;
    if (!r.ethnicity) summary["Missing Ethnicity"]++;
    if (!r.mobile) summary["Missing Mobile"]++;
    if (!r.email) summary["Missing Email"]++;
  });

  const data = Object.entries(summary)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value }));

  const option = {
    tooltip: {
      formatter: "{b}: {c} records",
    },
    series: [
      {
        type: "treemap",
        data,
        roam: false,
        label: {
          show: true,
          formatter: "{b}\n\n{c}",
        },
        itemStyle: {
          borderColor: "#ffffff",
          borderWidth: 2,
          gapWidth: 2,
        },
      },
    ],
  };

  chart.setOption(option);

  window.__activeECharts = window.__activeECharts || {};
  window.__activeECharts[containerId] = chart;
}

function renderWeeklyLotUsageTable(records) {
  console.log("[LotTable] render called");
  console.log("[LotTable] records:", records?.length);

  if (!Array.isArray(records) || records.length === 0) {
    console.warn("[LotTable] no records");
    return;
  }

  const container = document.getElementById("lotUsageTable");
  if (!container) {
    console.error("[LotTable] container not found");
    return;
  }

  // -----------------------------
  // 1. Aggregate: Lot × Week
  // -----------------------------
  const matrix = {};
  const weeks = new Set();
  const lots = new Set();
  const lotVaccines = {};

  records.forEach((r) => {
    if (!r.administered_date || !r.lot_number) return;

    const week = getWeekLabel(r.administered_date);
    const lot = r.lot_number.trim();
    const vaccine = r.vaccine_name?.trim() || "Unknown Vaccine";

    weeks.add(week);
    lots.add(lot);

    // Track counts
    const key = `${lot}||${week}`;
    matrix[key] = (matrix[key] || 0) + 1;

    // Track vaccines per lot
    if (!lotVaccines[lot]) lotVaccines[lot] = new Set();
    lotVaccines[lot].add(vaccine);
  });

  const weekList = Array.from(weeks).sort(
    (a, b) => new Date(a.split("–")[0]) - new Date(b.split("–")[0])
  );

  const lotList = Array.from(lots).sort();
  const maxValue = Math.max(1, ...Object.values(matrix));

  // -----------------------------
  // 2. Build table HTML
  // -----------------------------
  let html = `<table class="lot-heat-table">`;

  // Header
  html += `<thead><tr><th>Lot #</th>`;
  weekList.forEach((w) => {
    html += `<th>${w}</th>`;
  });
  html += `</tr></thead><tbody>`;

  // Rows
  lotList.forEach((lot) => {
    // -----------------------------
    // 🔍 Lot quality heuristics
    // -----------------------------
    const totalForLot = weekList.reduce(
      (sum, w) => sum + (matrix[`${lot}||${w}`] || 0),
      0
    );

    const activeWeeks = weekList.filter((w) => matrix[`${lot}||${w}`]).length;

    const isOneOff = totalForLot === 1;
    const singleWeek = activeWeeks === 1;
    const suspiciousFormat = /[^a-zA-Z0-9-]/.test(lot);

    const possibleTypo = isOneOff || singleWeek || suspiciousFormat;

    html += `
      <tr class="${possibleTypo ? "lot-risk" : ""}">
        <td class="lot-label">
          ${escapeHtml(lot)}
          ${
            possibleTypo
              ? '<span class="lot-flag">⚠</span>'
              : "<span>   </span>"
          }
        </td>
    `;

    const vaccineList = Array.from(lotVaccines[lot] || []);

    weekList.forEach((week) => {
      const value = matrix[`${lot}||${week}`] || 0;
      const intensity = Math.min(1, Math.sqrt(value / maxValue));

      const tooltip = value
        ? `
Vaccine: ${vaccineList.join(", ")}
Lot: ${lot}
Week: ${week}
Administrations: ${value}
${possibleTypo ? "⚠ Possible lot typo (single or inconsistent usage)" : ""}
`
        : "";

      html += `<td class="lot-cell ${
        possibleTypo && value ? "lot-risk-cell" : ""
      }" style="background-color: rgba(37, 99, 235, ${intensity})" title="${tooltip.replace(
        /"/g,
        "&quot;"
      )}">${value || ""}</td>`;
    });

    html += `</tr>`;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;

  console.log(
    "[LotTable] rendered lots:",
    lotList.length,
    "weeks:",
    weekList.length
  );
}

