/**
 * Chrono Steps — Editor Application Controller
 * 100% client-side screen recording, step authoring, visual cues, and redactions.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function getConfig() {
    return {
      cueLeadSeconds: 2.5,
      cueTrailSeconds: 2.5,
      cueFadeAnimation: true,
      cueMinOpacity: 0,
      MAX_CACHED_VIDEO_DURATION: 300,
      MAX_VIDEO_DURATION: 900,
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

  let project = createEmptyProject();
  let visualCuesVisible = true;
  let editingStepId = null;
  let editingMaskId = null;
  let selectedMaskId = null;
  let selectedStepId = null;
  let boxInteraction = null;
  let pendingImage = null;
  let pendingCue = null;
  let pendingMaskGeometry = null;
  let playbackRafId = null;
  let skipVideoCache = false;
  let durationLimitNotified = false;
  let imageZoomScale = 1;

  // Canvas drawing state
  let canvasMode = "idle"; // "idle" | "shot" | "mask"
  let isDrawing = false;
  let drawStart = null;
  let drawCurrent = null;

  // Screen recording state
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordingStream = null;
  let recordingTimer = null;
  let recordingSeconds = 0;

  // Annotation state
  let annotationTool = "rectangle";
  let annotationBaseImage = null;
  let annotationShapes = [];
  let annotationDrawing = false;
  let annotationStart = null;
  let annotationTargetStepId = null;

  // Bootstrap modal instances
  let stepModalInstance = null;
  let maskModalInstance = null;
  let annotationModalInstance = null;
  let imagePreviewModalInstance = null;
  let deferredInstallPrompt = null;
  let dragStepId = null;
  let cueTooltip = null;

  function createEmptyProject() {
    return {
      name: "Untitled guide",
      author: "",
      videoData: null,
      videoName: "",
      trimStart: 0,
      trimEnd: 0,
      excludeAudio: false,
      theme: "lumen",
      steps: [],
      masks: [],
    };
  }

  function createIdentifier() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
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

  function formatTime(secondsValue) {
    const total = Math.max(0, Number(secondsValue) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = Math.floor(total % 60);
    const ms = Math.floor((total % 1) * 1000);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  }

  function parseTimeInput(value) {
    const text = String(value ?? "").trim();
    if (!text) return NaN;
    if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
    const parts = text.split(":").map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return NaN;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return NaN;
  }

  function showToast(title, icon = "success") {
    if (!window.Swal) return;
    Swal.fire({
      toast: true,
      position: "bottom-end",
      icon,
      title,
      showConfirmButton: false,
      timer: 2200,
      timerProgressBar: true,
    });
  }

  function showAlert(title, text, icon = "info") {
    if (!window.Swal) return Promise.resolve();
    return Swal.fire({
      title,
      text,
      icon,
      confirmButtonColor: "#158cba",
    });
  }

  async function showConfirm(title, text, confirmButtonText = "Confirm", isDanger = false) {
    if (!window.Swal) return true;
    const result = await Swal.fire({
      title,
      text,
      icon: isDanger ? "warning" : "question",
      showCancelButton: true,
      confirmButtonText,
      confirmButtonColor: isDanger ? "#ff4136" : "#158cba",
      cancelButtonColor: "#64748b",
    });
    return result.isConfirmed;
  }

  function setDirtyState(isDirty) {
    const badge = $("dirtyBadge");
    if (!badge) return;
    badge.className = `dirty-indicator ${isDirty ? "dirty" : "clean"}`;
    badge.innerHTML = isDirty
      ? '<i class="bi bi-dot"></i> <span>Saving...</span>'
      : '<i class="bi bi-check2"></i> <span>Saved</span>';
  }

  async function persistRecovery() {
    project.name = $("projectName").value.trim() || "Untitled guide";
    project.author = $("authorName").value.trim();
    setDirtyState(true);
    const toStore = skipVideoCache ? { ...project, videoData: null } : project;
    await window.ChronoStorage.saveRecovery(toStore);
    setDirtyState(false);
  }

  function playLimitChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      [523.25, 659.25].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.15, ctx.currentTime + idx * 0.16);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.16 + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.16);
        osc.stop(ctx.currentTime + idx * 0.16 + 0.26);
      });
    } catch {
      // Audio context blocked or unavailable
    }
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function setLoadingOverlay(visible, title = "Loading video", detail = "Preparing media...") {
    const overlay = $("loadingOverlay");
    overlay.hidden = !visible;
    $("loadingTitle").textContent = title;
    $("loadingDetail").textContent = detail;
  }

  function getOrderedSteps() {
    return [...(project.steps || [])].sort(
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
        entries.push({ step: parent, number: String(parentIndex + 1) });
        ordered
          .filter((step) => step.type === "substep" && step.parentId === parent.id)
          .forEach((child, childIndex) => {
            entries.push({ step: child, number: `${parentIndex + 1}.${childIndex + 1}` });
          });
      });
    return entries;
  }

  function getDisplayedVideoRectangle() {
    const video = $("video");
    const videoBox = video.getBoundingClientRect();
    const stageBox = $("stage").getBoundingClientRect();
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

  function resizeOverlayCanvas() {
    const rect = getDisplayedVideoRectangle();
    const canvas = $("overlay");
    if (!rect) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    Object.assign(canvas.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    drawVideoOverlay();
  }

  function getMaskHandles(mask, canvas) {
    const x = mask.x * canvas.width;
    const y = mask.y * canvas.height;
    const w = mask.w * canvas.width;
    const h = mask.h * canvas.height;
    return {
      nw: { x, y, cursor: "nwse-resize" },
      n: { x: x + w / 2, y, cursor: "ns-resize" },
      ne: { x: x + w, y, cursor: "nesw-resize" },
      e: { x: x + w, y: y + h / 2, cursor: "ew-resize" },
      se: { x: x + w, y: y + h, cursor: "nwse-resize" },
      s: { x: x + w / 2, y: y + h, cursor: "ns-resize" },
      sw: { x, y: y + h, cursor: "nesw-resize" },
      w: { x, y: y + h / 2, cursor: "ew-resize" },
    };
  }

  function hitTestBoxInteraction(pt, canvas, now) {
    const activeMasks = (project.masks || []).filter((m) => now >= m.start && now <= m.end);
    if (selectedMaskId) {
      const sel = activeMasks.find((m) => m.id === selectedMaskId);
      if (sel) {
        const handles = getMaskHandles(sel, canvas);
        for (const [key, h] of Object.entries(handles)) {
          if (Math.abs(pt.x - h.x) <= 7 && Math.abs(pt.y - h.y) <= 7) {
            return { target: sel, kind: "mask", type: key, cursor: h.cursor };
          }
        }
      }
    }

    if (selectedStepId && visualCuesVisible) {
      const selStep = (project.steps || []).find(
        (s) => s.id === selectedStepId && s.cue && getCueOpacity(s.time, now) > 0,
      );
      if (selStep) {
        const handles = getMaskHandles(selStep.cue, canvas);
        for (const [key, h] of Object.entries(handles)) {
          if (Math.abs(pt.x - h.x) <= 7 && Math.abs(pt.y - h.y) <= 7) {
            return { target: selStep.cue, kind: "cue", type: key, cursor: h.cursor };
          }
        }
      }
    }

    for (let i = activeMasks.length - 1; i >= 0; i -= 1) {
      const m = activeMasks[i];
      const mx = m.x * canvas.width;
      const my = m.y * canvas.height;
      const mw = m.w * canvas.width;
      const mh = m.h * canvas.height;
      if (pt.x >= mx && pt.x <= mx + mw && pt.y >= my && pt.y <= my + mh) {
        return { target: m, kind: "mask", id: m.id, type: "move", cursor: "move" };
      }
    }

    if (visualCuesVisible) {
      const activeCues = (project.steps || []).filter(
        (s) => s.cue && getCueOpacity(s.time, now) > 0,
      );
      for (let i = activeCues.length - 1; i >= 0; i -= 1) {
        const s = activeCues[i];
        const cx = s.cue.x * canvas.width;
        const cy = s.cue.y * canvas.height;
        const cw = s.cue.w * canvas.width;
        const ch = s.cue.h * canvas.height;
        if (pt.x >= cx && pt.x <= cx + cw && pt.y >= cy && pt.y <= cy + ch) {
          return { target: s.cue, kind: "cue", id: s.id, type: "move", cursor: "move" };
        }
      }
    }
    return null;
  }

  function drawLiveVideoMask(context, canvas, video, mask) {
    const dx = mask.x * canvas.width;
    const dy = mask.y * canvas.height;
    const dw = mask.w * canvas.width;
    const dh = mask.h * canvas.height;

    if (mask.style === "white" || mask.style === "black") {
      context.fillStyle = mask.style;
      context.fillRect(dx, dy, dw, dh);
      return;
    }

    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      context.fillStyle = "rgba(15, 23, 42, 0.55)";
      context.fillRect(dx, dy, dw, dh);
      return;
    }

    const sx = mask.x * video.videoWidth;
    const sy = mask.y * video.videoHeight;
    const sw = Math.max(1, mask.w * video.videoWidth);
    const sh = Math.max(1, mask.h * video.videoHeight);

    if (mask.style === "blur") {
      context.save();
      context.beginPath();
      context.rect(dx, dy, dw, dh);
      context.clip();
      context.filter = "blur(14px)";
      context.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
      context.restore();
      return;
    }

    const pixelCanvas = document.createElement("canvas");
    pixelCanvas.width = Math.max(2, Math.round(dw * 0.06));
    pixelCanvas.height = Math.max(2, Math.round(dh * 0.06));
    pixelCanvas.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, pixelCanvas.width, pixelCanvas.height);

    context.save();
    context.imageSmoothingEnabled = false;
    context.drawImage(pixelCanvas, 0, 0, pixelCanvas.width, pixelCanvas.height, dx, dy, dw, dh);
    context.restore();
  }

  function drawVideoOverlay() {
    const canvas = $("overlay");
    const context = canvas.getContext("2d");
    if (!canvas.width || !canvas.height) return;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const video = $("video");
    const now = video.currentTime || 0;

    // Active redactions
    (project.masks || [])
      .filter((mask) => now >= mask.start && now <= mask.end)
      .forEach((mask) => {
        drawLiveVideoMask(context, canvas, video, mask);

        if (mask.id === selectedMaskId) {
          const dx = mask.x * canvas.width;
          const dy = mask.y * canvas.height;
          const dw = mask.w * canvas.width;
          const dh = mask.h * canvas.height;
          context.save();
          context.strokeStyle = "#ff4136";
          context.lineWidth = 2;
          context.setLineDash([5, 4]);
          context.strokeRect(dx, dy, dw, dh);
          context.setLineDash([]);
          const handles = getMaskHandles(mask, canvas);
          Object.values(handles).forEach((h) => {
            context.fillStyle = "#ffffff";
            context.strokeStyle = "#ff4136";
            context.lineWidth = 1.5;
            context.fillRect(h.x - 4, h.y - 4, 8, 8);
            context.strokeRect(h.x - 4, h.y - 4, 8, 8);
          });
          context.restore();
        }
      });

    // Visual cues with fade-in / fade-out opacity
    if (visualCuesVisible) {
      (project.steps || []).forEach((step) => {
        if (!step.cue) return;
        const opacity = step.id === selectedStepId ? 1 : getCueOpacity(step.time, now);
        if (opacity <= 0) return;
        const dx = step.cue.x * canvas.width;
        const dy = step.cue.y * canvas.height;
        const dw = step.cue.w * canvas.width;
        const dh = step.cue.h * canvas.height;
        context.save();
        context.globalAlpha = opacity;
        context.strokeStyle = "#fbbf24";
        context.lineWidth = 3;
        context.strokeRect(dx, dy, dw, dh);
        if (step.id === selectedStepId) {
          const handles = getMaskHandles(step.cue, canvas);
          Object.values(handles).forEach((h) => {
            context.fillStyle = "#ffffff";
            context.strokeStyle = "#f59e0b";
            context.lineWidth = 1.5;
            context.fillRect(h.x - 4, h.y - 4, 8, 8);
            context.strokeRect(h.x - 4, h.y - 4, 8, 8);
          });
        }
        context.restore();
      });
    }

    // Active drag selection
    if (isDrawing && drawStart && drawCurrent) {
      const x = Math.min(drawStart.x, drawCurrent.x);
      const y = Math.min(drawStart.y, drawCurrent.y);
      const w = Math.abs(drawCurrent.x - drawStart.x);
      const h = Math.abs(drawCurrent.y - drawStart.y);
      context.save();
      context.strokeStyle = canvasMode === "mask" ? "#ff4136" : "#158cba";
      context.fillStyle =
        canvasMode === "mask" ? "rgba(255, 65, 54, 0.2)" : "rgba(21, 140, 186, 0.2)";
      context.lineWidth = 2.5;
      context.fillRect(x, y, w, h);
      context.strokeRect(x, y, w, h);
      context.restore();
    }
  }

  function updatePlayerDisplay() {
    const video = $("video");
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const current = video.currentTime || 0;

    $("now").textContent = formatTime(current);
    $("total").textContent = formatTime(duration);
    $("progress").style.width = duration ? `${(current / duration) * 100}%` : "0%";

    const trimStart = Math.max(0, project.trimStart || 0);
    const trimEnd = project.trimEnd > trimStart && duration ? Math.min(project.trimEnd, duration) : duration;

    $("shadeBefore").style.left = "0%";
    $("shadeBefore").style.width = duration ? `${(trimStart / duration) * 100}%` : "0%";
    $("shadeAfter").style.left = duration ? `${(trimEnd / duration) * 100}%` : "100%";
    $("shadeAfter").style.width = duration ? `${Math.max(0, ((duration - trimEnd) / duration) * 100)}%` : "0%";

    $("rangeStartText").textContent = formatTime(trimStart);
    $("rangeEndText").textContent = project.trimEnd > 0 ? formatTime(project.trimEnd) : "End";

    $("play").innerHTML = video.paused
      ? '<i class="bi bi-play-fill"></i>'
      : '<i class="bi bi-pause-fill"></i>';

    synchronisePlayerControls();
    drawVideoOverlay();
  }

  function renderTimelinePins() {
    const pinsContainer = $("pins");
    const video = $("video");
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    pinsContainer.innerHTML = "";
    if (!duration) return;

    getOrderedSteps().forEach((step) => {
      const pct = Math.max(0, Math.min(100, ((Number(step.time) || 0) / duration) * 100));
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "pin border-0 p-0";
      pin.style.left = `${pct}%`;
      pin.title = `${step.title || "Step"} (${formatTime(step.time)})`;
      pin.onclick = (event) => {
        event.stopPropagation();
        video.currentTime = Number(step.time) || 0;
        scrollToStep(step.id);
      };
      pinsContainer.append(pin);
    });
  }

  function renderStepsList() {
    const entries = buildStepOutline();
    $("stepCount").textContent = String(entries.length);
    $("noSteps").hidden = entries.length > 0;
    const container = $("steps");
    container.innerHTML = "";

    entries.forEach(({ step, number }) => {
      const card = document.createElement("div");
      card.className = `step-card ${step.type || "step"} ${step.id === selectedStepId ? "selected-cue" : ""}`;
      card.id = `step-card-${step.id}`;
      card.draggable = true;
      card.dataset.stepId = step.id;

      card.innerHTML = `
        <div class="d-flex align-items-start gap-2">
          <span class="drag-handle pt-1" title="Drag to reorder or nest"><i class="bi bi-grip-vertical"></i></span>
          <span class="step-number">${escapeHtml(number)}</span>
          <div class="flex-grow-1 min-w-0">
            <div class="d-flex justify-content-between align-items-start gap-1">
              <strong class="small text-truncate">${escapeHtml(step.title || "Untitled step")}</strong>
              <button class="btn btn-sm btn-link text-secondary p-0 step-menu-btn" type="button" title="Step actions">
                <i class="bi bi-three-dots-vertical"></i>
              </button>
            </div>
            <button class="btn btn-link btn-sm p-0 text-decoration-none font-monospace text-primary step-time-btn" type="button" style="font-size:0.72rem;">
              <i class="bi bi-clock me-1"></i>${formatTime(step.time)}
            </button>
            ${step.description ? `<p class="small text-secondary mb-1 mt-1" style="white-space:pre-wrap;">${escapeHtml(step.description)}</p>` : ""}
            ${step.image ? `<img src="${step.image}" class="step-thumb mt-1" alt="Screenshot for ${escapeHtml(step.title)}" />` : ""}
          </div>
        </div>
      `;

      card.onclick = (event) => {
        if (event.target.closest("button, img, .drag-handle")) return;
        const video = $("video");
        if (video.src) {
          video.pause();
          video.currentTime = Number(step.time) || 0;
        }
        selectedStepId = step.cue ? step.id : null;
        selectedMaskId = null;
        renderStepsList();
        renderMasksList();
        drawVideoOverlay();
      };

      card.querySelector(".step-time-btn").onclick = () => {
        if ($("video").src) $("video").currentTime = Number(step.time) || 0;
      };
      const thumb = card.querySelector(".step-thumb");
      if (thumb) {
        thumb.onclick = (event) => {
          event.stopPropagation();
          openImagePreviewModal(step.title || "Step screenshot", step.image);
        };
      }
      card.querySelector(".step-menu-btn").onclick = (event) => {
        event.stopPropagation();
        openStepContextMenu(event.currentTarget, step.id);
      };

      // Drag and drop reordering
      card.ondragstart = (event) => {
        dragStepId = step.id;
        event.dataTransfer.effectAllowed = "move";
      };
      card.ondragover = (event) => {
        if (!dragStepId || dragStepId === step.id) return;
        event.preventDefault();
        const rect = card.getBoundingClientRect();
        const ratio = (event.clientY - rect.top) / rect.height;
        card.classList.remove("drop-before", "drop-nest", "drop-after");
        if (ratio < 0.28) card.classList.add("drop-before");
        else if (ratio > 0.72) card.classList.add("drop-after");
        else card.classList.add("drop-nest");
      };
      card.ondragleave = () => {
        card.classList.remove("drop-before", "drop-nest", "drop-after");
      };
      card.ondrop = (event) => {
        event.preventDefault();
        const mode = card.classList.contains("drop-before")
          ? "before"
          : card.classList.contains("drop-after")
            ? "after"
            : "nest";
        card.classList.remove("drop-before", "drop-nest", "drop-after");
        if (dragStepId && dragStepId !== step.id) {
          moveStepByDropMode(dragStepId, step.id, mode);
        }
        dragStepId = null;
      };

      container.append(card);
    });
  }

  function moveStepByDropMode(movingId, targetId, mode) {
    const ordered = getOrderedSteps();
    const movingIndex = ordered.findIndex((s) => s.id === movingId);
    if (movingIndex === -1) return;
    const [moving] = ordered.splice(movingIndex, 1);

    const targetIndex = ordered.findIndex((s) => s.id === targetId);
    if (targetIndex === -1) return;
    const target = ordered[targetIndex];

    if (mode === "nest") {
      moving.type = "substep";
      moving.parentId = target.type === "substep" ? target.parentId : target.id;
      ordered.splice(targetIndex + 1, 0, moving);
    } else {
      if (target.type === "substep") {
        moving.type = "substep";
        moving.parentId = target.parentId;
      } else {
        moving.type = moving.type === "note" ? "note" : "step";
        moving.parentId = "";
      }
      ordered.splice(mode === "before" ? targetIndex : targetIndex + 1, 0, moving);
    }

    ordered.forEach((step, idx) => {
      step.order = idx;
    });
    project.steps = ordered;
    renderProject();
  }

  function renderMasksList() {
    const masks = project.masks || [];
    $("maskCount").textContent = String(masks.length);
    const container = $("masks");
    container.innerHTML = "";

    masks.forEach((mask) => {
      const item = document.createElement("div");
      item.className = `mask-item ${mask.id === selectedMaskId ? "selected" : ""}`;
      item.style.cursor = "pointer";
      item.innerHTML = `
        <div class="d-flex align-items-center gap-2 min-w-0">
          <span class="badge text-bg-dark text-uppercase">${escapeHtml(mask.style)}</span>
          <span class="font-monospace text-truncate">${formatTime(mask.start)} – ${formatTime(mask.end)}</span>
        </div>
        <div class="btn-group btn-group-sm">
          <button class="btn btn-link btn-sm p-0 px-1 text-primary edit-mask" type="button" title="Edit"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-link btn-sm p-0 px-1 text-danger del-mask" type="button" title="Delete"><i class="bi bi-trash"></i></button>
        </div>
      `;
      item.onclick = (event) => {
        if (event.target.closest("button")) return;
        selectedMaskId = mask.id;
        const video = $("video");
        if (video.src && (video.currentTime < mask.start || video.currentTime > mask.end)) {
          video.pause();
          video.currentTime = mask.start;
        }
        renderMasksList();
        drawVideoOverlay();
      };
      item.querySelector(".edit-mask").onclick = () => openMaskDialog(mask.id);
      item.querySelector(".del-mask").onclick = async () => {
        if (await showConfirm("Delete redaction?", "This timed redaction will be removed.", "Delete", true)) {
          if (selectedMaskId === mask.id) selectedMaskId = null;
          project.masks = project.masks.filter((m) => m.id !== mask.id);
          renderProject();
        }
      };
      container.append(item);
    });
  }

  function renderProject() {
    getOrderedSteps().forEach((step, idx) => {
      step.order = idx;
    });
    renderStepsList();
    renderMasksList();
    renderTimelinePins();
    updatePlayerDisplay();
    persistRecovery();
  }

  function scrollToStep(stepId) {
    const card = $(`step-card-${stepId}`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("active");
    setTimeout(() => card.classList.remove("active"), 1800);
  }

  function openStepContextMenu(button, stepId) {
    document.querySelectorAll(".cs-context-menu").forEach((el) => el.remove());
    const step = project.steps.find((s) => s.id === stepId);
    if (!step) return;

    const menu = document.createElement("div");
    menu.className = "dropdown-menu show dropdown-menu-glass cs-context-menu";
    menu.innerHTML = `
      <button class="dropdown-item-glass w-100 border-0 bg-transparent" data-act="goto"><i class="bi bi-play-circle text-primary"></i>Go to timestamp</button>
      <button class="dropdown-item-glass w-100 border-0 bg-transparent" data-act="edit"><i class="bi bi-pencil text-secondary"></i>Edit step</button>
      ${step.image ? '<button class="dropdown-item-glass w-100 border-0 bg-transparent" data-act="annotate"><i class="bi bi-bounding-box text-danger"></i>Annotate screenshot</button>' : ""}
      <hr class="dropdown-divider my-1">
      <button class="dropdown-item-glass w-100 border-0 bg-transparent text-danger" data-act="delete"><i class="bi bi-trash"></i>Delete</button>
    `;

    const rect = button.getBoundingClientRect();
    menu.style.left = `${Math.min(window.innerWidth - 210, Math.max(8, rect.right - 190))}px`;
    menu.style.top = `${Math.min(window.innerHeight - 170, rect.bottom + 4)}px`;
    document.body.append(menu);

    const close = () => menu.remove();
    setTimeout(() => document.addEventListener("click", close, { once: true }), 0);

    menu.onclick = async (event) => {
      const btn = event.target.closest("[data-act]");
      if (!btn) return;
      const action = btn.dataset.act;
      if (action === "goto" && $("video").src) {
        $("video").currentTime = Number(step.time) || 0;
      } else if (action === "edit") {
        openStepDialog(step.id);
      } else if (action === "annotate") {
        openAnnotationDialog(step.id, step.image);
      } else if (action === "delete") {
        if (await showConfirm("Delete step?", `Remove "${step.title || "Untitled step"}"?`, "Delete", true)) {
          project.steps = project.steps.filter((s) => s.id !== step.id && s.parentId !== step.id);
          renderProject();
          showToast("Step deleted");
        }
      }
    };
  }

  function populateParentOptions(selectedId = "", excludeId = "") {
    const select = $("parent");
    select.innerHTML = "";
    getOrderedSteps()
      .filter((s) => s.type !== "substep" && s.id !== excludeId)
      .forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = s.title || "Untitled step";
        if (s.id === selectedId) opt.selected = true;
        select.append(opt);
      });
  }

  function updateStepPreview(dataUrl) {
    pendingImage = dataUrl || null;
    const preview = $("preview");
    const prompt = $("imageDropPrompt");
    if (pendingImage) {
      preview.src = pendingImage;
      preview.hidden = false;
      prompt.hidden = true;
    } else {
      preview.hidden = true;
      preview.src = "";
      prompt.hidden = false;
    }
    $("annotatePending").disabled = !pendingImage;
    $("removeImage").disabled = !pendingImage;
  }

  function openStepDialog(stepId = null, preservePending = false) {
    editingStepId = stepId;
    const step = stepId ? project.steps.find((s) => s.id === stepId) : null;

    $("stepHeading").textContent = step ? "Edit step" : "Add step";
    if (!preservePending) {
      $("stepTime").value = formatTime(step ? step.time : $("video").currentTime || 0);
      $("stepTitle").value = step ? step.title || "" : "";
      $("stepDetails").value = step ? step.description || "" : "";
      $("stepType").value = step ? step.type || "step" : "step";
      pendingCue = step ? step.cue || null : null;
      updateStepPreview(step ? step.image || null : null);
    }

    const isSubstep = $("stepType").value === "substep";
    $("parentWrap").hidden = !isSubstep;
    populateParentOptions(step?.parentId || "", stepId || "");
    stepModalInstance.show();
    setTimeout(() => $("stepTitle").focus(), 200);
  }

  function openMaskDialog(maskId = null) {
    editingMaskId = maskId;
    const mask = maskId ? project.masks.find((m) => m.id === maskId) : null;
    const now = $("video").currentTime || 0;
    const dur = Number.isFinite($("video").duration) ? $("video").duration : now + 5;

    $("maskStart").value = formatTime(mask ? mask.start : now);
    $("maskEnd").value = formatTime(mask ? mask.end : Math.min(dur, now + 5));
    $("maskStyle").value = mask ? mask.style : "blur";
    if (mask) {
      pendingMaskGeometry = { x: mask.x, y: mask.y, w: mask.w, h: mask.h };
    }
    maskModalInstance.show();
  }

  function setCanvasMode(mode) {
    canvasMode = mode;
    isDrawing = false;
    drawStart = null;
    drawCurrent = null;

    const overlay = $("overlay");
    overlay.classList.toggle("drawing", mode !== "idle");
    overlay.style.cursor = mode === "idle" ? "default" : "crosshair";
    $("stage").style.cursor = mode === "idle" ? "default" : "crosshair";
    $("cancelDraw").hidden = mode === "idle";
    $("drawModeBanner").classList.toggle("d-none", mode === "idle");
    $("drawModeBanner").classList.toggle("d-flex", mode !== "idle");
    $("drawModeText").textContent =
      mode === "shot"
        ? "Drag on the video to capture a screenshot & visual cue"
        : "Drag on the video to select the redaction area";
    drawVideoOverlay();
  }

  function getCanvasPoint(event) {
    const canvas = $("overlay");
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, ((event.clientX - rect.left) * canvas.width) / rect.width)),
      y: Math.max(0, Math.min(canvas.height, ((event.clientY - rect.top) * canvas.height) / rect.height)),
    };
  }

  function captureCanvasSelection() {
    const canvas = $("overlay");
    const video = $("video");
    if (!drawStart || !drawCurrent || !canvas.width || !canvas.height) return null;

    const x = Math.min(drawStart.x, drawCurrent.x);
    const y = Math.min(drawStart.y, drawCurrent.y);
    const w = Math.abs(drawCurrent.x - drawStart.x);
    const h = Math.abs(drawCurrent.y - drawStart.y);
    if (w < 8 || h < 8) return null;

    const cue = {
      x: x / canvas.width,
      y: y / canvas.height,
      w: w / canvas.width,
      h: h / canvas.height,
    };

    if (canvasMode === "mask") {
      return { cue };
    }

    const shotCanvas = document.createElement("canvas");
    shotCanvas.width = Math.max(1, Math.round(cue.w * video.videoWidth));
    shotCanvas.height = Math.max(1, Math.round(cue.h * video.videoHeight));

    // Render full video frame with active redactions first so screenshots inherit redactions
    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = video.videoWidth;
    frameCanvas.height = video.videoHeight;
    const frameCtx = frameCanvas.getContext("2d");
    frameCtx.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);

    const now = video.currentTime || 0;
    (project.masks || [])
      .filter((mask) => now >= mask.start && now <= mask.end)
      .forEach((mask) => window.ChronoExport.drawMask(frameCtx, frameCanvas, mask));

    shotCanvas
      .getContext("2d")
      .drawImage(
        frameCanvas,
        cue.x * frameCanvas.width,
        cue.y * frameCanvas.height,
        shotCanvas.width,
        shotCanvas.height,
        0,
        0,
        shotCanvas.width,
        shotCanvas.height,
      );

    return {
      cue,
      image: shotCanvas.toDataURL("image/png"),
    };
  }

  function openAnnotationDialog(targetStepId, imageDataUrl) {
    annotationTargetStepId = targetStepId;
    annotationShapes = [];
    annotationTool = "rectangle";
    document.querySelectorAll("[data-tool]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tool === "rectangle");
    });

    const img = new Image();
    img.onload = () => {
      annotationBaseImage = img;
      const canvas = $("annotationCanvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      redrawAnnotationCanvas();
      annotationModalInstance.show();
    };
    img.src = imageDataUrl;
  }

  function redrawAnnotationCanvas(previewShape = null) {
    const canvas = $("annotationCanvas");
    const ctx = canvas.getContext("2d");
    if (!annotationBaseImage) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(annotationBaseImage, 0, 0);

    const shapes = previewShape ? [...annotationShapes, previewShape] : annotationShapes;
    shapes.forEach((shape) => {
      const rx = shape.w < 0 ? shape.x + shape.w : shape.x;
      const ry = shape.h < 0 ? shape.y + shape.h : shape.y;
      const rw = Math.max(1, Math.abs(shape.w));
      const rh = Math.max(1, Math.abs(shape.h));

      ctx.save();
      if (shape.tool === "black" || shape.tool === "white") {
        ctx.fillStyle = shape.tool;
        ctx.fillRect(rx, ry, rw, rh);
      } else if (shape.tool === "blur") {
        ctx.beginPath();
        ctx.rect(rx, ry, rw, rh);
        ctx.clip();
        ctx.filter = "blur(14px)";
        ctx.drawImage(canvas, rx, ry, rw, rh, rx, ry, rw, rh);
      } else if (shape.tool === "pixelate") {
        const pxCanvas = document.createElement("canvas");
        pxCanvas.width = Math.max(2, Math.round(rw * 0.06));
        pxCanvas.height = Math.max(2, Math.round(rh * 0.06));
        pxCanvas.getContext("2d").drawImage(canvas, rx, ry, rw, rh, 0, 0, pxCanvas.width, pxCanvas.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(pxCanvas, 0, 0, pxCanvas.width, pxCanvas.height, rx, ry, rw, rh);
      } else if (shape.tool === "rectangle") {
        ctx.strokeStyle = "#ff4136";
        ctx.lineWidth = Math.max(3, Math.round(canvas.width * 0.005));
        ctx.strokeRect(rx, ry, rw, rh);
      } else {
        ctx.strokeStyle = "#ff4136";
        ctx.lineWidth = Math.max(3, Math.round(canvas.width * 0.005));
        ctx.beginPath();
        ctx.ellipse(rx + rw / 2, ry + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  function getAnnotationPoint(event) {
    const canvas = $("annotationCanvas");
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * canvas.width) / rect.width,
      y: ((event.clientY - rect.top) * canvas.height) / rect.height,
    };
  }

  function synchronisePlayerControls() {
    const video = $("video");
    const muteIcon = video.muted ? '<i class="bi bi-volume-mute"></i>' : '<i class="bi bi-volume-up"></i>';
    $("mute").innerHTML = muteIcon;
    if ($("cueToggle")) $("cueToggle").checked = visualCuesVisible;
    $("menuCues").querySelector(".toggle-check").className =
      `bi ${visualCuesVisible ? "bi-check-lg" : ""} toggle-check text-primary`;
    $("menuMute").querySelector(".toggle-check").className =
      `bi ${video.muted ? "bi-check-lg" : ""} toggle-check text-primary`;
    $("menuAudio").querySelector(".toggle-check").className =
      `bi ${project.excludeAudio ? "bi-check-lg" : ""} toggle-check text-primary`;
  }

  function loadVideoSource(url, name = "") {
    durationLimitNotified = false;
    skipVideoCache = false;
    const video = $("video");
    $("stage").classList.remove("empty");
    $("empty").hidden = true;
    video.src = url;
    if (name) project.videoName = name;
  }

  async function toggleScreenRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      return;
    }

    try {
      recordingStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      });
    } catch {
      return;
    }

    recordedChunks = [];
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    mediaRecorder = new MediaRecorder(recordingStream, { mimeType });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) recordedChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      clearInterval(recordingTimer);
      $("recordBadge").hidden = true;
      $("recordClock").hidden = true;
      $("recordText").textContent = "Record screen";
      recordingStream.getTracks().forEach((t) => t.stop());

      setLoadingOverlay(true, "Processing recording", "Embedding video into project...");
      try {
        const blob = new Blob(recordedChunks, { type: "video/webm" });
        const dataUrl = await readFileAsDataUrl(blob);
        project.videoData = dataUrl;
        project.videoName = `${window.ChronoExport.safeName(project.name)}.webm`;
        loadVideoSource(dataUrl, project.videoName);
        await persistRecovery();
        showToast("Screen recording ready");
      } catch (err) {
        showAlert("Recording error", err.message, "error");
      } finally {
        setLoadingOverlay(false);
      }
    };

    recordingStream.getVideoTracks()[0].onended = () => {
      if (mediaRecorder?.state === "recording") mediaRecorder.stop();
    };

    recordingSeconds = 0;
    $("recordBadgeClock").textContent = "00:00";
    $("recordClock").textContent = "00:00";
    $("recordBadge").hidden = false;
    $("recordClock").hidden = false;
    $("recordText").textContent = "Stop recording";

    recordingTimer = setInterval(() => {
      recordingSeconds += 1;
      const mins = String(Math.floor(recordingSeconds / 60)).padStart(2, "0");
      const secs = String(recordingSeconds % 60).padStart(2, "0");
      $("recordBadgeClock").textContent = `${mins}:${secs}`;
      $("recordClock").textContent = `${mins}:${secs}`;

      const maxDur = getConfig().MAX_VIDEO_DURATION;
      if (maxDur > 0 && recordingSeconds >= maxDur) {
        playLimitChime();
        if (mediaRecorder?.state === "recording") mediaRecorder.stop();
        showAlert(
          "Recording limit reached",
          `Recording safely stopped at the configured maximum duration (${Math.round(maxDur / 60)} min).`,
          "info",
        );
      }
    }, 1000);

    mediaRecorder.start(500);
  }

  function downloadProject(lite = false) {
    project.name = $("projectName").value.trim() || "Untitled guide";
    project.author = $("authorName").value.trim();
    const payload = {
      format: "ChronoSteps",
      version: "2.0.0",
      project: lite ? { ...project, videoData: null } : project,
    };
    const ext = lite ? "stepslite" : "steps";
    window.ChronoExport.download(
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
      `${window.ChronoExport.safeName(project.name)}.${ext}`,
    );
    showToast(`Saved .${ext} file`);
  }

  async function openProjectFile(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const loaded = parsed.project || parsed.currentProject || parsed;
      if (!loaded || !Array.isArray(loaded.steps)) {
        throw new Error("This file is not a valid Chrono Steps / StepsRecorder project.");
      }
      project = { ...createEmptyProject(), ...loaded };
      $("projectName").value = project.name || "Untitled guide";
      $("authorName").value = project.author || "";

      if (project.videoData) {
        loadVideoSource(project.videoData, project.videoName);
      } else {
        $("stage").classList.add("empty");
        $("empty").hidden = false;
        $("video").removeAttribute("src");
        $("video").load();
      }
      renderProject();
      showToast(`Opened ${file.name}`);
    } catch (err) {
      showAlert("Could not open project", err.message, "error");
    }
  }

  function isTyping(target) {
    return Boolean(target?.closest("input, textarea, select, [contenteditable]"));
  }

  function bindEvents() {
    const video = $("video");

    // Project fields
    $("projectName").oninput = () => persistRecovery();
    $("authorName").oninput = () => persistRecovery();

    // New / Open / Save
    $("newButton").onclick = async () => {
      if (await showConfirm("Start new project?", "Any unsaved changes in the current workspace will be cleared.", "New project", true)) {
        project = createEmptyProject();
        $("projectName").value = project.name;
        $("authorName").value = "";
        $("stage").classList.add("empty");
        $("empty").hidden = false;
        video.removeAttribute("src");
        video.load();
        await window.ChronoStorage.clearRecovery();
        renderProject();
        showToast("Started new project");
      }
    };

    $("openButton").onclick = () => $("projectInput").click();
    $("emptyOpenProject").onclick = () => $("projectInput").click();
    $("projectInput").onchange = (event) => {
      if (event.target.files[0]) openProjectFile(event.target.files[0]);
      event.target.value = "";
    };

    $("saveButton").onclick = () => downloadProject(false);
    $("quickSave").onclick = () => downloadProject(false);
    $("saveLiteButton").onclick = () => downloadProject(true);
    if ($("quickSaveLite")) $("quickSaveLite").onclick = () => downloadProject(true);

    // Video load & record
    $("loadVideo").onclick = () => $("videoInput").click();
    $("videoButton").onclick = () => $("videoInput").click();
    $("emptyLoadVideo").onclick = () => $("videoInput").click();
    $("videoInput").onchange = async (event) => {
      const file = event.target.files[0];
      event.target.value = "";
      if (!file) return;
      setLoadingOverlay(true, "Loading video", file.name);
      try {
        const dataUrl = await readFileAsDataUrl(file);
        project.videoData = dataUrl;
        project.videoName = file.name;
        loadVideoSource(dataUrl, file.name);
        await persistRecovery();
        showToast("Video loaded");
      } catch (err) {
        showAlert("Video load failed", err.message, "error");
      } finally {
        setLoadingOverlay(false);
      }
    };

    $("recordScreen").onclick = toggleScreenRecording;
    $("recordMenu").onclick = toggleScreenRecording;
    if ($("quickRecord")) $("quickRecord").onclick = toggleScreenRecording;
    $("emptyRecord").onclick = toggleScreenRecording;
    $("stopRecord").onclick = toggleScreenRecording;

    // Player controls
    $("play").onclick = () => (video.paused ? video.play() : video.pause());
    $("back").onclick = () => { video.currentTime = Math.max(0, video.currentTime - 10); };
    $("forward").onclick = () => { video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); };
    $("mute").onclick = () => { video.muted = !video.muted; synchronisePlayerControls(); };
    $("menuMute").onclick = () => { video.muted = !video.muted; synchronisePlayerControls(); };
    $("menuAudio").onclick = () => {
      project.excludeAudio = !project.excludeAudio;
      synchronisePlayerControls();
      persistRecovery();
    };
    if ($("cueToggle")) {
      $("cueToggle").onchange = (event) => {
        visualCuesVisible = event.target.checked;
        synchronisePlayerControls();
        drawVideoOverlay();
      };
    }
    $("menuCues").onclick = () => {
      visualCuesVisible = !visualCuesVisible;
      synchronisePlayerControls();
      drawVideoOverlay();
    };
    $("videoToggle").onchange = (event) => {
      $("workspace").classList.toggle("video-hidden", !event.target.checked);
      requestAnimationFrame(resizeOverlayCanvas);
    };

    video.addEventListener("loadedmetadata", () => {
      resizeOverlayCanvas();
      renderTimelinePins();
      updatePlayerDisplay();

      const cfg = getConfig();
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      skipVideoCache = cfg.MAX_CACHED_VIDEO_DURATION > 0 && dur > cfg.MAX_CACHED_VIDEO_DURATION;
      if (!durationLimitNotified && dur > 0) {
        if (cfg.MAX_VIDEO_DURATION > 0 && dur > cfg.MAX_VIDEO_DURATION) {
          durationLimitNotified = true;
          playLimitChime();
          showAlert(
            "Video exceeds max duration",
            `This video is longer than ${Math.round(cfg.MAX_VIDEO_DURATION / 60)} minutes and will not be auto-cached. Remember to save your .steps project or export your video.`,
            "warning",
          );
        } else if (skipVideoCache) {
          durationLimitNotified = true;
          showAlert(
            "Video not auto-cached",
            `This video exceeds the ${Math.round(cfg.MAX_CACHED_VIDEO_DURATION / 60)}-minute local cache limit. You will need to save your project (.steps) or export your video manually.`,
            "info",
          );
        }
      }
    });
    ["play", "pause", "timeupdate", "durationchange", "ended"].forEach((evt) =>
      video.addEventListener(evt, updatePlayerDisplay),
    );
    const tickPlayback = () => {
      if (!video.paused && !video.ended) {
        updatePlayerDisplay();
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
    window.addEventListener("resize", resizeOverlayCanvas);

    // Timeline scrubbing
    const seekFromPointer = (event) => {
      if (!Number.isFinite(video.duration)) return;
      const rect = $("timeline").getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      video.currentTime = ratio * video.duration;
    };
    let scrubbing = false;
    $("timeline").onpointerdown = (event) => {
      scrubbing = true;
      $("timeline").setPointerCapture(event.pointerId);
      seekFromPointer(event);
    };
    $("timeline").onpointermove = (event) => { if (scrubbing) seekFromPointer(event); };
    $("timeline").onpointerup = () => { scrubbing = false; };

    // Range controls
    $("rangeStart").onclick = () => {
      project.trimStart = video.currentTime || 0;
      renderProject();
    };
    $("rangeEnd").onclick = () => {
      project.trimEnd = video.currentTime || 0;
      renderProject();
    };
    $("rangeReset").onclick = async () => {
      if (await showConfirm("Reset project range?", "Clear custom Start and End trim boundaries?", "Reset")) {
        project.trimStart = 0;
        project.trimEnd = 0;
        renderProject();
      }
    };

    // Steps & Redactions triggers
    const startAddStep = () => openStepDialog(null);
    const startShotMode = () => {
      if (!video.src) {
        showAlert("No video loaded", "Load or record a video first, or use Add Step and paste/browse a screenshot.", "info");
        return;
      }
      video.pause();
      setCanvasMode("shot");
    };
    const startMaskMode = () => {
      if (!video.src) {
        showAlert("No video loaded", "Load or record a video before adding a timed redaction.", "info");
        return;
      }
      video.pause();
      setCanvasMode("mask");
    };

    $("addStep").onclick = startAddStep;
    $("menuAdd").onclick = startAddStep;
    $("quickAddStep").onclick = startAddStep;

    $("addShot").onclick = startShotMode;
    $("menuShot").onclick = startShotMode;
    $("quickAddShot").onclick = startShotMode;

    $("addMask").onclick = startMaskMode;
    $("menuRedact").onclick = startMaskMode;
    $("quickAddMask").onclick = startMaskMode;

    $("cancelDraw").onclick = () => setCanvasMode("idle");

    // Overlay canvas pointer interactions (draw mode OR move/resize redactions & step cues)
    const overlay = $("overlay");
    overlay.onpointerdown = (event) => {
      const pt = getCanvasPoint(event);
      if (canvasMode !== "idle") {
        isDrawing = true;
        drawStart = pt;
        drawCurrent = pt;
        overlay.setPointerCapture(event.pointerId);
        return;
      }

      const hit = hitTestBoxInteraction(pt, overlay, video.currentTime || 0);
      if (hit) {
        if (hit.kind === "mask") {
          if (hit.id) selectedMaskId = hit.id;
          selectedStepId = null;
        } else {
          if (hit.id) selectedStepId = hit.id;
          selectedMaskId = null;
        }
        boxInteraction = {
          type: hit.type,
          target: hit.target,
          startPt: pt,
          orig: { x: hit.target.x, y: hit.target.y, w: hit.target.w, h: hit.target.h },
        };
        overlay.setPointerCapture(event.pointerId);
        renderMasksList();
        renderStepsList();
        drawVideoOverlay();
      } else if (selectedMaskId || selectedStepId) {
        selectedMaskId = null;
        selectedStepId = null;
        renderMasksList();
        renderStepsList();
        drawVideoOverlay();
      }
    };

    overlay.onpointermove = (event) => {
      const pt = getCanvasPoint(event);
      if (isDrawing) {
        drawCurrent = pt;
        drawVideoOverlay();
        return;
      }
      if (boxInteraction) {
        const dx = (pt.x - boxInteraction.startPt.x) / Math.max(1, overlay.width);
        const dy = (pt.y - boxInteraction.startPt.y) / Math.max(1, overlay.height);
        const o = boxInteraction.orig;
        const m = boxInteraction.target;
        const minSize = 0.02;

        if (boxInteraction.type === "move") {
          m.x = Math.max(0, Math.min(1 - o.w, o.x + dx));
          m.y = Math.max(0, Math.min(1 - o.h, o.y + dy));
        } else {
          let nx = o.x;
          let ny = o.y;
          let nw = o.w;
          let nh = o.h;
          if (boxInteraction.type.includes("w")) {
            const clampedDx = Math.min(dx, o.w - minSize);
            nx = Math.max(0, o.x + clampedDx);
            nw = o.x + o.w - nx;
          }
          if (boxInteraction.type.includes("e")) {
            nw = Math.max(minSize, Math.min(1 - o.x, o.w + dx));
          }
          if (boxInteraction.type.includes("n")) {
            const clampedDy = Math.min(dy, o.h - minSize);
            ny = Math.max(0, o.y + clampedDy);
            nh = o.y + o.h - ny;
          }
          if (boxInteraction.type.includes("s")) {
            nh = Math.max(minSize, Math.min(1 - o.y, o.h + dy));
          }
          m.x = nx;
          m.y = ny;
          m.w = nw;
          m.h = nh;
        }
        drawVideoOverlay();
        return;
      }

      if (canvasMode === "idle") {
        const hit = hitTestBoxInteraction(pt, overlay, video.currentTime || 0);
        overlay.style.cursor = hit ? hit.cursor : "default";
      }
    };

    overlay.onpointerup = () => {
      if (boxInteraction) {
        boxInteraction = null;
        persistRecovery();
        return;
      }
      if (!isDrawing) return;
      isDrawing = false;
      const result = captureCanvasSelection();
      const mode = canvasMode;
      setCanvasMode("idle");
      if (!result) return;

      if (mode === "shot") {
        pendingCue = result.cue;
        updateStepPreview(result.image);
        openStepDialog(editingStepId, true);
      } else if (mode === "mask") {
        pendingMaskGeometry = result.cue;
        openMaskDialog(null);
      }
    };

    // Step form
    $("stepType").onchange = () => {
      const isSub = $("stepType").value === "substep";
      $("parentWrap").hidden = !isSub;
      if (isSub) populateParentOptions("", editingStepId || "");
    };
    $("stepNow").onclick = () => {
      $("stepTime").value = formatTime(video.currentTime || 0);
    };
    $("selectImage").onclick = () => {
      if (!video.src) {
        showAlert("No video loaded", "Load or record a video to capture a frame.", "info");
        return;
      }
      stepModalInstance.hide();
      video.pause();
      setCanvasMode("shot");
    };
    $("browseImage").onclick = () => $("imageInput").click();
    $("imageInput").onchange = async (event) => {
      const file = event.target.files[0];
      event.target.value = "";
      if (file) {
        pendingCue = null;
        updateStepPreview(await readFileAsDataUrl(file));
      }
    };
    $("removeImage").onclick = () => {
      pendingCue = null;
      updateStepPreview(null);
    };
    $("annotatePending").onclick = () => {
      if (pendingImage) openAnnotationDialog(null, pendingImage);
    };

    // Paste & Drag-Drop in Step Modal
    const dropZone = $("imageDropZone");
    dropZone.onclick = () => dropZone.focus();
    dropZone.onpaste = async (event) => {
      const item = [...(event.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (item) {
        pendingCue = null;
        updateStepPreview(await readFileAsDataUrl(item.getAsFile()));
      }
    };
    dropZone.ondragover = (event) => {
      event.preventDefault();
      dropZone.classList.add("dragover");
    };
    dropZone.ondragleave = () => dropZone.classList.remove("dragover");
    dropZone.ondrop = async (event) => {
      event.preventDefault();
      dropZone.classList.remove("dragover");
      const file = [...(event.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
      if (file) {
        pendingCue = null;
        updateStepPreview(await readFileAsDataUrl(file));
      }
    };

    $("stepForm").onsubmit = (event) => {
      event.preventDefault();
      const time = parseTimeInput($("stepTime").value);
      if (!Number.isFinite(time)) {
        showAlert("Invalid timestamp", "Use hh:mm:ss.mmm, mm:ss, or seconds.", "warning");
        return;
      }
      const type = $("stepType").value;
      const existing = editingStepId ? project.steps.find((s) => s.id === editingStepId) : null;
      const stepData = {
        id: existing ? existing.id : createIdentifier(),
        title: $("stepTitle").value.trim(),
        description: $("stepDetails").value.trim(),
        time,
        type,
        parentId: type === "substep" ? $("parent").value : "",
        image: pendingImage,
        cue: pendingCue,
        order: existing ? existing.order : project.steps.length,
      };
      if (existing) {
        Object.assign(existing, stepData);
      } else {
        project.steps.push(stepData);
      }
      stepModalInstance.hide();
      renderProject();
      showToast(existing ? "Step updated" : "Step added");
    };

    // Mask form
    $("maskNowStart").onclick = () => { $("maskStart").value = formatTime(video.currentTime || 0); };
    $("maskNowEnd").onclick = () => { $("maskEnd").value = formatTime(video.currentTime || 0); };
    $("maskProjectStart").onclick = () => { $("maskStart").value = formatTime(project.trimStart || 0); };
    $("maskProjectEnd").onclick = () => {
      const end = project.trimEnd > 0 ? project.trimEnd : video.duration || 0;
      $("maskEnd").value = formatTime(end);
    };

    $("maskForm").onsubmit = (event) => {
      event.preventDefault();
      const start = parseTimeInput($("maskStart").value);
      const end = parseTimeInput($("maskEnd").value);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        showAlert("Invalid redaction range", "End time must be greater than Start time.", "warning");
        return;
      }
      const existing = editingMaskId ? project.masks.find((m) => m.id === editingMaskId) : null;
      const maskData = {
        id: existing ? existing.id : createIdentifier(),
        ...pendingMaskGeometry,
        start,
        end,
        style: $("maskStyle").value,
      };
      if (existing) Object.assign(existing, maskData);
      else project.masks.push(maskData);

      maskModalInstance.hide();
      renderProject();
      showToast("Redaction saved");
    };

    // Annotation canvas
    document.querySelectorAll("[data-tool]").forEach((btn) => {
      btn.onclick = () => {
        annotationTool = btn.dataset.tool;
        document.querySelectorAll("[data-tool]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      };
    });
    $("annotationUndo").onclick = () => {
      annotationShapes.pop();
      redrawAnnotationCanvas();
    };
    const annCanvas = $("annotationCanvas");
    annCanvas.onpointerdown = (event) => {
      annotationDrawing = true;
      annotationStart = getAnnotationPoint(event);
      annCanvas.setPointerCapture(event.pointerId);
    };
    annCanvas.onpointermove = (event) => {
      if (!annotationDrawing) return;
      const pt = getAnnotationPoint(event);
      redrawAnnotationCanvas({
        tool: annotationTool,
        x: annotationStart.x,
        y: annotationStart.y,
        w: pt.x - annotationStart.x,
        h: pt.y - annotationStart.y,
      });
    };
    annCanvas.onpointerup = (event) => {
      if (!annotationDrawing) return;
      annotationDrawing = false;
      const pt = getAnnotationPoint(event);
      const w = pt.x - annotationStart.x;
      const h = pt.y - annotationStart.y;
      if (Math.abs(w) > 4 && Math.abs(h) > 4) {
        annotationShapes.push({
          tool: annotationTool,
          x: annotationStart.x,
          y: annotationStart.y,
          w,
          h,
        });
      }
      redrawAnnotationCanvas();
    };
    $("annotationSave").onclick = () => {
      const dataUrl = annCanvas.toDataURL("image/png");
      if (annotationTargetStepId) {
        const step = project.steps.find((s) => s.id === annotationTargetStepId);
        if (step) step.image = dataUrl;
        renderProject();
      } else {
        updateStepPreview(dataUrl);
      }
      annotationModalInstance.hide();
      showToast("Annotations applied");
    };

    // Exports
    $("exportOriginal").onclick = () => {
      try {
        window.ChronoExport.original(project);
      } catch (err) {
        showAlert("Export unavailable", err.message, "warning");
      }
    };
    $("exportHtml").onclick = () => {
      window.ChronoExport.html(project);
      showToast("Exported HTML guide");
    };
    $("printPdf").onclick = () => window.ChronoExport.print(project);
    $("exportRendered").onclick = async () => {
      if (!video.src) {
        showAlert("No video loaded", "Load or record a video before rendering.", "warning");
        return;
      }
      $("exportOverlay").hidden = false;
      $("exportOverlayBar").style.width = "0%";
      $("exportOverlayDetail").textContent = "Rendering redacted video...";
      try {
        const blob = await window.ChronoExport.rendered(video, project, (pct) => {
          const percent = Math.round(pct * 100);
          $("exportOverlayBar").style.width = `${percent}%`;
          $("exportOverlayDetail").textContent = `Rendering frames (${percent}%)...`;
        });
        window.ChronoExport.download(
          blob,
          `${window.ChronoExport.safeName(project.name)}-redacted.webm`,
        );
        showToast("Rendered redacted WebM");
      } catch (err) {
        showAlert("Render failed", err.message, "error");
      } finally {
        $("exportOverlay").hidden = true;
      }
    };

    // Help (SweetAlert2)
    $("tipsButton").onclick = () => {
      Swal.fire({
        title: "Chrono Steps Tips",
        icon: "info",
        confirmButtonColor: "#158cba",
        html: `
          <ul class="text-start small mb-0">
            <li class="mb-2"><b>Pause first</b> before drawing screenshot cues or timed redactions.</li>
            <li class="mb-2"><b>Drag & drop</b> step cards onto the middle of another card to nest as a substep (<code>1.1</code>, <code>1.2</code>).</li>
            <li class="mb-2"><b>Save (.steps)</b> bundles your video inside the JSON; <b>Save Lite (.stepslite)</b> omits video for lightweight sharing.</li>
          </ul>
        `,
      });
    };

    $("shortcutsButton").onclick = () => {
      Swal.fire({
        title: "Keyboard Shortcuts",
        icon: "info",
        confirmButtonColor: "#158cba",
        html: `
          <div class="text-start small">
            <div class="d-flex justify-content-between py-1 border-bottom"><span>Play / Pause</span><kbd>Space</kbd></div>
            <div class="d-flex justify-content-between py-1 border-bottom"><span>Seek ±1s (player focused)</span><span><kbd>PgUp</kbd> / <kbd>PgDn</kbd></span></div>
            <div class="d-flex justify-content-between py-1 border-bottom"><span>Add step</span><kbd>Alt+Shift+A</kbd></div>
            <div class="d-flex justify-content-between py-1 border-bottom"><span>Add screenshot step</span><kbd>Alt+Shift+I</kbd></div>
            <div class="d-flex justify-content-between py-1 border-bottom"><span>Add redaction</span><kbd>Alt+Shift+R</kbd></div>
            <div class="d-flex justify-content-between py-1 border-bottom"><span>Save .steps</span><kbd>Ctrl+S</kbd></div>
            <div class="d-flex justify-content-between py-1"><span>Save .stepslite</span><kbd>Alt+S</kbd></div>
          </div>
        `,
      });
    };

    $("aboutButton").onclick = () => {
      Swal.fire({
        title: "Chrono Steps",
        icon: "info",
        confirmButtonColor: "#158cba",
        html: `
          <p class="small text-muted mb-2">100% client-side screen recording, redaction, and illustrated procedure guide studio.</p>
          <p class="small mb-0"><strong>Built by Unfoundry</strong> · Zero external CDNs · Local-first.</p>
        `,
      });
    };

    // Global keyboard shortcuts
    document.addEventListener("keydown", (event) => {
      if (isTyping(event.target)) return;

      if (event.code === "Space" && video.src) {
        event.preventDefault();
        video.paused ? video.play() : video.pause();
      } else if (event.key === "PageUp" && document.activeElement === $("videoPanel")) {
        event.preventDefault();
        video.currentTime = Math.max(0, (video.currentTime || 0) - 1);
      } else if (event.key === "PageDown" && document.activeElement === $("videoPanel")) {
        event.preventDefault();
        video.currentTime = Math.min(video.duration || 0, (video.currentTime || 0) + 1);
      } else if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        downloadProject(false);
      } else if (event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        downloadProject(true);
      } else if (event.ctrlKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        $("projectInput").click();
      } else if (event.altKey && event.shiftKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        startAddStep();
      } else if (event.altKey && event.shiftKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        startShotMode();
      } else if (event.altKey && event.shiftKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        startMaskMode();
      } else if (event.altKey && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        $("newButton").click();
      }
    });

    // PWA install prompt
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      $("btnInstallApp")?.classList.remove("d-none");
    });
    if ($("btnInstallApp")) {
      $("btnInstallApp").onclick = async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        $("btnInstallApp")?.classList.add("d-none");
      };
    }
  }

  let imagePanX = 0;
  let imagePanY = 0;

  function renderImageZoomTransform() {
    $("imagePreviewImg").style.transform = `translate(${imagePanX}px, ${imagePanY}px) scale(${imageZoomScale})`;
    $("zoomLevelLabel").textContent = `${Math.round(imageZoomScale * 100)}%`;
  }

  function openImagePreviewModal(title, src) {
    imageZoomScale = 1;
    imagePanX = 0;
    imagePanY = 0;
    $("imagePreviewTitle").textContent = title || "Screenshot";
    const img = $("imagePreviewImg");
    img.src = src;
    renderImageZoomTransform();
    imagePreviewModalInstance.show();
  }

  function applyImageZoom(nextScale) {
    imageZoomScale = Math.max(0.5, Math.min(3, nextScale));
    if (imageZoomScale <= 1) {
      imagePanX = 0;
      imagePanY = 0;
    }
    renderImageZoomTransform();
  }

  async function init() {
    stepModalInstance = new bootstrap.Modal($("stepModal"));
    maskModalInstance = new bootstrap.Modal($("maskModal"));
    annotationModalInstance = new bootstrap.Modal($("annotationModal"));
    imagePreviewModalInstance = new bootstrap.Modal($("imagePreviewModal"));

    $("zoomInBtn").onclick = () => applyImageZoom(imageZoomScale + 0.25);
    $("zoomOutBtn").onclick = () => applyImageZoom(imageZoomScale - 0.25);
    $("zoomResetBtn").onclick = () => {
      imagePanX = 0;
      imagePanY = 0;
      applyImageZoom(1);
    };

    const viewport = document.querySelector("#imagePreviewModal .image-zoom-viewport");
    let panStart = null;
    viewport.onpointerdown = (e) => {
      panStart = { x: e.clientX - imagePanX, y: e.clientY - imagePanY };
      viewport.classList.add("panning");
      viewport.setPointerCapture(e.pointerId);
    };
    viewport.onpointermove = (e) => {
      if (!panStart) return;
      imagePanX = e.clientX - panStart.x;
      imagePanY = e.clientY - panStart.y;
      renderImageZoomTransform();
    };
    viewport.onpointerup = () => {
      panStart = null;
      viewport.classList.remove("panning");
    };

    cueTooltip = document.createElement("div");
    cueTooltip.className = "cue-tooltip";
    cueTooltip.hidden = true;
    document.body.append(cueTooltip);

    const recovered = await window.ChronoStorage.restoreRecovery();
    if (recovered && Array.isArray(recovered.steps)) {
      project = { ...createEmptyProject(), ...recovered };
      $("projectName").value = project.name || "Untitled guide";
      $("authorName").value = project.author || "";
      if (project.videoData) {
        loadVideoSource(project.videoData, project.videoName);
      }
    }

    bindEvents();
    renderProject();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", init)
    : init();
})();

