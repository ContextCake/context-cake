const sampleData = {
  selectedId: "sig-1",
  signals: [
    {
      id: "sig-1",
      route: "review_required",
      repo: "billing-api",
      source: "merged PR",
      title: "Payment webhook retry runbook after incident",
      confidence: 0.92,
      owner: "Platform",
      destination: "runbooks/payment-webhook-retries",
      reasons: ["review:label:incident", "review:keyword:payment", "team:label:runbook"],
      action: "Owner review before shared runbook update."
    },
    {
      id: "sig-2",
      route: "team_candidate",
      repo: "web-app",
      source: "repeated question",
      title: "Where feature flags are evaluated",
      confidence: 0.81,
      owner: "Frontend",
      destination: "systems/web-app/feature-flags",
      reasons: ["team:signal:repeated_question_count:5", "team:keyword:onboarding"],
      action: "Draft system note automatically."
    },
    {
      id: "sig-3",
      route: "review_required",
      repo: "identity-service",
      source: "changed files",
      title: "JWT audience contract changed for internal clients",
      confidence: 0.88,
      owner: "Identity",
      destination: "interfaces/jwt-audience-contract",
      reasons: ["review:keyword:auth", "review:keyword:contract", "review:path:auth/"],
      action: "Require interface owner decision."
    },
    {
      id: "sig-4",
      route: "team_candidate",
      repo: "data-pipeline",
      source: "merged PR",
      title: "Deprecate legacy export job after migration",
      confidence: 0.74,
      owner: "Data",
      destination: "decisions/deprecate-legacy-export-job",
      reasons: ["team:keyword:deprecation", "team:keyword:migration"],
      action: "Draft decision entry."
    },
    {
      id: "sig-5",
      route: "ignore",
      repo: "mobile-api",
      source: "merged PR",
      title: "Bump test fixture snapshots",
      confidence: 0.86,
      owner: "API",
      destination: null,
      reasons: ["ignore:keyword:snapshot update", "ignore:label:test-only"],
      action: "Keep in repo history only."
    }
  ],
  repos: [
    { name: "billing-api", coverage: 68, risk: "incident runbooks" },
    { name: "identity-service", coverage: 61, risk: "interface docs" },
    { name: "web-app", coverage: 74, risk: "onboarding answers" },
    { name: "data-pipeline", coverage: 57, risk: "migration decisions" },
    { name: "mobile-api", coverage: 82, risk: "healthy" }
  ]
};

const state = {
  filter: "attention",
  query: "",
  selectedId: sampleData.selectedId,
  signals: sampleData.signals,
  repos: sampleData.repos
};

const queue = document.querySelector("#queue");
const detail = document.querySelector("#detail");
const coverage = document.querySelector("#coverage");
const searchInput = document.querySelector("#searchInput");
const queueTitle = document.querySelector("#queueTitle");
const queueEyebrow = document.querySelector("#queueEyebrow");

document.querySelectorAll(".route-tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll(".route-tab").forEach((item) => item.classList.toggle("is-active", item === button));
    ensureSelectedInFilter();
    render();
  });
});

searchInput.addEventListener("input", (event) => {
  state.query = event.target.value.toLowerCase();
  ensureSelectedInFilter();
  renderQueue();
  renderDetail();
});

init();

// Load generated signals.json when served; fall back to bundled sample data
// when opened directly via file:// so the dashboard always renders something.
async function init() {
  try {
    const response = await fetch("./signals.json", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.signals) && data.signals.length > 0) {
        state.signals = data.signals;
        if (Array.isArray(data.repos) && data.repos.length > 0) {
          state.repos = data.repos;
        }
        state.selectedId = data.selectedId ?? data.signals[0].id;
        setDataStatus(`Live · generated ${formatTimestamp(data.generatedAt)}`);
      }
    }
  } catch (error) {
    // No generated signals.json reachable (file:// or not yet ingested) — keep sample data.
  }
  ensureSelectedInFilter();
  render();
}

function setDataStatus(text) {
  const node = document.querySelector("#dataStatus");
  if (node) node.textContent = text;
}

function formatTimestamp(value) {
  if (!value) return "now";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "now" : date.toLocaleString();
}

function render() {
  renderCounts();
  renderQueueHeader();
  renderQueue();
  renderDetail();
  renderCoverage();
}

function renderCounts() {
  const attention = countByRoute("review_required");
  const captured = countByRoute("team_candidate");
  const ignored = countByRoute("ignore");

  document.querySelector("#attentionCount").textContent = attention;
  document.querySelector("#capturedCount").textContent = captured;
  document.querySelector("#ignoredCount").textContent = ignored;
  document.querySelector("#statusQueued").textContent = attention;
  document.querySelector("#statusCaptured").textContent = captured;
  document.querySelector("#statusIgnored").textContent = ignored;
}

function renderQueueHeader() {
  const copy = {
    attention: ["Review queue", "Signals Needing Judgment"],
    captured: ["Auto-captured", "Stored or Drafted Context"],
    ignored: ["Discarded", "Signals Kept Out"]
  };
  queueEyebrow.textContent = copy[state.filter][0];
  queueTitle.textContent = copy[state.filter][1];
}

