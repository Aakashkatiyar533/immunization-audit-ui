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
 *    - Bar chart (Chart.js)
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
let missingChart = null;
let displayRecords = []; // what the table is currently showing (after toggles)
let fromPicker = null;
let toPicker = null;

/* =========================
   Guidance + Scoring
========================= */
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
function riskClassFromRecord(r) {
  if (!r.vfc_status || !r.funding_source) return "high";
  if (!r.lot_number || !r.ndc) return "medium";
  if (!r.email || !r.mobile) return "low";
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

function isChild(age) {
  return age !== null && age !== undefined && Number(age) < 19;
}

function isVfcEligible(vfcStatus) {
  return vfcStatus && vfcStatus.startsWith("V0") && vfcStatus !== "V01";
}

function isPublicFunding(funding) {
  return ["VXC50", "VXC51", "VXC52"].includes(funding);
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
  const cb = document.getElementById("toggleCompletedRows");
  const hideComplete = cb ? cb.checked : false;

  if (hideComplete) {
    displayRecords = (filteredRecords || []).filter(
      (r) => !isCompleteRecord(r)
    );
  } else {
    displayRecords = (filteredRecords || []).slice();
  }

  renderTable(displayRecords);
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

/* =========================
   Toasts (5 seconds + pause on hover)
========================= */
function showToast(message, type) {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type || "info"}`;
  toast.textContent = message;

  container.appendChild(toast);

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

function evaluateRecordSeverity(record) {
  const issues = [];

  // HIGH: Required vaccine identifiers
  if (!record.lot_number) {
    issues.push({ field: "lot_number", severity: SEVERITY.HIGH });
  }
  if (!record.ndc) {
    issues.push({ field: "ndc", severity: SEVERITY.HIGH });
  }

  // MEDIUM: Expiration sanity
  if (record.expiration_date && record.administered_date) {
    if (record.expiration_date < record.administered_date) {
      issues.push({ field: "expiration_date", severity: SEVERITY.MEDIUM });
    }
  }

  // MEDIUM: VFC vs Age
  if (isVfcEligible(record.vfc_status) && !isChild(record.age)) {
    issues.push({ field: "vfc_status", severity: SEVERITY.MEDIUM });
  }

  // MEDIUM: VFC vs Funding
  if (
    isVfcEligible(record.vfc_status) &&
    !isPublicFunding(record.funding_source)
  ) {
    issues.push({ field: "funding_source", severity: SEVERITY.MEDIUM });
  }

  // LOW: Demographic completeness
  if (!record.race) {
    issues.push({ field: "race", severity: SEVERITY.LOW });
  }
  if (!record.ethnicity) {
    issues.push({ field: "ethnicity", severity: SEVERITY.LOW });
  }

  return issues;
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

    const risk = riskClassFromRecord(r);
    if (risk) tr.classList.add(risk);

    // Reviewed state
    if (isReviewed(r.doc_id)) tr.classList.add("resolved");

    tr.innerHTML = `
      <td>
  <a href="#" class="docLink" data-doc="${escapeHtml(r.doc_id)}">${escapeHtml(
      r.doc_id
    )}</a>
</td>
<td>${escapeHtml(r.patient_id)}</td>

      <td>${escapeHtml(r.administered_date)}</td>
      <td>${escapeHtml(r.vaccine_name)}</td>

      <td>${escapeHtml(r.vfc_status || "")}</td>
      <td>${escapeHtml(r.funding_source || "")}</td>

      <td>${escapeHtml(r.quantity)}</td>
      <td>${escapeHtml(r.units)}</td>

      <td>${escapeHtml(r.ndc || "")}</td>
      <td>${escapeHtml(r.lot_number || "")}</td>
      <td>${escapeHtml(r.expiration_date || "")}</td>

      <td>${escapeHtml(r.status)}</td>
      <td class="demographics">${escapeHtml(r.age || "")}</td>
      <td class="demographics">${escapeHtml(r.mobile || "")}</td>
      <td class="demographics">${escapeHtml(r.email || "")}</td>

      <td style="text-align:center;">
        <input
          type="checkbox"
          class="resolvedToggle"
          data-doc="${escapeHtml(r.doc_id)}"
          ${isReviewed(r.doc_id) ? "checked" : ""}
        />
      </td>
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
  if (!report) return;

  report.innerHTML = `
    <h3>Ready to review immunization data?</h3>
    <p style="font-size:12px;color:#555;">
      Select a date range and click <b>Run report</b> to generate the summary and chart.
    </p>
  `;

  const canvas = document.getElementById("missingChart");
  if (canvas) canvas.style.display = "none";
}

function showAIResults() {
  const canvas = document.getElementById("missingChart");
  if (canvas) canvas.style.display = "block";
}

/* =========================
   Explainable AI (summary + chart)
   - Bar values on bars (Chart.js datalabels plugin if present)
   - Dynamic bar colors for high values
========================= */
function runExplainableAI(records, from, to) {
  const report = document.getElementById("aiReport");
  if (!report) return;

  const total = records.length;
  const miss = (f) => records.filter((r) => !r[f]).length;

  const lotMissing = miss("lot_number");
  const ndcMissing = miss("ndc");
  const vfcMissing = miss("vfc_status");
  const fundingMissing = miss("funding_source");
  const emailMissing = miss("email");
  const mobileMissing = miss("mobile");

  report.innerHTML = `
    <div class="reportInner">
      <p><b>Date range:</b> ${escapeHtml(from)} to ${escapeHtml(to)}</p>
      <p><b>Records identified:</b> ${total}</p>

      <p>
        This summary highlights missing or high-risk immunization fields that can affect registry acceptance,
        reporting quality, and inventory decrement workflows.
      </p>

      <ul>
        <li>Missing Lot: ${lotMissing}</li>
        <li>Missing NDC: ${ndcMissing}</li>
        <li>Missing VFC: ${vfcMissing}</li>
        <li>Missing Funding: ${fundingMissing}</li>
        <li>Missing Email: ${emailMissing}</li>
        <li>Missing Mobile: ${mobileMissing}</li>
      </ul>

      <p style="font-size:12px;color:#555;">
        Tip: Click a Document ID to see why a missing field matters and what to fix in the EHR.
      </p>
    </div>
  `;

  drawMissingChart({
    lot: lotMissing,
    ndc: ndcMissing,
    vfc: vfcMissing,
    funding: fundingMissing,
    email: emailMissing,
    mobile: mobileMissing,
  });
}

function drawMissingChart(counts) {
  const canvas = document.getElementById("missingChart");
  if (!canvas) return;

  if (missingChart) {
    missingChart.destroy();
    missingChart = null;
  }

  const labels = ["Lot", "NDC", "VFC", "Funding", "Email", "Mobile"];
  const values = [
    counts.lot,
    counts.ndc,
    counts.vfc,
    counts.funding,
    counts.email,
    counts.mobile,
  ];

  const maxVal = Math.max(0, ...values);
  const yMax = Math.max(5, Math.ceil(maxVal * 1.2)); // dynamic Y range

  // Color changes when value is high relative to max
  function barColor(v) {
    if (maxVal <= 0) return "#6b7280";
    if (v >= maxVal * 0.75) return "#d32f2f"; // high
    if (v >= maxVal * 0.4) return "#f57c00"; // medium
    return "#1976d2"; // low
  }

  const colors = values.map(barColor);

  missingChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: false },
        // If chartjs-plugin-datalabels exists, show values on bars
        datalabels: {
          anchor: "end",
          align: "end",
          formatter: (v) => (typeof v === "number" ? String(v) : ""),
          clamp: true,
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          suggestedMax: yMax,
        },
      },
    },
  });
}

