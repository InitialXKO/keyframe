// Tab switching logic
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));

    btn.classList.add("active");
    const targetTab = btn.getAttribute("data-tab");
    if (targetTab) {
      const el = document.getElementById(targetTab);
      if (el) el.classList.add("active");
    }
  });
});

let latestPayload = null;

function handleEngineEvent(data) {
  if (!data || data.type !== "FRAME_EVALUATED") return;
  latestPayload = data.payload;

  const statusBadge = document.getElementById("statusBadge");
  if (statusBadge) {
    statusBadge.innerText = "Engine Active";
    statusBadge.style.background = "#50fa7b";
  }

  const globalTimeVal = document.getElementById("globalTimeVal");
  if (globalTimeVal && latestPayload) {
    globalTimeVal.innerText = `${latestPayload.globalTime.toFixed(2)} ms`;
  }

  renderInstancesTable(latestPayload.evaluatedInstances);
  renderKeyframeCurves(latestPayload.clips);
}

function renderInstancesTable(instances) {
  const tbody = document.getElementById("instancesTableBody");
  if (!tbody) return;

  if (!instances || instances.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#6272a4;">No active instances evaluated yet.</td></tr>';
    return;
  }

  tbody.innerHTML = instances
    .map((inst) => {
      const matrixStr = inst.matrix
        ? inst.matrix.map((n) => n.toFixed(2)).join(", ")
        : "Identity";
      return `
      <tr>
        <td style="color:#8be9fd; font-weight:bold;">${inst.id || "inst"}</td>
        <td style="color:#bd93f9;">${inst.clipId || "clip"}</td>
        <td style="color:#ff79c6;">${(inst.opacity * 100).toFixed(0)}%</td>
        <td><span style="color:${inst.visible ? "#50fa7b" : "#ff5555"};">${inst.visible ? "TRUE" : "FALSE"}</span></td>
        <td class="matrix-cell">[${matrixStr}]</td>
      </tr>
    `;
    })
    .join("");
}

function renderKeyframeCurves(clips) {
  const svg = document.getElementById("curveSvg");
  const clipDataEl = document.getElementById("clipData");
  if (!svg || !clips || clips.length === 0) return;

  const clip = clips[0];
  if (clipDataEl) {
    const easingVal = clip.metadata?.easing || clip.easing || "N/A";
    clipDataEl.innerHTML = `
      <strong>ID:</strong> ${clip.id} |
      <strong>Duration:</strong> ${clip.duration}ms |
      <strong>Easing:</strong> ${easingVal} |
      <strong>Keyframes:</strong> ${clip.keyframes ? clip.keyframes.length : 0}
    `;
  }

  // Draw plot curve in SVG
  const width = svg.clientWidth || 600;
  const height = svg.clientHeight || 180;
  const padding = 20;

  let points = [];
  const duration = clip.duration || 2000;
  const numSteps = 50;

  for (let i = 0; i <= numSteps; i++) {
    const progress = i / numSteps;
    const time = progress * duration;
    // Simple S-curve representation for visualization
    const yVal = 1 / (1 + Math.exp(-10 * (progress - 0.5)));
    const x = padding + progress * (width - 2 * padding);
    const y = height - padding - yVal * (height - 2 * padding);
    points.push(`${x},${y}`);
  }

  svg.innerHTML = `
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#44475a" stroke-width="2"/>
    <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#44475a" stroke-width="2"/>
    <polyline fill="none" stroke="#ff79c6" stroke-width="3" points="${points.join(" ")}"/>
  `;
}

// Extension message listener
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.source === "keyframe-engine-devtools") {
      handleEngineEvent(message);
    }
  });
}

// Window message fallback for testing/local harness
if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    if (event.data && event.data.source === "keyframe-engine-devtools") {
      handleEngineEvent(event.data);
    }
  });
}