function renderQueue() {
  const signals = filteredSignals();

  if (signals.length === 0) {
    queue.innerHTML = '<div class="empty">No matching signals</div>';
    return;
  }

  queue.innerHTML = signals.map((signal) => `
    <button class="signal ${signal.id === state.selectedId ? "is-selected" : ""}" data-id="${signal.id}" data-route="${signal.route}">
      <span>
        <h3 class="signal__title">${escapeHtml(signal.title)}</h3>
        <p class="signal__meta">${escapeHtml(signal.repo)} / ${escapeHtml(signal.source)} / ${escapeHtml(signal.owner)}</p>
        <p class="signal__reason">${escapeHtml(signal.action)}</p>
      </span>
      <span class="signal__score">
        <span class="badge ${badgeClass(signal.route)}">${routeLabel(signal.route)}</span>
        <span class="confidence">${Math.round(signal.confidence * 100)}%</span>
      </span>
    </button>
  `).join("");

  queue.querySelectorAll(".signal").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.id;
      renderQueue();
      renderDetail();
    });
  });
}

function renderDetail() {
  const signal = selectedSignal();
  const detailCard = document.querySelector(".detail-card");

  if (!signal) {
    detail.innerHTML = '<div class="empty">Select a signal</div>';
    detailCard.style.borderTopColor = "";
    return;
  }

  detailCard.style.borderTopColor = routeColor(signal.route);
  detail.innerHTML = `
    <h2 class="detail-title">${escapeHtml(signal.title)}</h2>
    <p class="detail-meta">
      <span class="badge ${badgeClass(signal.route)}">${routeLabel(signal.route)}</span>
      <span class="badge">${escapeHtml(signal.repo)}</span>
      <span class="badge">${Math.round(signal.confidence * 100)}% confidence</span>
    </p>
    <p><strong>Owner</strong><br>${escapeHtml(signal.owner)}</p>
    <p><strong>Destination</strong><br>${escapeHtml(signal.destination ?? "No shared context write")}</p>
    <p><strong>Routing reasons</strong></p>
    <ul class="reason-list">
      ${signal.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}
    </ul>
    <div class="detail-actions">
      <button class="action action--primary" data-action="capture">Store context</button>
      <button class="action" data-action="review">Keep in review</button>
      <button class="action action--danger" data-action="ignore">Discard signal</button>
    </div>
  `;

  detail.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => applyAction(button.dataset.action));
  });
}

function renderCoverage() {
  coverage.innerHTML = state.repos.map((repo) => `
    <div class="repo-node">
      <div class="repo-node__top">
        <span>
          <strong>${escapeHtml(repo.name)}</strong>
          <em>${escapeHtml(repo.risk)}</em>
        </span>
        <span class="repo-node__score">${repo.coverage}%</span>
      </div>
      <div class="meter" aria-label="${escapeHtml(repo.name)} coverage ${repo.coverage}%">
        <span style="width: ${repo.coverage}%"></span>
      </div>
    </div>
  `).join("");
}

function applyAction(action) {
  const signal = selectedSignal();
  if (!signal) return;

  if (action === "capture") {
    signal.route = "team_candidate";
    signal.action = "Stored in shared context feed.";
  }
  if (action === "review") {
    signal.route = "review_required";
    signal.action = "Owner review before shared update.";
  }
  if (action === "ignore") {
    signal.route = "ignore";
    signal.action = "Kept in repo history only.";
  }

  state.filter = routeToFilter(signal.route);
  syncActiveTab();
  render();
}

function filteredSignals() {
  const route = filterToRoute(state.filter);
  return state.signals.filter((signal) => {
    const haystack = `${signal.repo} ${signal.owner} ${signal.title} ${signal.reasons.join(" ")}`.toLowerCase();
    return signal.route === route && (!state.query || haystack.includes(state.query));
  });
}

function ensureSelectedInFilter() {
  const visible = filteredSignals();
  if (!visible.some((signal) => signal.id === state.selectedId)) {
    state.selectedId = visible[0]?.id ?? null;
  }
}

function selectedSignal() {
  return state.signals.find((signal) => signal.id === state.selectedId) ?? filteredSignals()[0] ?? null;
}

function countByRoute(route) {
  return state.signals.filter((signal) => signal.route === route).length;
}

function filterToRoute(filter) {
  if (filter === "attention") return "review_required";
  if (filter === "captured") return "team_candidate";
  if (filter === "ignored") return "ignore";
  return "local";
}

function routeToFilter(route) {
  if (route === "review_required") return "attention";
  if (route === "team_candidate") return "captured";
  if (route === "ignore") return "ignored";
  return "attention";
}

function syncActiveTab() {
  document.querySelectorAll(".route-tab").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.filter === state.filter);
  });
}

function routeLabel(route) {
  if (route === "review_required") return "Review";
  if (route === "team_candidate") return "Captured";
  if (route === "ignore") return "Discard";
  return "Local";
}

function routeColor(route) {
  if (route === "review_required") return "oklch(66% 0.15 68)";
  if (route === "team_candidate") return "oklch(54% 0.13 150)";
  if (route === "ignore") return "oklch(48% 0.035 245)";
  return "oklch(55% 0.13 245)";
}

function badgeClass(route) {
  if (route === "review_required") return "badge--review";
  if (route === "team_candidate") return "badge--captured";
  if (route === "ignore") return "badge--ignored";
  return "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
