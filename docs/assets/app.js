export function characterAccounting(baseline, delegated) {
  if (!Number.isSafeInteger(baseline) || baseline < 1 || baseline > 1_000_000_000
    || !Number.isSafeInteger(delegated) || delegated < 0 || delegated > 1_000_000_000) {
    throw new RangeError("Use whole character totals within the displayed limits.");
  }
  return {
    baselineTokens: Math.ceil(baseline / 4),
    delegatedTokens: Math.ceil(delegated / 4),
    changePercent: ((baseline - delegated) / baseline) * 100,
  };
}

function initializePage() {
  const root = document.documentElement;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const motionButtons = [...document.querySelectorAll("[data-motion-toggle]")];
  const enableButton = document.getElementById("enable-scene");
  const sceneStatus = document.getElementById("scene-status");
  const sceneFallback = document.getElementById("scene-fallback");
  const sceneMount = document.getElementById("three-canvas-container");
  const sceneMode = document.getElementById("scene-mode-label");
  const sceneControls = document.getElementById("scene-controls");
  const inspectionButtons = [...document.querySelectorAll("[data-scene-stage]")];
  const phaseLabel = document.getElementById("hud-phase-label");
  const phaseDescription = document.getElementById("hud-desc-text");
  const phases = [
    ["1. FULL SOURCE -> WORKER", "Amber source enters the separate worker, not the parent."],
    ["2. WORKER PROCESSES SOURCE", "The corpus is still processed. Only a bounded final result can return."],
    ["3. COMPACT RETURN -> PARENT", "The parent receives compact evidence or a file receipt and keeps its selected model."],
  ];
  let wantsMotion = !reducedMotion.matches;
  let scene = null;
  let sceneAttempt = 0;
  let pendingController = null;

  function clearInspection() {
    for (const button of inspectionButtons) button.setAttribute("aria-pressed", "false");
  }

  function updateMotion() {
    const running = wantsMotion && !reducedMotion.matches;
    root.dataset.motion = running ? "running" : "paused";
    for (const button of motionButtons) {
      button.hidden = false;
      button.disabled = reducedMotion.matches;
      button.textContent = reducedMotion.matches ? "Motion off (system)" : running ? "Pause motion" : "Play motion";
    }
    if (!scene) return;
    scene.setMotion(running);
    if (running) clearInspection();
    sceneStatus.dataset.state = "ready";
    sceneStatus.textContent = reducedMotion.matches
      ? "3D rendered with WebGL. Still frame; your reduced-motion preference is honored."
      : running
        ? "3D rendered with WebGL. Motion is on and automatically pauses offscreen."
        : "3D rendered with WebGL. Motion is paused. Inspect a stage or change the view with the buttons below.";
    sceneMode.textContent = running ? "3D / Illustrative flow, not telemetry" : "3D / Still frame";
  }

  for (const button of motionButtons) {
    button.addEventListener("click", () => {
      if (reducedMotion.matches) return;
      wantsMotion = !wantsMotion;
      updateMotion();
    });
  }
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) wantsMotion = false;
    updateMotion();
  });

  const sceneErrors = {
    cdn: "3D could not load the pinned Three.js CDN module. Check your connection or content-blocking settings.",
    webgl: "This browser could not create a WebGL 2 renderer.",
    render: "The WebGL scene did not pass its render check.",
    "context-lost": "The WebGL context was lost, so the 3D renderer has stopped.",
  };

  function showSceneFailure(message) {
    scene?.dispose();
    scene = null;
    sceneMount.replaceChildren();
    sceneFallback.hidden = false;
    sceneControls.hidden = true;
    clearInspection();
    sceneStatus.dataset.state = "error";
    sceneStatus.textContent = `${message} The static illustration remains available. No 3D scene is running.`;
    sceneMode.textContent = "Static fallback / 3D unavailable";
    phaseLabel.textContent = "STATIC SOURCE / WORKER / PARENT DIAGRAM";
    phaseDescription.textContent = "Full source stays on the worker side. A compact result returns to the parent.";
    enableButton.textContent = "Retry 3D";
    enableButton.disabled = false;
  }

  enableButton.addEventListener("click", async () => {
    if (scene) return;
    pendingController?.abort();
    const controller = new AbortController();
    pendingController = controller;
    const attempt = ++sceneAttempt;
    enableButton.disabled = true;
    enableButton.textContent = "Loading 3D...";
    sceneStatus.dataset.state = "loading";
    sceneStatus.textContent = "Loading the pinned Three.js module from jsDelivr. The static illustration stays until a WebGL render succeeds.";

    // Imports cannot be canceled; a late module must not publish an abandoned scene.
    const timeout = window.setTimeout(() => {
      if (attempt !== sceneAttempt) return;
      controller.abort();
      showSceneFailure("3D loading timed out after 15 seconds.");
    }, 15_000);

    try {
      const { createScene } = await import("./scene.js");
      if (controller.signal.aborted || attempt !== sceneAttempt) return;
      const created = await createScene({
        mount: sceneMount,
        signal: controller.signal,
        onPhaseChange(phase) {
          if (attempt !== sceneAttempt || controller.signal.aborted) return;
          phaseLabel.textContent = phases[phase][0];
          phaseDescription.textContent = phases[phase][1];
        },
        onFailure(error) {
          if (attempt !== sceneAttempt) return;
          showSceneFailure(sceneErrors[error?.code] ?? "The 3D renderer stopped unexpectedly.");
        },
      });
      if (controller.signal.aborted || attempt !== sceneAttempt) {
        created.dispose();
        return;
      }
      scene = created;
      sceneFallback.hidden = true;
      sceneControls.hidden = false;
      enableButton.textContent = "3D enabled";
      enableButton.disabled = true;
      updateMotion();
    } catch (error) {
      if (controller.signal.aborted || attempt !== sceneAttempt) return;
      showSceneFailure(sceneErrors[error?.code] ?? "3D could not be initialized in this browser.");
    } finally {
      window.clearTimeout(timeout);
      if (pendingController === controller) pendingController = null;
    }
  });

  for (const button of inspectionButtons) {
    button.addEventListener("click", () => {
      if (!scene) return;
      const stage = Number(button.dataset.sceneStage);
      const current = scene;
      wantsMotion = false;
      updateMotion();
      clearInspection();
      current.inspect(stage);
      if (scene !== current) return;
      button.setAttribute("aria-pressed", "true");
      sceneStatus.textContent = `${phases[stage][1]} Motion is paused.`;
      sceneMode.textContent = `3D / Inspecting ${["source", "worker", "return"][stage]}`;
    });
  }

  for (const [id, direction] of [["btn-orbit-left", -1], ["btn-orbit-right", 1], ["btn-reset-cam", 0]]) {
    document.getElementById(id).addEventListener("click", () => {
      if (!scene) return;
      const current = scene;
      wantsMotion = false;
      updateMotion();
      current.changeView(direction);
      if (scene === current) sceneStatus.textContent = "Camera view changed. Motion is paused; all scene meanings are also described in the captions.";
    });
  }

  const tabList = document.getElementById("diagram-tabs");
  const tabButtons = [...document.querySelectorAll("[data-view]")];
  const diagramPanels = [...document.querySelectorAll(".diagram-view-content")];
  tabList.setAttribute("role", "tablist");
  for (const button of tabButtons) {
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `diagram-${button.dataset.view}`);
  }
  for (const panel of diagramPanels) {
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `tab-${panel.id.replace("diagram-", "")}`);
  }
  function activateDiagram(index, moveFocus = false) {
    tabButtons.forEach((button, position) => {
      button.setAttribute("aria-selected", String(position === index));
      button.tabIndex = position === index ? 0 : -1;
    });
    for (const panel of diagramPanels) panel.hidden = panel.id !== `diagram-${tabButtons[index].dataset.view}`;
    if (moveFocus) tabButtons[index].focus();
  }
  tabButtons.forEach((button, index) => {
    button.addEventListener("click", () => activateDiagram(index));
    button.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabButtons.length;
      if (event.key === "ArrowLeft") next = (index + tabButtons.length - 1) % tabButtons.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabButtons.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      activateDiagram(next, true);
    });
  });
  activateDiagram(0);
  tabList.hidden = false;
  root.dataset.diagramTabs = "ready";

  const filter = document.getElementById("test-search-filter");
  const testCards = [...document.querySelectorAll(".test-card")];
  const filterStatus = document.getElementById("test-filter-status");
  function filterGroups() {
    const term = filter.value.trim().toLowerCase();
    let visible = 0;
    for (const card of testCards) {
      card.hidden = term !== "" && !card.textContent.toLowerCase().includes(term);
      if (!card.hidden) visible += 1;
    }
    filterStatus.textContent = `${visible} of ${testCards.length} test groups shown.`;
    document.getElementById("test-no-results").hidden = visible !== 0;
  }
  filter.addEventListener("input", filterGroups);
  document.getElementById("clear-test-filter").addEventListener("click", () => {
    filter.value = "";
    filterGroups();
    filter.focus();
  });
  document.getElementById("test-filter-tools").hidden = false;

  // Deep links must not point into a filtered group or an inactive diagram.
  function revealLinkedContent() {
    const hash = window.location.hash;
    const tabIndex = diagramPanels.findIndex((panel) => `#${panel.id}` === hash);
    if (tabIndex >= 0) activateDiagram(tabIndex);
    if (testCards.some((card) => `#${card.id}` === hash)) {
      filter.value = "";
      filterGroups();
    }
  }
  window.addEventListener("hashchange", revealLinkedContent);
  revealLinkedContent();

  const baselineInput = document.getElementById("calc-input-chars");
  const delegatedInput = document.getElementById("calc-delegated-chars");
  const calculatorResults = document.getElementById("calculator-results");
  const calculatorError = document.getElementById("calc-error");
  function recalculate() {
    const baseline = baselineInput.valueAsNumber;
    const delegated = delegatedInput.valueAsNumber;
    const baselineValid = Number.isSafeInteger(baseline) && baseline >= 1 && baseline <= 1_000_000_000;
    const delegatedValid = Number.isSafeInteger(delegated) && delegated >= 0 && delegated <= 1_000_000_000;
    baselineInput.setAttribute("aria-invalid", String(!baselineValid));
    delegatedInput.setAttribute("aria-invalid", String(!delegatedValid));
    if (!baselineValid || !delegatedValid) {
      calculatorResults.hidden = true;
      calculatorError.textContent = "Enter whole counts within the limits. Baseline must be at least 1; delegated may be 0.";
      return;
    }
    const result = characterAccounting(baseline, delegated);
    calculatorResults.hidden = false;
    calculatorError.textContent = "";
    document.getElementById("calc-orig-tokens").textContent = result.baselineTokens.toLocaleString("en-US");
    document.getElementById("calc-reduced-tokens").textContent = result.delegatedTokens.toLocaleString("en-US");
    const difference = result.changePercent;
    document.getElementById("calc-change-pct").textContent = difference === 0
      ? "No change"
      : `${Math.abs(difference).toFixed(2)}% ${difference < 0 ? "higher" : "lower"}`;
    const scale = Math.max(baseline, delegated);
    document.getElementById("calc-original-fill").style.width = `${(baseline / scale) * 100}%`;
    document.getElementById("calc-delegated-fill").style.width = `${(delegated / scale) * 100}%`;
  }
  baselineInput.addEventListener("input", recalculate);
  delegatedInput.addEventListener("input", recalculate);
  document.getElementById("calculator-controls").hidden = false;
  recalculate();

  const copyStatus = document.getElementById("copy-status");
  for (const button of document.querySelectorAll(".copy-code-btn")) {
    if (!navigator.clipboard?.writeText || !window.isSecureContext) continue;
    button.hidden = false;
    let timer;
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.target);
      if (!target) return;
      try {
        await navigator.clipboard.writeText(target.textContent);
        button.textContent = "Copied";
        copyStatus.textContent = "Project installation commands copied.";
        window.clearTimeout(timer);
        timer = window.setTimeout(() => { button.textContent = "Copy"; }, 2_500);
      } catch {
        button.textContent = "Copy";
        copyStatus.textContent = "Clipboard access is unavailable. Select and copy the commands manually.";
      }
    });
  }

  window.addEventListener("pagehide", () => {
    scene?.setMotion(false);
    if (pendingController) {
      pendingController.abort();
      sceneAttempt += 1;
      showSceneFailure("3D loading was canceled while leaving the page.");
    }
  });
  window.addEventListener("pageshow", () => { if (scene) updateMotion(); });
  enableButton.hidden = false;
  updateMotion();
}

if (typeof document !== "undefined") initializePage();