/* =========================
   Record Guidance panel (modal)
   - Includes Race/Ethnicity here (no header mismatch)
========================= */
function openRecordPanel(rec) {
  const panel = document.getElementById("recordPanel");
  if (!panel) return;

  // ---- Feature 1: Severity-driven record issues ----
  const issues = evaluateRecordSeverity(rec);

  const reviewed = isReviewed(rec.doc_id);
  const reviewedTs = getReviewedTimestamp(rec.doc_id);

  const missingList = issues.length
    ? issues
        .map((issue) => {
          const g = FIELD_GUIDANCE[issue.field];
          const label = g ? g.label : issue.field;

          const severityLabel =
            issue.severity === SEVERITY.HIGH
              ? "High impact"
              : issue.severity === SEVERITY.MEDIUM
              ? "Medium impact"
              : "Low impact";

          return `
          <li>
            ${escapeHtml(label)}
            <span class="sevTag sev${escapeHtml(issue.severity)}">
              ${severityLabel}
            </span>
          </li>
        `;
        })
        .join("")
    : "<li>No missing or high-risk elements detected.</li>";

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
    : "<li>No guidance items to show.</li>";

  // Provider-friendly reviewed text
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

  <button class="rgCloseBtn rgCloseX" id="closePanelBtn" type="button" aria-label="Close record guidance">
  <svg viewBox="0 0 24 24" class="rgCloseIcon" aria-hidden="true">
    <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>
</button>
</div>

      <div class="rgBody">
        <div class="sectionTitle blueInfo">Patient & Visit Summary</div>
        <div class="kv"><b>Doc ID (Order):</b> ${escapeHtml(rec.doc_id)}</div>
        <div class="kv"><b>Patient ID:</b> ${escapeHtml(rec.patient_id)}</div>
        <div class="kv"><b>Age:</b> ${escapeHtml(rec.age || "")} yrs</div>
        <div class="kv"><b>Race / Ethnicity:</b> ${escapeHtml(
          rec.race || ""
        )} / ${escapeHtml(rec.ethnicity || "")}</div>
        <div class="kv"><b>Status:</b> ${escapeHtml(rec.status || "")}</div>

        <div class="kv"><b>Vaccine:</b> ${escapeHtml(
          rec.vaccine_name || ""
        )}</div>
        <div class="kv"><b>Admin Date:</b> ${escapeHtml(
          rec.administered_date || ""
        )}</div>
        <div class="kv">
  <b>Review status:</b>
  <span class="reviewStatus ${reviewed ? "isReviewed" : "needsReview"}">
    ${reviewed ? "Reviewed" : "Needs review"}
  </span>
  ${reviewedLine ? `<span class="hintText">(${reviewedLine})</span>` : ""}
</div>

        <div class="sectionTitle blueInfo reportWarningLegend"><div class="legendTitle">⚠ Missing or risky elements</div>
        <ul class="list">${missingList}</ul>
        </div>
        

        <div class="sectionTitle blueInfo">Why this matters</div>
        <ul class="list">${
          guidanceItems || "<li>No guidance items to show.</li>"
        }</ul>
      </div>

      <!-- Actions -->
      <div class="rgActions reviewActionRow">
        <button
          class="btn reviewBtn ${reviewed ? "reviewed" : "needsReview"}"
          id="toggleResolvedBtn"
          type="button"
        >
          ${reviewed ? "Reviewed" : "Mark as reviewed"}
        </button>

        <span class="reviewHint">
          <span class="infoIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24" class="infoIcon">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
              <line x1="12" y1="10" x2="12" y2="16" stroke="currentColor" stroke-width="2"/>
              <circle cx="12" cy="7" r="1.2" fill="currentColor"/>
            </svg>
          </span>
          ${
            reviewed
              ? "Reviewed means this record has been verified and corrected in the EHR."
              : "Mark as reviewed after correcting this record in the EHR."
          }
        </span>
      </div>
    </div>
  `;

  // Show and focus
  panel.style.display = "flex";

  requestAnimationFrame(() => {
    panel.classList.remove("isClosing");
    panel.classList.add("isOpen");
    panel.setAttribute("aria-hidden", "false");
    panel.setAttribute("tabindex", "-1");
    panel.focus();
  });

  const closeBtn = document.getElementById("closePanelBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", closeRecordPanel);
  }

  const toggleBtn = document.getElementById("toggleResolvedBtn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", function () {
      const next = !isReviewed(rec.doc_id);
      setReviewed(rec.doc_id, next);

      // 🔑 Update table row directly
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

      // Toast feedback
      if (next) {
        showToast(`Reviewed: ${rec.doc_id}`, "success");
      } else {
        showToast(`Need to review: ${rec.doc_id}`, "info");
      }
    });
  }
}

function closeRecordPanel() {
  const panel = document.getElementById("recordPanel");
  if (!panel) return;

  panel.classList.remove("isOpen");
  panel.classList.add("isClosing");

  setTimeout(() => {
    panel.style.display = "none";
    panel.setAttribute("aria-hidden", "true");
    panel.classList.remove("isClosing");
  }, 250);
}

/* =========================
   CSV export
   - Includes Race/Ethnicity in export
========================= */
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

  URL.revokeObjectURL(url);
}

/* =========================
   Counts pill
========================= */
function updateCounts() {
  const pill = document.getElementById("countPill");
  if (!pill) return;

  const total = (filteredRecords || []).length;
  const shown = (displayRecords || []).length;

  const hideComplete = document.getElementById("toggleCompletedRows")?.checked;

  pill.textContent = hideComplete
    ? `${shown} of ${total} records`
    : `${shown} records`;
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
    },
  });

  toPicker = flatpickr("#toDate", {
    dateFormat: "Y-m-d",
    allowInput: true,
    maxDate,
    onChange: () => {
      ensureFromToOrder();
      updateRunButtonState();
    },
  });

  // Default last 7 days
  applyQuickRange(7);

  handleTodayShortcut("fromDate", fromPicker);
  handleTodayShortcut("toDate", toPicker);

  const quick = document.getElementById("quickRange");
  if (quick) {
    quick.addEventListener("change", function () {
      const v = quick.value;
      if (v === "7") applyQuickRange(7);
      if (v === "30") applyQuickRange(30);
    });
  }
}

/* =========================
   Report run (generateAI)
   - Loader staged messages
   - 5 second overall delay so user can see “Running…”
   - Keeps “Filter by missing” (filterMissing)
========================= */
function generateAI() {
  // Hide welcome modal once user runs the report
  dismissWelcomeModalOnRun();
  // Show animated chart bars
  const barsWrapper = document.querySelector(".chartBarsWrapper");
  if (barsWrapper) {
    barsWrapper.style.display = "flex";
  }

  const runBtn = document.getElementById("runBtn");
  const from = document.getElementById("fromDate")?.value || "";
  const to = document.getElementById("toDate")?.value || "";
  const filter = document.getElementById("filterMissing")?.value || "all";

  if (!from || !to) {
    alert("Select a date range");
    updateRunButtonState();
    return;
  }

  // Start run state
  setFiltersEnabled(false);
  setRunButtonState(true, "Running…");

  // Stage messages for perceived progress
  showLoader("Analyzing…");

  // Compute candidate set immediately (fast)
  let candidate = allRecords.filter(
    (r) => r.administered_date >= from && r.administered_date <= to
  );

  if (filter !== "all") {
    candidate = candidate.filter((r) => {
      if (filter === "vfc") return !r.vfc_status;
      if (filter === "funding") return !r.funding_source;
      if (filter === "lot") return !r.lot_number;
      if (filter === "ndc") return !r.ndc;
      if (filter === "contact") return !r.email || !r.mobile;
      return true;
    });
  }

  const totalCount = candidate.length;

  // Update message after a short delay
  window.setTimeout(() => {
    showLoader(`Summarizing results (${totalCount} records)…`);
  }, 1200);

  // Preparing table only makes sense if there are records
  if (totalCount > 0) {
    window.setTimeout(() => {
      showLoader("Preparing table…");
    }, 3000);
  }

  // Finish after 5 seconds total
  window.setTimeout(() => {
    // Apply final results
    filteredRecords = candidate;

    applyCompletedRowsToggle();
    updateCounts();

    // AI summary + chart
    showAIResults();
    runExplainableAI(filteredRecords, from, to);

    // Done state
    hideLoader();
    setFiltersEnabled(true);
    setRunButtonState(false, "Run report");

    // If no records, show a prompt (non-blocking)
    if (totalCount === 0) {
      alert(
        `No immunizations were found for the selected period ${from} to ${to}.\nThis may indicate no administrations or a narrow date range.`
      );
    }
  }, 5000);
}

/* =========================
   UI Wiring
========================= */
function wireUI() {
  // Buttons
  const runBtn = document.getElementById("runBtn");
  if (runBtn) runBtn.addEventListener("click", generateAI);

  const csvBtn = document.getElementById("csvBtn");
  if (csvBtn) csvBtn.addEventListener("click", downloadCSV);

  // Help link opens the welcome modal on demand
  const helpLink = document.getElementById("helpLink");
  if (helpLink) {
    helpLink.addEventListener("click", function () {
      openWelcomeModal();
    });
  }
  // Close How-to modal via X
  const closeWelcomeBtn = document.getElementById("closeWelcomeBtn");
  if (closeWelcomeBtn) {
    closeWelcomeBtn.addEventListener("click", function () {
      const modal = document.getElementById("welcomeModal");
      if (!modal) return;

      modal.classList.add("isClosing");

      setTimeout(() => {
        modal.style.display = "none";
        modal.setAttribute("aria-hidden", "true");
        modal.classList.remove("isClosing");
      }, 250); // match CSS transition
    });
  }

  // Table click: patient link opens guidance panel
  const tbody = document.querySelector("#tbl tbody");
  if (tbody) {
    tbody.addEventListener("click", function (e) {
      const a = e.target.closest("a.docLink");
      if (!a) return;

      e.preventDefault();
      const doc = a.getAttribute("data-doc");
      const rec =
        filteredRecords.find((r) => r.doc_id === doc) ||
        allRecords.find((r) => r.doc_id === doc);
      if (rec) openRecordPanel(rec);
    });

    // Reviewed checkbox toggle
    tbody.addEventListener("change", function (e) {
      const chk = e.target.closest(".resolvedToggle");
      if (!chk) return;

      const doc = chk.getAttribute("data-doc");
      const val = chk.checked;
      setReviewed(doc, val);

      // Re-render to apply gray-out
      applyCompletedRowsToggle();
      updateCounts();

      if (val) {
        showToast(`Reviewed: ${doc}`, "success");
      } else {
        showToast(`Need to review: ${doc}`, "info");
      }
    });
  }

  const completedToggle = document.getElementById("toggleCompletedRows");
  if (completedToggle) {
    completedToggle.addEventListener("change", applyCompletedRowsToggle);
  }
  // Demographics hide
  const demoToggle = document.getElementById("toggleDemographics");
  if (demoToggle) {
    demoToggle.addEventListener("change", applyDemographicsVisibility);
  }

  // Date inputs changes (native typing path)
  const fromEl = document.getElementById("fromDate");
  const toEl = document.getElementById("toDate");
  if (fromEl) fromEl.addEventListener("input", updateRunButtonState);
  if (toEl) toEl.addEventListener("input", updateRunButtonState);

  // Remove/disable highlight-by UI
  disableHighlightByUI();

  // Ensure welcome modal is hidden on load (help opens it)
  const wm = document.getElementById("welcomeModal");
  if (wm) {
    wm.style.display = "none";
    wm.setAttribute("aria-hidden", "true");
  }

  // Initial placeholder
  showAIPlaceholder();

  // Initialize run button state on load
  updateRunButtonState();
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
showLoader("Welcome. Preparing immunization documentation review…");
setTimeout(hideLoader, 4000);
fetch("./immunization_data.json")
  .then((res) => res.json())
  .then((data) => {
    allRecords = Array.isArray(data) ? data : [];
    filteredRecords = allRecords.slice();

    // Date picker init (sets default last 7 days)
    initDatePickers();

    // Render initial table (optional: show all or keep empty)
    applyCompletedRowsToggle();
    updateCounts();

    // Wire handlers
    wireUI();
  })
  .catch((err) => {
    console.error("JSON load failed:", err);
  });
