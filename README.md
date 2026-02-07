# Immunization Audit & Data Quality Tool

A client-side dashboard for reviewing immunization record completeness, registry readiness, and audit risk indicators. Built as a static UI to help providers and teams quickly identify documentation gaps, prioritize cleanup, and validate reporting readiness.

## Live Demo
https://aakashkatiyar533.github.io/immunization-audit-ui/

---

## What this tool does

This tool helps answer practical data quality questions such as:
- Which records are missing required registry fields (VFC eligibility, funding source, race/ethnicity, contact)?
- Which dates or periods show spikes in missing documentation?
- Which records have been reviewed already and when?
- How strong is overall data quality right now (score out of 100)?

---

## Key Features

### Data review table
- Displays immunization records in a structured, scan-friendly table.
- Highlights records by severity (documentation risk).
- “Reviewed” workflow:
  - Mark records as reviewed via checkbox.
  - Reviewed timestamp captured and displayed.
  - Option to hide already reviewed records.
  - Completed records can be auto-disabled (cannot be marked again).

### Filters and controls
- **Date range filtering**
  - From / To date pickers (Flatpickr)
  - Quick ranges: Today, Yesterday, Last 7, Last 14, Last 30, Custom Range
- **Documentation gaps filter**
  - All records
  - Records needing attention
  - Records with no immediate risk
  - Missing VFC eligibility
  - Missing funding source
  - Missing race
  - Missing ethnicity
  - Missing patient contact details
- **Age filter**
  - All
  - Adult
  - Minor
- **View options dropdown**
  - Hide records already reviewed
  - Hide patient identifiers (demographics toggle)

### Explainable “AI-style” insights panel (deterministic)
- Expanding insights panel with “reading” shimmer effect.
- Generates an overview narrative of gaps and risk.
- “Documentation gaps identified” section with animated rendering.
- Trend link to open visual analytics modal.
- Inventory-by-lot section to support lot auditing.

### Data Quality Score (0–100)
- Score computed from weighted completeness:
  - VFC eligibility
  - Funding source
  - Race
  - Ethnicity
  - Contact info (email/mobile)
- Badge color thresholds:
  - **90–100**: Excellent (dark green)
  - **85–89**: Good (lime green)
  - **50–84**: Warning (orange)
  - **<50**: Poor (red)
- Handles empty datasets (resets to `--`).

### Trend Analysis Modal (ECharts)
Interactive charts to visualize documentation issues:
- **Stacked bar chart**: Missing field categories over time (by administered date).
  - Hover highlight behavior (focus series)
  - Optional label suppression for long ranges (clean view)
- **Treemap view**: Concentration of missing fields to show dominant gap categories.
- **VFC eligibility waterfall chart**: Total → types → documented total
  - Codes displayed on axis (V01, V02, etc.)
  - Tooltip explains missing eligibility impact

### Lot inventory analysis
- “Inventory by lot” table:
  - Vaccine, lot, count, first seen, last seen
  - Flags unusual patterns:
    - One-off usage
    - Rare usage
    - Likely typo (near-match to dominant lot per vaccine)
- Horizontal scrolling support when table width exceeds container.

### Start screen onboarding
- Start screen modal for onboarding and guidance.
- “How to use this dashboard” help modal.
- Home button opens the start screen modal for quick reset/orientation.

### Export
- Export table records to Excel/CSV (based on your UI control).

### Accessibility and UI polish
- Adds ARIA labels on inputs and interactive controls.
- Modal behavior designed to be keyboard-friendly.
- Responsive layout support for smaller screens.
- Performance-minded CSS animations (transform-based shimmer).

---

## Tech Stack
- Vanilla JavaScript
- HTML5
- CSS3
- ECharts (visualizations)
- Flatpickr (date picker)
- GitHub Pages (deployment)

---

## Project Structure (typical)
- `index.html` – UI layout and modal containers
- `styles.css` – styling for dashboard, modals, and components
- `app.js` – data load, filtering, rendering, chart logic
- `immunization_data.json` – demo dataset (synthetic or non-PHI only)

---

## Running locally

### Option 1: Python
```bash
python -m http.server 8000
```
Then open:
http://localhost:8000/

### Option 2: live-server
```bash
live-server
```

---

## Notes / Safety

- This is a client-side demonstration tool.
- Do not use PHI in production. Use only synthetic or de-identified data.
