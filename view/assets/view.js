/**
 * Chrono Steps — Responsive Read-Only Embed Viewer
 */
(() => {
  "use strict";

  const MOBILE_BREAKPOINT = 800;
  const $ = (id) => document.getElementById(id);
  const parameters = new URLSearchParams(window.location.search);

  function getConfig() {
    return {
      cueLeadSeconds: 2.5,
      cueTrailSeconds: 2.5,
      cueFadeAnimation: true,
      cueMinOpacity: 0,
      ...(window.ChronoConfig || {}),
    };
  }

  function getCueOpacity(stepTime, currentTime) {
    const cfg = getConfig();
    const lead = Math.max(0.05, Number(cfg.cueLeadSeconds) || 2.5);
    const trail = Math.max(0.05, Number(cfg.cueTrailSeconds) || 2.5);
    const diff = currentTime - Number(stepTime || 0);
    if (diff < -lead || diff > trail) return 0;
    if (!cfg.cueFadeAnimation) return 1;
    const minOp = Math.max(0, Math.min(1, Number(cfg.cueMinOpacity) || 0));
    const ratio = diff <= 0 ? 1 + diff / lead : 1 - diff / trail;
    return Math.max(minOp, Math.min(1, minOp + (1 - minOp) * ratio));
  }

  let currentProject = null;
  let usesTrimmedVideoOverride = false;
  let visualCuesVisible = true;
  let dividerPointerId = null;
  let playbackRafId = null;
  let imageModalInstance = null;
  let viewZoomScale = 1;

  function readBooleanParameter(name, fallback) {
    const value = parameters.get(name);
    return value === null
      ? fallback
      : !["false", "0", "no", "off"].includes(value.toLowerCase());
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  function formatCompactTime(secondsValue) {
    const total = Math.max(0, Number(secondsValue) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = Math.floor(total % 60);
    return hours > 0
      ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function getOrderedSteps() {
    return [...(currentProject.steps || [])].sort(
      (a, b) => (a.order ?? 9999) - (b.order ?? 9999),
    );
  }

  function buildStepOutline() {
    const ordered = getOrderedSteps();
    const parents = ordered.filter((step) => step.type !== "substep");
    const parentIds = new Set(parents.map((step) => step.id));
    const entries = [];
    ordered
      .filter((step) => step.type !== "substep" || !parentIds.has(step.parentId))
      .forEach((parent, parentIndex) => {
        entries.push({ step: parent, displayNumber: String(parentIndex + 1) });
        ordered
          .filter((step) => step.type === "substep" && step.parentId === parent.id)
          .forEach((child, childIndex) => {
            entries.push({
              step: child,
              displayNumber: `${parentIndex + 1}.${childIndex + 1}`,
            });
          });
      });
    return entries;
  }

  function getSourceTimelineTime() {
    return (
      $("viewVideo").currentTime +
      (usesTrimmedVideoOverride ? Number(currentProject.trimStart) || 0 : 0)
    );
  }

  function getDisplayedVideoTime(sourceTime) {
    return Math.max(
      0,
      Number(sourceTime) -
        (usesTrimmedVideoOverride ? Number(currentProject.trimStart) || 0 : 0),
    );
  }

  function getDisplayedVideoRectangle() {
    const video = $("viewVideo");
    const videoBox = video.getBoundingClientRect();
    const stageBox = $("mediaStage").getBoundingClientRect();
    if (!video.videoWidth || !video.videoHeight || !videoBox.width || !videoBox.height) {
      return null;
    }
    const sourceRatio = video.videoWidth / video.videoHeight;
    const containerRatio = videoBox.width / videoBox.height;
    const width = sourceRatio > containerRatio ? videoBox.width : videoBox.height * sourceRatio;
    const height = sourceRatio > containerRatio ? videoBox.width / sourceRatio : videoBox.height;
    return {
      left: videoBox.left - stageBox.left + (videoBox.width - width) / 2,
      top: videoBox.top - stageBox.top + (videoBox.height - height) / 2,
      width,
      height,
    };
  }

  function resizeViewerCanvas() {
    const rect = getDisplayedVideoRectangle();
    if (!rect) return;
    const canvas = $("viewCanvas");
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    Object.assign(canvas.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    drawViewerOverlay();
  }

  function getActiveCueSteps() {
    const sourceTime = getSourceTimelineTime();
    return (currentProject.steps || []).filter(
      (step) => step.cue && getCueOpacity(step.time, sourceTime) > 0,
    );
  }

  function drawViewerOverlay() {
    const canvas = $("viewCanvas");
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    document.querySelectorAll(".view-step.active").forEach((el) => el.classList.remove("active"));
    if (!visualCuesVisible) return;
    const sourceTime = getSourceTimelineTime();
    getActiveCueSteps().forEach((step) => {
      const opacity = getCueOpacity(step.time, sourceTime);
      context.save();
      context.globalAlpha = opacity;
      context.strokeStyle = "#fbbf24";
      context.lineWidth = 4;
      context.strokeRect(
        Number(step.cue.x) * canvas.width,
        Number(step.cue.y) * canvas.height,
        Number(step.cue.w) * canvas.width,
        Number(step.cue.h) * canvas.height,
      );
      context.restore();
      $(`view-step-${step.id}`)?.classList.add("active");
    });
  }

  function renderViewerSteps() {
    const entries = buildStepOutline();
    $("viewTitle").textContent = currentProject.name || "Chrono Steps Guide";
    $("viewAuthor").textContent = currentProject.author
      ? `Prepared by ${currentProject.author}`
      : "";
    $("stepTotal").textContent = `${entries.length} ${entries.length === 1 ? "step" : "steps"}`;

    $("viewSteps").innerHTML = entries
      .map(({ step, displayNumber }) => {
        const title = escapeHtml(step.title || "Untitled step");
        const description = escapeHtml(step.description || "");
        const image = step.image
          ? `<button class="step-image-button" type="button" data-open-image="${step.id}" title="Expand screenshot"><img src="${step.image}" alt="Screenshot for ${title}"></button>`
          : "";
        return `
          <article id="view-step-${step.id}" class="view-step ${escapeHtml(step.type || "step")}">
            <div class="d-flex justify-content-between align-items-start gap-2">
              <div class="d-flex align-items-center gap-2">
                <span class="step-number">${displayNumber}</span>
                <div>
                  <h2 class="h6 fw-bold mb-0">${title}</h2>
                  <div class="font-monospace text-muted" style="font-size:0.75rem;">${formatCompactTime(step.time)}</div>
                </div>
              </div>
              <button class="btn btn-sm btn-outline-primary py-0 px-2" type="button" data-seek-step="${step.id}">Go to</button>
            </div>
            ${description ? `<p class="small text-secondary mt-2 mb-0" style="white-space:pre-wrap;">${description}</p>` : ""}
            ${image}
          </article>
        `;
      })
      .join("");
  }

  function seekToStep(stepId) {
    const step = (currentProject.steps || []).find((s) => s.id === stepId);
    if (!step) return;
    const video = $("viewVideo");
    video.pause();
    video.currentTime = Math.min(
      Number.isFinite(video.duration) ? video.duration : Number.MAX_SAFE_INTEGER,
      getDisplayedVideoTime(step.time),
    );
    updatePlayerControls();
    drawViewerOverlay();
  }

  let viewPanX = 0;
  let viewPanY = 0;

  function renderViewZoomTransform() {
    $("viewImageImg").style.transform = `translate(${viewPanX}px, ${viewPanY}px) scale(${viewZoomScale})`;
    $("viewZoomLabel").textContent = `${Math.round(viewZoomScale * 100)}%`;
  }

  function applyViewZoom(nextScale) {
    viewZoomScale = Math.max(0.5, Math.min(3, nextScale));
    if (viewZoomScale <= 1) {
      viewPanX = 0;
      viewPanY = 0;
    }
    renderViewZoomTransform();
  }

  function showImageLightbox(stepId) {
    const step = (currentProject.steps || []).find((s) => s.id === stepId);
    if (!step?.image) return;
    $("viewImageTitle").textContent = step.title || "Step screenshot";
    $("viewImageImg").src = step.image;
    $("viewImageImg").alt = `Screenshot for ${step.title || "step"}`;
    viewPanX = 0;
    viewPanY = 0;
    applyViewZoom(1);
    imageModalInstance.show();
  }

  function findCueAtPointer(event) {
    if (!visualCuesVisible) return null;
    const canvas = $("viewCanvas");
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    const x = ((event.clientX - bounds.left) * canvas.width) / bounds.width;
    const y = ((event.clientY - bounds.top) * canvas.height) / bounds.height;
    return getActiveCueSteps().find(
      (step) =>
        x >= step.cue.x * canvas.width &&
        x <= (step.cue.x + step.cue.w) * canvas.width &&
        y >= step.cue.y * canvas.height &&
        y <= (step.cue.y + step.cue.h) * canvas.height,
    );
  }

  function updatePlayerControls() {
    const video = $("viewVideo");
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    $("currentTime").textContent = formatCompactTime(video.currentTime);
    $("durationTime").textContent = formatCompactTime(duration);
    $("seekBar").value = duration
      ? String(Math.round((video.currentTime / duration) * 1000))
      : "0";
    $("playIcon").className = video.paused ? "bi bi-play-fill" : "bi bi-pause-fill";
    $("muteButton").innerHTML = video.muted
      ? '<i class="bi bi-volume-mute"></i>'
      : '<i class="bi bi-volume-up"></i>';
  }

  function setDividerPosition(percent) {
    document.documentElement.style.setProperty(
      "--video-size",
      `${Math.max(25, Math.min(75, percent))}%`,
    );
    requestAnimationFrame(resizeViewerCanvas);
  }

  function resizeFromDividerPointer(event) {
    if (dividerPointerId === null) return;
    const bounds = $("viewer").getBoundingClientRect();
    const pct =
      window.innerWidth <= MOBILE_BREAKPOINT
        ? ((event.clientY - bounds.top) / bounds.height) * 100
        : ((event.clientX - bounds.left) / bounds.width) * 100;
    setDividerPosition(pct);
  }

  function bindViewerEvents() {
    const video = $("viewVideo");
    const divider = $("layoutDivider");

    $("openFullPage").href = window.location.href;
    $("printGuide").onclick = () => window.ChronoExport.print(currentProject);
    $("downloadHtml").onclick = () => window.ChronoExport.html(currentProject);
    $("viewCueToggle").checked = visualCuesVisible;
    $("viewCueToggle").onchange = (event) => {
      visualCuesVisible = event.target.checked;
      drawViewerOverlay();
    };
    $("downloadLite").onclick = () => {
      const litePackage = {
        format: "ChronoSteps",
        version: "2.0.0",
        project: { ...currentProject, videoData: null, isLiteRecovery: true },
      };
      window.ChronoExport.download(
        new Blob([JSON.stringify(litePackage, null, 2)], { type: "application/json" }),
        `${window.ChronoExport.safeName(currentProject.name)}.stepslite`,
      );
    };

    $("playPause").onclick = () => (video.paused ? video.play() : video.pause());
    $("backFive").onclick = () => { video.currentTime = Math.max(0, video.currentTime - 5); };
    $("forwardFive").onclick = () => {
      video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
    };
    $("muteButton").onclick = () => {
      video.muted = !video.muted;
      updatePlayerControls();
    };
    $("seekBar").oninput = (event) => {
      if (Number.isFinite(video.duration)) {
        video.currentTime = (Number(event.target.value) / 1000) * video.duration;
      }
    };

    ["play", "pause", "timeupdate", "durationchange", "volumechange", "ended"].forEach((name) =>
      video.addEventListener(name, updatePlayerControls),
    );
    video.addEventListener("timeupdate", drawViewerOverlay);
    const tickPlayback = () => {
      if (!video.paused && !video.ended) {
        drawViewerOverlay();
        playbackRafId = requestAnimationFrame(tickPlayback);
      } else {
        playbackRafId = null;
      }
    };
    video.addEventListener("play", () => {
      if (!playbackRafId) playbackRafId = requestAnimationFrame(tickPlayback);
    });
    ["pause", "ended"].forEach((evt) =>
      video.addEventListener(evt, () => {
        if (playbackRafId) {
          cancelAnimationFrame(playbackRafId);
          playbackRafId = null;
        }
      }),
    );
    video.addEventListener("loadedmetadata", resizeViewerCanvas);

    $("viewSteps").onclick = (event) => {
      const seekButton = event.target.closest("[data-seek-step]");
      if (seekButton) return seekToStep(seekButton.dataset.seekStep);
      const imageButton = event.target.closest("[data-open-image]");
      if (imageButton) showImageLightbox(imageButton.dataset.openImage);
    };

    $("viewCanvas").onclick = (event) => {
      const step = findCueAtPointer(event);
      if (step) {
        $(`view-step-${step.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    };

    const tooltip = document.createElement("div");
    tooltip.className = "cue-tooltip";
    tooltip.hidden = true;
    document.body.append(tooltip);

    $("viewCanvas").onpointermove = (event) => {
      const step = findCueAtPointer(event);
      tooltip.hidden = !step;
      if (step) {
        tooltip.textContent = step.title || "Step";
        tooltip.style.left = `${event.clientX + 12}px`;
        tooltip.style.top = `${event.clientY + 12}px`;
      }
    };
    $("viewCanvas").onpointerleave = () => { tooltip.hidden = true; };

    divider.onpointerdown = (event) => {
      dividerPointerId = event.pointerId;
      divider.setPointerCapture(event.pointerId);
      divider.classList.add("dragging");
    };
    divider.onpointermove = resizeFromDividerPointer;
    divider.onpointerup = () => {
      dividerPointerId = null;
      divider.classList.remove("dragging");
    };
    divider.onkeydown = (event) => {
      const current =
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--video-size")) || 58;
      if (["ArrowLeft", "ArrowUp"].includes(event.key)) setDividerPosition(current - 2);
      if (["ArrowRight", "ArrowDown"].includes(event.key)) setDividerPosition(current + 2);
    };
    window.addEventListener("resize", resizeViewerCanvas);
  }

  async function initialiseViewer() {
    try {
      const projectPath = parameters.get("steps") || parameters.get("stepslite");
      if (!projectPath) {
        throw new Error("Provide ?steps=/path/file.steps or ?stepslite=/path/file.stepslite in the URL.");
      }
      const response = await fetch(projectPath, { cache: "no-store" });
      if (!response.ok) throw new Error(`Project request returned HTTP ${response.status}.`);
      const packageData = await response.json();
      currentProject = packageData.project || packageData.currentProject || packageData;
      if (!currentProject || !Array.isArray(currentProject.steps)) {
        throw new Error("The selected file is not a supported Chrono Steps package.");
      }

      visualCuesVisible = readBooleanParameter("annotate", true);
      const rawVideoParam = parameters.get("video");
      const isBooleanVideo =
        rawVideoParam === null ||
        ["true", "false", "1", "0", "yes", "no", "on", "off"].includes(rawVideoParam.toLowerCase());
      const showVideo = isBooleanVideo ? readBooleanParameter("video", true) : true;
      const videoParamPath = !isBooleanVideo && rawVideoParam ? rawVideoParam : null;
      const legacyRedacted = parameters.get("redacted") || parameters.get("redacted_video_override");
      const videoOverride = videoParamPath || legacyRedacted;
      usesTrimmedVideoOverride = Boolean(videoOverride);
      const showSteps = readBooleanParameter("steps", true);
      const videoSource = videoOverride || currentProject.videoData;

      if (videoSource) {
        $("viewVideo").src = videoSource;
        $("viewVideo").muted = readBooleanParameter("muted", false);
      } else if (showVideo) {
        throw new Error("No video is embedded. Supply &video=/path/to/video.webm for a Lite project.");
      }

      imageModalInstance = new bootstrap.Modal($("viewImageModal"));
      $("viewZoomIn").onclick = () => applyViewZoom(viewZoomScale + 0.25);
      $("viewZoomOut").onclick = () => applyViewZoom(viewZoomScale - 0.25);
      $("viewZoomReset").onclick = () => {
        viewPanX = 0;
        viewPanY = 0;
        applyViewZoom(1);
      };

      const viewViewport = document.querySelector("#viewImageModal .image-zoom-viewport");
      let viewPanStart = null;
      viewViewport.onpointerdown = (e) => {
        viewPanStart = { x: e.clientX - viewPanX, y: e.clientY - viewPanY };
        viewViewport.classList.add("panning");
        viewViewport.setPointerCapture(e.pointerId);
      };
      viewViewport.onpointermove = (e) => {
        if (!viewPanStart) return;
        viewPanX = e.clientX - viewPanStart.x;
        viewPanY = e.clientY - viewPanStart.y;
        renderViewZoomTransform();
      };
      viewViewport.onpointerup = () => {
        viewPanStart = null;
        viewViewport.classList.remove("panning");
      };

      $("viewer").classList.toggle("no-video", !showVideo);
      $("viewer").classList.toggle("no-steps", !showSteps);
      renderViewerSteps();
      bindViewerEvents();
      updatePlayerControls();
      $("viewLoading").hidden = true;
      $("viewer").setAttribute("aria-busy", "false");
    } catch (error) {
      $("viewLoading").hidden = true;
      $("viewError").hidden = false;
      $("viewError").textContent = error.message;
      $("viewer").setAttribute("aria-busy", "false");
    }
  }

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", initialiseViewer)
    : initialiseViewer();
})();

