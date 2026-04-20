/** Tunable viewer constants. */
const config = {
  /** Maximum pointer travel (CSS px) between down and up to count as a click/annotation. */
  clickMaxDragPx: 10,
  /** Maximum pointer-to-edge distance (CSS px) for bbox side-edit hit-testing. */
  bboxSideHitPx: 10,
  /** Minimum sample spacing for freehand stroke points in CSS pixels. */
  freehandMinSamplePx: 3,
  /** Endpoint distance threshold (CSS px) to auto-close freehand stroke. */
  freehandClosureDistancePx: 10,
  /** Simplification tolerance for freehand polygons in source image pixels. */
  freehandSimplifyTolerance: 0.5,
  /** Reject self-intersecting freehand strokes above this complexity. */
  freehandMaxSelfIntersectionSegments: 3,
  /** Debounce for comment-input annotation save propagation. */
  commentSaveDebounceMs: 500,
};

/** Applies a theme by setting data-theme on <html>. */
function applyTheme(theme: string): void {
  document.documentElement.setAttribute("data-theme", theme);
}

type SettingsMap = Record<string, string>;

/** Persists one or more user settings for the current user. */
async function persistSettingsPatch(patch: SettingsMap): Promise<void> {
  const response = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(`PUT /api/settings failed: ${response.status}`);
  }
}

/** Persists one user setting in the background and logs failures. */
function persistSettingLater(key: string, value: string): void {
  void persistSettingsPatch({ [key]: value }).catch((err) => {
    console.error("settings: persist failed", key, err);
    logEvent("settings_error", { op: "put", key, error: String(err) });
  });
}

/** Debounce timers keyed by setting key for batched setting writes while dragging sliders. */
const settingPersistDebounceTimers = new Map<string, number>();
let commentSaveDebounceTimer: number | null = null;
let modeToastTimer: number | null = null;

/** Persists one user setting after a debounce delay, resetting per-key on repeated calls. */
function persistSettingDebouncedLater(key: string, value: string, delayMs = 300): void {
  const activeTimer = settingPersistDebounceTimers.get(key);
  if (activeTimer !== undefined) {
    window.clearTimeout(activeTimer);
  }
  const timer = window.setTimeout(() => {
    settingPersistDebounceTimers.delete(key);
    persistSettingLater(key, value);
  }, delayMs);
  settingPersistDebounceTimers.set(key, timer);
}

/** Returns true when a value is one of the supported mask-mode keys. */
function isMaskMode(value: string | undefined): value is MaskMode {
  return value === "point" || value === "bounding box" || value === "freehand";
}

/** Schedules debounced annotation save for comment-input edits only. */
function scheduleCommentSaveAnnotations(): void {
  if (commentSaveDebounceTimer !== null) {
    window.clearTimeout(commentSaveDebounceTimer);
  }
  commentSaveDebounceTimer = window.setTimeout(() => {
    commentSaveDebounceTimer = null;
    sendSaveAnnotations();
  }, config.commentSaveDebounceMs);
}

/** Flushes pending debounced comment save before changing active image context. */
function flushPendingCommentSaveAnnotations(): void {
  if (commentSaveDebounceTimer === null) return;
  window.clearTimeout(commentSaveDebounceTimer);
  commentSaveDebounceTimer = null;
  sendSaveAnnotations();
}

/** Converts HSV color to CSS hex string. */
function hsvToRgbCss(h: number, s: number, v: number): string {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = ([[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]] as [number, number, number][])[i % 6];
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Returns a CSS hex color for index n using bit-reversed hue (S=0.75, V=0.90). */
function labelColor(n: number): string {
  const BITS = 8;
  const idx = Math.max(0, Math.floor(n));
  let reversed = 0;
  for (let i = 0; i < BITS; i++) reversed = (reversed << 1) | ((idx >> i) & 1);
  return hsvToRgbCss(reversed / (1 << BITS), 0.75, 0.90);
}

/** Returns a CSS hex fill color for mask index n using bit-reversed hue (S=0.50, V=0.70). */
function maskFillColor(n: number): string {
  const BITS = 8;
  const idx = Math.max(0, Math.floor(n));
  let reversed = 0;
  for (let i = 0; i < BITS; i++) reversed = (reversed << 1) | ((idx >> i) & 1);
  return hsvToRgbCss(reversed / (1 << BITS), 0.50, 0.70);
}

/** Parses #rrggbb into normalized RGB components in [0,1]. */
function cssHexToRgb01(color: string): [number, number, number] {
  const match = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (!match) return [1, 1, 1];
  const value = match[1];
  const r = Number.parseInt(value.slice(0, 2), 16) / 255;
  const g = Number.parseInt(value.slice(2, 4), 16) / 255;
  const b = Number.parseInt(value.slice(4, 6), 16) / 255;
  return [r, g, b];
}

/** WebSocket endpoint for backend events. */
const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${wsProtocol}://${location.host}/ws`);

ws.addEventListener("open", () => {
  console.log("ws: connected");
  openTasksDialog();
});
ws.addEventListener("close", () => console.log("ws: disconnected"));
ws.addEventListener("error", (e) => console.error("ws: error", e));

/** Sends a log entry to the backend over the shared WebSocket. */
function logEvent(type: string, data: Record<string, unknown> = {}): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify({ type: "log", entry: { type, ts: new Date().toISOString(), ...data } }));
}

/** Timeout handles for shortcut-scope focus flash cleanup. */
const scopeFocusFlashTimeouts = new WeakMap<HTMLElement, number>();
/** True while Ctrl is held; used to suppress the mask draw pass. */
let ctrlHeld = false;
/** Maximum number of per-image undo snapshots retained in memory. */
const UNDO_HISTORY_LIMIT = 20;

/** Updates Ctrl-held drawing override and redraws when the value changes. */
function setCtrlHeld(next: boolean): void {
  if (ctrlHeld === next) return;
  ctrlHeld = next;
  viewer?.draw();
}

/** Tracks direct scope focus events for visual flash + telemetry. */
function handleFocusIn(event: FocusEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const scope = target.closest<HTMLElement>("[data-shortcut-scope]");
  if (!scope || scope !== target) return;
  const scopeName = scope.dataset["shortcutScope"];
  if (!scopeName) return;
  const previousTimeout = scopeFocusFlashTimeouts.get(scope);
  if (previousTimeout !== undefined) {
    window.clearTimeout(previousTimeout);
  }
  scope.classList.remove("scope-focus-flash");
  void scope.offsetWidth;
  scope.classList.add("scope-focus-flash");
  const timeoutId = window.setTimeout(() => {
    scope.classList.remove("scope-focus-flash");
    scopeFocusFlashTimeouts.delete(scope);
  }, 500);
  scopeFocusFlashTimeouts.set(scope, timeoutId);
  logEvent("focus_scope", { scope: scopeName });
}

document.addEventListener("focusin", (e) =>
  logEvent("focus", { action: "in", target: (e.target as Element | null)?.tagName ?? "unknown" })
);
document.addEventListener("focusin", handleFocusIn);
document.addEventListener("focusout", (e) =>
  logEvent("focus", { action: "out", target: (e.target as Element | null)?.tagName ?? "unknown" })
);

/** Closes the floating mask label context menu. */
function closeMaskContextMenu(): void {
  appState.maskContextMenu.open = false;
  appState.maskContextMenu.maskId = null;
}

/** Handles canvas-scope keyboard shortcuts. */
function handleCanvasScopeKeydown(e: KeyboardEvent): void {
  if (e.key === "PageUp" || e.key === "PageDown") {
    e.preventDefault();
    cycleOpticsTransform(e.key === "PageUp" ? 1 : -1);
    return;
  }
  if (e.key === "Backspace") {
    e.preventDefault();
    undoLastAnnotationChange();
    return;
  }
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    if (e.key === "ArrowLeft") {
      goPreviousImage();
    } else {
      goNextImage();
    }
    return;
  }
  if (e.key === "Delete") {
    if (appState.selectedMaskId === null) return;
    e.preventDefault();
    removeMask(appState.selectedMaskId);
    appState.selectedMaskId = null;
    updateMaskSelectionUI();
    return;
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    if (appState.masks.length === 0) return;
    e.preventDefault();
    cycleSelectedMask(e.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (!e.ctrlKey && !e.altKey && !e.metaKey) {
    const key = e.key.toLowerCase();
    if (key === "p") {
      e.preventDefault();
      setMaskMode("point");
      return;
    }
    if (key === "r") {
      e.preventDefault();
      setMaskMode("bounding box");
      return;
    }
    if (key === "f") {
      e.preventDefault();
      setMaskMode("freehand");
      return;
    }
  }
  if (e.key !== "Escape") return;
  if (appState.selectedMaskId !== null) {
    e.preventDefault();
    appState.selectedMaskId = null;
    closeMaskContextMenu();
    updateMaskSelectionUI();
    updateMaskContextMenuUI();
    return;
  }
  if (!appState.maskContextMenu.open) return;
  e.preventDefault();
  closeMaskContextMenu();
  updateMaskContextMenuUI();
}

/** Cycles selected mask through index order, including the "none selected" state. */
function cycleSelectedMask(step: 1 | -1): void {
  const orderedMaskIds = appState.masks
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((mask) => mask.id);
  if (orderedMaskIds.length === 0) return;
  const cycle = [null, ...orderedMaskIds];
  const currentPos = Math.max(0, cycle.indexOf(appState.selectedMaskId));
  const nextPos = (currentPos + step + cycle.length) % cycle.length;
  appState.selectedMaskId = cycle[nextPos];
  updateMaskSelectionUI();
}

/** Handles navigation-scope keyboard shortcuts. */
function handleNavigationScopeKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter") return;
  const target = event.target as Element | null;
  const input = target?.closest<HTMLInputElement>('input[data-action="jump-image-index"]');
  if (!input || !appRoot.contains(input)) return;
  if (appState.imageList.length === 0) return;
  event.preventDefault();
  const parsed = Number.parseInt(input.value, 10);
  const oneBased = Number.isFinite(parsed) ? parsed : (appState.currentImageIndex + 1);
  const clamped = Math.max(1, Math.min(appState.imageList.length, oneBased));
  activateImageAtIndex(clamped - 1);
}

/** Handles task-dialog Enter shortcuts (tags, field commit, and new labels). */
function handleTaskDialogScopeKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter") return;
  const target = event.target as Element | null;
  if (!target) return;
  const addTagInput = target.closest<HTMLInputElement>('[data-action="add-tag"]');
  if (addTagInput) {
    event.preventDefault();
    const val = addTagInput.value.trim();
    if (!val) return;
    const task = appState.tasks.find((t) => t.id === addTagInput.getAttribute("data-task-id")) ?? null;
    if (!task) return;
    task.tags.push(val);
    addTagInput.value = "";
    const card = appRoot.querySelector<HTMLElement>(`.task-card[data-task-id="${task.id}"]`);
    if (card) {
      const wrap = card.querySelector<HTMLElement>(".task-tags-wrap");
      if (wrap) wrap.outerHTML = buildTagsWrapHtml(task);
      updateTaskSummaryTags(card, task);
    }
    void runTaskSave(() => persistTaskTags(task), "Failed to save task tags.", "tasks: save tags failed");
    return;
  }

  const fieldInput = target.closest<HTMLInputElement | HTMLTextAreaElement>(".task-field-input[data-field]");
  if (fieldInput && fieldInput.tagName !== "TEXTAREA") {
    event.preventDefault();
    commitTaskFieldInput(fieldInput);
    return;
  }

  const newLabelInput = target.closest<HTMLInputElement>(".label-tree[data-task-id] .label-tree__new");
  if (!newLabelInput) return;
  event.preventDefault();
  const val = newLabelInput.value.trim();
  if (!val) return;
  const tree = newLabelInput.closest<HTMLElement>(".label-tree[data-task-id]");
  const task = appState.tasks.find((t) => t.id === (tree?.dataset["taskId"] ?? "")) ?? null;
  if (!task || !tree) return;
  const newId = labelNodeId();
  task.labels.push({ id: newId, text: val, children: [] });
  task.selectedLabelId = newId;
  refreshLabelTree(tree, task, newId);
  void runTaskSave(() => persistTaskLabels(task), "Failed to save labels.", "tasks: save labels failed");
}

/** Handles task label-tree row shortcuts. */
function handleTaskLabelTreeScopeKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter") {
    handleTaskDialogScopeKeydown(event);
    return;
  }
  if (!appState.isAdmin) return;
  if (
    event.key !== "Tab" &&
    event.key !== "ArrowUp" &&
    event.key !== "ArrowDown" &&
    event.key !== "ArrowLeft" &&
    event.key !== "ArrowRight"
  ) {
    return;
  }
  const target = event.target as Element | null;
  const row = target?.closest<HTMLElement>(".label-tree__row");
  const tree = row?.closest<HTMLElement>('.label-tree[data-task-id][data-shortcut-scope="taskLabelTree"]');
  if (!row || !tree) return;
  const task = appState.tasks.find((t) => t.id === (tree.dataset["taskId"] ?? "")) ?? null;
  if (!task) return;
  const rowNodeId = row.dataset["nodeId"] ?? null;
  if (rowNodeId && task.selectedLabelId !== rowNodeId) {
    task.selectedLabelId = rowNodeId;
    tree.querySelectorAll(".label-tree__row").forEach((labelRow) => {
      labelRow.classList.toggle("is-selected", (labelRow as HTMLElement).dataset["nodeId"] === rowNodeId);
    });
  }
  const persistLabels = () => {
    void runTaskSave(() => persistTaskLabels(task), "Failed to save labels.", "tasks: save labels failed");
  };
  const moveSelectedWithinParent = (delta: number) => {
    if (!task.selectedLabelId) return;
    const meta = findLabelNodeMeta(task.selectedLabelId, task.labels);
    if (!meta) return;
    const nextIdx = meta.index + delta;
    if (nextIdx < 0 || nextIdx >= meta.parentArr.length) return;
    meta.parentArr.splice(meta.index, 1);
    meta.parentArr.splice(nextIdx, 0, meta.node);
    refreshLabelTree(tree, task, task.selectedLabelId);
    persistLabels();
  };
  const promoteSelected = () => {
    if (!task.selectedLabelId) return;
    const meta = findLabelNodeMeta(task.selectedLabelId, task.labels);
    if (!meta || !meta.parentNode || !meta.grandParentArr) return;
    meta.parentArr.splice(meta.index, 1);
    const parentIdx = meta.grandParentArr.findIndex((n) => n.id === meta.parentNode!.id);
    meta.grandParentArr.splice(parentIdx + 1, 0, meta.node);
    refreshLabelTree(tree, task, task.selectedLabelId);
    persistLabels();
  };
  const demoteSelected = () => {
    if (!task.selectedLabelId) return;
    const meta = findLabelNodeMeta(task.selectedLabelId, task.labels);
    if (!meta || meta.index === 0) return;
    const prevSibling = meta.parentArr[meta.index - 1];
    meta.parentArr.splice(meta.index, 1);
    prevSibling.children.push(meta.node);
    refreshLabelTree(tree, task, task.selectedLabelId);
    persistLabels();
  };
  if (event.key === "Tab") {
    const rows = Array.from(tree.querySelectorAll<HTMLElement>(".label-tree__row"));
    if (!rows.length) return;
    event.preventDefault();
    const idx = rows.indexOf(row);
    const step = event.shiftKey ? -1 : 1;
    rows[(idx + step + rows.length) % rows.length].focus();
    return;
  }
  if (event.key === "ArrowUp")   { event.preventDefault(); moveSelectedWithinParent(-1); return; }
  if (event.key === "ArrowDown") { event.preventDefault(); moveSelectedWithinParent(1); return; }
  if (event.key === "ArrowLeft") { event.preventDefault(); promoteSelected(); return; }
  if (event.key === "ArrowRight"){ event.preventDefault(); demoteSelected(); }
}

/** Dispatches keyboard shortcuts by innermost [data-shortcut-scope]. */
function handleKeydown(event: KeyboardEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const scope = target.closest<HTMLElement>("[data-shortcut-scope]");
  const scopeName = scope?.dataset["shortcutScope"];
  if (!scope || !scopeName) return;
  if (scopeName === "canvas") {
    handleCanvasScopeKeydown(event);
    return;
  }
  if (scopeName === "navigation") {
    handleNavigationScopeKeydown(event);
    return;
  }
  if (scopeName === "taskLabelTree") {
    handleTaskLabelTreeScopeKeydown(event);
    return;
  }
  if (scopeName === "taskDialog") {
    handleTaskDialogScopeKeydown(event);
  }
}

document.addEventListener("keydown", handleKeydown);
document.addEventListener("keydown", (event) => {
  if (event.key === "Control") {
    setCtrlHeld(true);
  }
});
document.addEventListener("keyup", (event) => {
  if (event.key === "Control") {
    setCtrlHeld(false);
  }
});
window.addEventListener("blur", () => setCtrlHeld(false));

/** Mutable prototype application state. */
const appState = {
  currentImageIndex: 0,
  imageList: [] as { filename: string; hash: string }[],
  currentImageHash: null as string | null,
  annotationImageWidth: 1,
  annotationImageHeight: 1,
  /** Active task images root path used for full image-path logging. */
  activeTaskImagesPath: "" as string,
  /** Active task annotations root path used for source/destination logging. */
  activeTaskAnnotationsPath: "" as string,
  /** Active task annotation mode; true when using single-file nemolab.json. */
  activeTaskSingleFile: false,
  /** Hash awaiting ordered activation logging once annotations payload arrives. */
  pendingActivationLogHash: null as string | null,
  /** Visible image hash mismatch warnings pushed from backend. */
  imageHashWarnings: [] as ImageHashWarning[],
  leftCollapsed: false,
  rightCollapsed: false,
  rightSidebarWidth: 320,
  masks: [] as MaskPoint[],
  /** Live bbox preview mask shown only while dragging in bbox mode. */
  draftBboxMask: null as MaskPoint | null,
  /** Live freehand stroke preview points shown only while dragging in freehand mode. */
  draftFreehandStroke: null as DraftFreehandStroke | null,
  /** Currently selected mask id, or null when no mask is selected. */
  selectedMaskId: null as string | null,
  /** Per-image undo history snapshots (most recent at end). */
  undoHistory: [] as AnnotationUndoSnapshot[],
  /** Recently assigned labels, most recent first. */
  recentLabels: [] as string[],
  /** Active mask placement mode selected in the right sidebar. */
  maskMode: "point" as MaskMode,
  /** Inline mask-mode status/error message rendered in selector panel. */
  maskModeError: null as string | null,
  /** Context menu state for right-click label assignment on masks. */
  maskContextMenu: {
    open: false,
    clientX: 0,
    clientY: 0,
    maskId: null as string | null,
  },
  /** Flat comment map keyed by "image" or annotation id. */
  annotationComments: {} as AnnotationStringMap,
  /** Flat author map keyed like annotationComments with username values. */
  annotationAuthors: {} as AnnotationStringMap,
  /** Flat mask-creator map keyed by annotation id. */
  annotationMaskAuthors: {} as AnnotationStringMap,
  /** Label tree of the currently active task, shown in the right sidebar. */
  activeLabels: [] as LabelNode[],
  /** Selected label id in the active task's label tree. */
  activeLabelSelectedId: null as string | null,
  /** Whether the top menu bar is visible. */
  menuOpen: false,
  /** Whether the Tasks modal is open. */
  tasksDialogOpen: false,
  /** Whether the Help modal is open. */
  helpDialogOpen: false,
  /** Active Help-dialog tab. */
  helpDialogTab: "shortcuts" as HelpDialogTab,
  /** Whether the current Tasks session is in admin mode (toggled per open). */
  isAdmin: false,
  /** Monotonic token for in-flight tasks fetches. */
  tasksLoadToken: 0,
  /** Whether task dialog data is currently loading from backend. */
  tasksLoading: false,
  /** Number of in-flight task save operations. */
  tasksSavingCount: 0,
  /** Visible task dialog error message (if any). */
  tasksError: null as string | null,
  /** Prototype task list. */
  tasks: [
    {
      id: "t1",
      description: "Review the optics panel and verify gamma correction across zoom levels.",
      status: "doing" as const,
      tags: ["optics", "webgl"],
      images: "/data/images/sample",
      annotations: "/data/annotations/sample.json",
      checkmark: false,
      comment: "Gamma inversion confirmed.",
      collapsed: false,
      labels: [
        { id: "l1", text: "Tissue", children: [
          { id: "l2", text: "Healthy", children: [] },
          { id: "l3", text: "Necrotic", children: [] },
        ]},
        { id: "l4", text: "Background", children: [] },
      ],
      selectedLabelId: "l1",
    },
    {
      id: "t2",
      description: "Add mask support to the right sidebar panel.",
      status: "new" as const,
      tags: ["masks", "ui"],
      images: "",
      annotations: "",
      checkmark: false,
      comment: "",
      collapsed: true,
      labels: [],
      selectedLabelId: null,
    },
    {
      id: "t3",
      description: "Write end-to-end tests for the tile viewport culling logic.",
      status: "done" as const,
      tags: ["testing"],
      images: "",
      annotations: "",
      checkmark: true,
      comment: "All 12 cases pass.",
      collapsed: true,
      labels: [{ id: "l5", text: "Test cases", children: [] }],
      selectedLabelId: "l5",
    },
  ] as Task[],
  /** Current optics adjustment values. */
  optics: {
    /** Gamma exponent applied first (1.0 = no correction). */
    gamma: 1.0,
    /** Multiplicative brightness factor (1.0 = no change). */
    multiply: 1.0,
    /** Additive brightness offset in [0,1] space (-100..100 maps to -100/255..100/255). */
    add: 0.0,
    /** Rotate the view 90 degrees clockwise when true. */
    rotate90cw: false,
    /** Flip the view horizontally when true. */
    flipH: false,
    /** Flip the view vertically when true. */
    flipV: false,
    /** Mask outline opacity in [0,1]. */
    maskStrokeOpacity: 1.0,
    /** Mask fill opacity in [0,1]. */
    maskFillOpacity: 0.4,
    /** Mask stroke width scalar in [1,20]. */
    maskStrokeWidth: 3,
    /** Mask marker diameter in px. */
    markerSize: 10,
  },
};

/** Parses a persisted float string with fallback. */
function parseSettingFloat(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Parses a persisted bool string with fallback. */
function parseSettingBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true";
}

/** Parses a persisted integer string with fallback. */
function parseSettingInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Fetches settings and applies them to app state before first render. */
async function loadSettingsOnStartup(): Promise<void> {
  applyTheme("light");
  appState.maskMode = "point";
  appState.maskModeError = null;
  try {
    const response = await fetch("/api/settings");
    if (!response.ok) {
      throw new Error(`GET /api/settings failed: ${response.status}`);
    }
    const settings = (await response.json()) as Record<string, unknown>;
    const get = (key: string): string | undefined => {
      const value = settings[key];
      return typeof value === "string" ? value : undefined;
    };
    applyTheme(get("theme") === "dark" ? "dark" : "light");
    appState.leftCollapsed = get("sidebar_left") === "hidden";
    appState.rightCollapsed = get("sidebar_right") === "hidden";
    appState.rightSidebarWidth = Math.max(200, parseSettingInt(get("sidebar_right_width"), appState.rightSidebarWidth));
    appState.optics.gamma = parseSettingFloat(get("optics_gamma"), appState.optics.gamma);
    appState.optics.multiply = parseSettingFloat(get("optics_brightness_mul"), appState.optics.multiply);
    appState.optics.add = parseSettingFloat(get("optics_brightness_add"), appState.optics.add);
    appState.optics.rotate90cw = parseSettingBool(get("optics_rotate90cw"), appState.optics.rotate90cw);
    appState.optics.flipH = parseSettingBool(get("optics_flip_h"), appState.optics.flipH);
    appState.optics.flipV = parseSettingBool(get("optics_flip_v"), appState.optics.flipV);
    appState.optics.maskStrokeOpacity = parseSettingFloat(get("mask_stroke_opacity"), appState.optics.maskStrokeOpacity);
    appState.optics.maskFillOpacity = parseSettingFloat(get("mask_fill_opacity"), appState.optics.maskFillOpacity);
    appState.optics.maskStrokeWidth = parseSettingFloat(get("mask_stroke_width"), appState.optics.maskStrokeWidth);
    appState.optics.markerSize = parseSettingFloat(get("mask_marker_size"), appState.optics.markerSize);
    const persistedMaskMode = get("annotation_mode");
    appState.maskMode = isMaskMode(persistedMaskMode) ? persistedMaskMode : "point";
  } catch (err) {
    console.error("settings: load failed", err);
    logEvent("settings_error", { op: "get", error: String(err) });
  }
}

/** Persists all optics-related settings in one request. */
function persistOpticsSettingsLater(): void {
  void persistSettingsPatch({
    optics_gamma: String(appState.optics.gamma),
    optics_brightness_mul: String(appState.optics.multiply),
    optics_brightness_add: String(appState.optics.add),
    optics_rotate90cw: String(appState.optics.rotate90cw),
    optics_flip_h: String(appState.optics.flipH),
    optics_flip_v: String(appState.optics.flipV),
    mask_stroke_opacity: String(appState.optics.maskStrokeOpacity),
    mask_fill_opacity: String(appState.optics.maskFillOpacity),
    mask_stroke_width: String(appState.optics.maskStrokeWidth),
    mask_marker_size: String(appState.optics.markerSize),
  }).catch((err) => {
    console.error("settings: persist optics failed", err);
    logEvent("settings_error", { op: "put", key: "optics", error: String(err) });
  });
}

const OPTICS_TRANSFORM_SEQUENCE: Array<{
  rotate90cw: boolean;
  flipH: boolean;
  flipV: boolean;
}> = [
  { rotate90cw: false, flipH: false, flipV: false }, // 000
  { rotate90cw: true,  flipH: false, flipV: false }, // 100
  { rotate90cw: false, flipH: true,  flipV: true  }, // 011
  { rotate90cw: true,  flipH: true,  flipV: true  }, // 111
  { rotate90cw: false, flipH: true,  flipV: false }, // 010
  { rotate90cw: true,  flipH: true,  flipV: false }, // 110
  { rotate90cw: false, flipH: false, flipV: true  }, // 001
  { rotate90cw: true,  flipH: false, flipV: true  }, // 101
];

const PURE_TRANSFORM_MATRICES: ReadonlyArray<Float32Array> = [
  new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), // 000
  new Float32Array([1, 0, 0, 0, -1, 0, 0, 0, 1]), // 001 V
  new Float32Array([-1, 0, 0, 0, 1, 0, 0, 0, 1]), // 010 H
  new Float32Array([-1, 0, 0, 0, -1, 0, 0, 0, 1]), // 011 H+V
  new Float32Array([0, -1, 0, 1, 0, 0, 0, 0, 1]), // 100 R
  new Float32Array([0, 1, 0, 1, 0, 0, 0, 0, 1]), // 101 R+V
  new Float32Array([0, -1, 0, -1, 0, 0, 0, 0, 1]), // 110 R+H
  new Float32Array([0, 1, 0, -1, 0, 0, 0, 0, 1]), // 111 R+H+V
];

/** Current path shown in the directory browser modal. */
let dirBrowserPath = "/";
/** Callback invoked when the user confirms a directory selection. */
let dirBrowserCallback: ((path: string) => void) | null = null;
/** Cached app version loaded from GET /api/version on first Help-dialog open. */
let helpDialogVersion: string | null = null;
/** Ensures Help-dialog version fetch runs only once. */
let helpDialogVersionFetchAttempted = false;

/** A node in the hierarchical label tree. */
interface LabelNode {
  /** Stable unique identifier. */
  id: string;
  /** Display text. */
  text: string;
  /** Child nodes. */
  children: LabelNode[];
}

/** A single task item in the Tasks dialog. */
interface Task {
  /** Stable unique identifier. */
  id: string;
  /** Full multi-line description. */
  description: string;
  /** Workflow status. */
  status: "new" | "doing" | "done" | "error";
  /** Inline tag labels. */
  tags: string[];
  /** Server-side folder path for associated images. */
  images: string;
  /** Server-side path for annotation folder or file. */
  annotations: string;
  /** Whether the single-file annotation 'nemolab.json' is active. */
  checkmark: boolean;
  /** Free-text comment visible to all users. */
  comment: string;
  /** Whether the card is collapsed in the accordion. */
  collapsed: boolean;
  /** Hierarchical label tree for this task. */
  labels: LabelNode[];
  /** Currently selected label node id, or null. */
  selectedLabelId: string | null;
}

/** Backend label tree node shape for /api/tasks responses. */
interface BackendLabelNode {
  id: string;
  text: string;
  children: BackendLabelNode[];
}

/** Backend task shape for /api/tasks responses. */
interface BackendTask {
  id: string;
  ord: number;
  description: string;
  status: string;
  tags: string[];
  images: string;
  annotations: string;
  checkmark: boolean;
  comment: string;
  labels: BackendLabelNode[];
}

/** Backend response shape for /api/me. */
interface BackendMe {
  username: string;
  is_admin: boolean;
}

/** Minimal point/bbox/freehand mask model for the current image. */
interface MaskPoint {
  /** Stable mask identifier. */
  id: string;
  /** Sequential mask index within the current image. */
  index: number;
  /** Geometry kind represented by this mask. */
  kind: "point" | "bbox" | "freehand";
  /** X coordinate in normalized image space (0..1). */
  x: number;
  /** Y coordinate in normalized image space (0..1). */
  y: number;
  /** Bbox width in normalized image space (0..1), for kind=bbox. */
  w?: number;
  /** Bbox height in normalized image space (0..1), for kind=bbox. */
  h?: number;
  /** Freehand polygon points in normalized image space (0..1), for kind=freehand. */
  points?: Array<{ x: number; y: number }>;
  /** Optional assigned label name. */
  labelName: string | null;
}

/** Supported mask placement modes shown in the sidebar selector. */
type MaskMode = "point" | "bounding box" | "freehand";
type BboxEdge = "x0" | "x1" | "y0" | "y1";
type HelpDialogTab = "shortcuts" | "annotations" | "navigation" | "about";

/** Tile manifest produced by the tiling script. */
interface TileManifest {
  /** Full image width in pixels. */
  width: number;
  /** Full image height in pixels. */
  height: number;
  /** Tile edge length in pixels. */
  tile_size: number;
  /** Number of levels, where 0 is coarsest. */
  levels: number;
  /** URL template for tile fetches. */
  tiles: string;
}

/** In-memory texture metadata for a loaded tile. */
interface LoadedTile {
  /** WebGL texture object. */
  texture: WebGLTexture;
  /** Tile x index at its level. */
  tx: number;
  /** Tile y index at its level. */
  ty: number;
  /** Width in level pixels (edge tiles can be smaller). */
  width: number;
  /** Height in level pixels (edge tiles can be smaller). */
  height: number;
}

/** Current image placement transform in canvas CSS pixels. */
interface ViewTransform {
  /** Left edge of drawn image area. */
  x: number;
  /** Top edge of drawn image area. */
  y: number;
  /** Drawn width. */
  width: number;
  /** Drawn height. */
  height: number;
}

/** Canvas-space tile placement rectangle in CSS pixels. */
interface TilePlacementRect {
  /** Left edge in canvas CSS pixels. */
  x: number;
  /** Top edge in canvas CSS pixels. */
  y: number;
  /** Drawn width in canvas CSS pixels. */
  width: number;
  /** Drawn height in canvas CSS pixels. */
  height: number;
}

/** Canvas click payload used for mask interactions. */
interface MaskCanvasClick {
  /** Mouse button label. */
  button: "left" | "right";
  /** Canvas-local X coordinate in CSS pixels. */
  canvasX: number;
  /** Canvas-local Y coordinate in CSS pixels. */
  canvasY: number;
  /** Source image-normalized X coordinate. */
  imageX: number;
  /** Source image-normalized Y coordinate. */
  imageY: number;
  /** Whether Shift key was held. */
  shiftKey: boolean;
  /** Closest hit mask id when within hit radius. */
  hitMaskId: string | null;
  /** Client X for floating context menu positioning. */
  clientX: number;
  /** Client Y for floating context menu positioning. */
  clientY: number;
}

/** Canvas drag payload used for bbox placement gestures. */
interface MaskCanvasDrag {
  /** Drag lifecycle phase. */
  phase: "start" | "move" | "end";
  /** Canvas-local X coordinate in CSS pixels. */
  canvasX: number;
  /** Canvas-local Y coordinate in CSS pixels. */
  canvasY: number;
  /** Source image-normalized X coordinate. */
  imageX: number;
  /** Source image-normalized Y coordinate. */
  imageY: number;
  /** Accumulated pointer travel in CSS pixels since pointerdown. */
  dragDistance: number;
}

/** Canvas drag payload used for bbox-side editing gestures. */
interface MaskCanvasBboxSideDrag {
  /** Drag lifecycle phase. */
  phase: "start" | "move" | "end";
  /** Target bbox mask id. */
  maskId: string;
  /** Target source-space edge being moved. */
  edge: BboxEdge;
  /** Source image-normalized X coordinate. */
  imageX: number;
  /** Source image-normalized Y coordinate. */
  imageY: number;
}

interface FreehandSample {
  canvasX: number;
  canvasY: number;
  imageX: number;
  imageY: number;
}

interface DraftFreehandStroke {
  points: FreehandSample[];
}

/** Main app container. */
// Non-null assertion is safe: the throw below ensures the app never proceeds without #app.
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const appRoot = document.querySelector<HTMLDivElement>("#app")!;
if (!appRoot) {
  throw new Error("#app root not found");
}

/** Shared WebGL viewer instance bound to current canvas. */
let viewer: WebGLTileViewer | null = null;

/** Returns the active image list entry or null when no task image is loaded. */
function getCurrentImageEntry(): { filename: string; hash: string } | null {
  if (appState.currentImageIndex < 0 || appState.currentImageIndex >= appState.imageList.length) {
    return null;
  }
  return appState.imageList[appState.currentImageIndex] ?? null;
}

/** Returns the active image basename for the left sidebar display. */
function getCurrentImageLabel(): string {
  const filename = getCurrentImageEntry()?.filename;
  if (!filename) return "(none)";
  const base = filename.replace(/\\/g, "/").split("/").pop();
  return base && base.length > 0 ? base : filename;
}

/** Extracts a filename from Content-Disposition, supporting RFC5987 and plain filename=. */
function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"(.*)"$/, "$1"));
    } catch {
      // Fall through to other parsing strategies.
    }
  }
  const quotedMatch = /filename="([^"]+)"/i.exec(value);
  if (quotedMatch?.[1]) return quotedMatch[1];
  const plainMatch = /filename=([^;]+)/i.exec(value);
  if (plainMatch?.[1]) return plainMatch[1].trim().replace(/^"(.*)"$/, "$1");
  return null;
}

/** Sanitizes a suggested filename so browser downloads cannot create nested paths. */
function sanitizeDownloadFilename(name: string | null | undefined, fallback: string): string {
  const raw = (name ?? "").trim();
  if (!raw) return fallback;
  const cleaned = raw
    .replace(/[\\/]/g, "_")
    .replace(/[\r\n]/g, "_")
    .trim();
  return cleaned || fallback;
}

/** Triggers a browser download while keeping the app page loaded. */
function triggerBrowserDownload(url: string, fallbackFilename: string): void {
  void (async () => {
    try {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) {
        throw new Error(`download request failed: ${response.status}`);
      }
      const suggested = filenameFromContentDisposition(response.headers.get("Content-Disposition"));
      const filename = sanitizeDownloadFilename(suggested, fallbackFilename);
      const blob = await response.blob();
      const objectURL = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectURL;
      anchor.download = filename;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectURL), 0);
    } catch (err) {
      console.error("download failed", err);
      logEvent("download_error", { url, error: String(err) });
    }
  })();
}

/** Starts download for the currently active raw image file. */
function downloadCurrentImage(): void {
  const current = getCurrentImageEntry();
  if (!current) return;
  const base = current.filename.split("/").pop() || "image";
  triggerBrowserDownload(`/images/${encodeURIComponent(current.hash)}/raw`, base);
}

/** Starts download for the currently active annotation JSON file. */
function downloadCurrentAnnotation(): void {
  const current = getCurrentImageEntry();
  if (!current) return;
  triggerBrowserDownload(`/api/annotations/download?hash=${encodeURIComponent(current.hash)}`, "annotation.json");
}

interface WsAnnotationImage {
  id: number;
  file_name?: string;
  width?: number;
  height?: number;
}

interface WsAnnotationCategory {
  id: number;
  name: string;
}

interface WsAnnotationRow {
  id: number;
  image_id: number;
  category_id?: number;
  keypoints?: number[];
  num_keypoints?: number;
  bbox?: number[];
  segmentation?: unknown;
}

interface WsAnnotationFile {
  images?: WsAnnotationImage[];
  annotations?: WsAnnotationRow[];
  categories?: WsAnnotationCategory[];
  nemolab_labels?: unknown;
  nemolab_comments?: unknown;
  nemolab_authors?: unknown;
  nemolab_mask_authors?: unknown;
}

type AnnotationStringMap = Record<string, string>;
type ImageHashWarning = { key: string; hash: string; file: string };
interface AnnotationUndoSnapshot {
  masks: MaskPoint[];
  selectedMaskId: string | null;
  annotationComments: AnnotationStringMap;
  annotationAuthors: AnnotationStringMap;
  annotationMaskAuthors: AnnotationStringMap;
}

/** Converts arbitrary WS payload to a typed annotation file with array defaults. */
function normalizeWsAnnotationFile(raw: unknown): Required<WsAnnotationFile> & { hasNemolabSidecars: boolean } {
  if (!raw || typeof raw !== "object") {
    return {
      images: [],
      annotations: [],
      categories: [],
      nemolab_labels: undefined,
      nemolab_comments: undefined,
      nemolab_authors: undefined,
      nemolab_mask_authors: undefined,
      hasNemolabSidecars: false,
    };
  }
  const src = raw as Record<string, unknown>;
  const images = Array.isArray(src["images"]) ? src["images"] as WsAnnotationImage[] : [];
  const annotations = Array.isArray(src["annotations"]) ? src["annotations"] as WsAnnotationRow[] : [];
  const categories = Array.isArray(src["categories"]) ? src["categories"] as WsAnnotationCategory[] : [];
  const hasNemolabSidecars =
    src["nemolab_labels"] !== undefined ||
    src["nemolab_comments"] !== undefined ||
    src["nemolab_authors"] !== undefined ||
    src["nemolab_mask_authors"] !== undefined;
  return {
    images,
    annotations,
    categories,
    nemolab_labels: src["nemolab_labels"],
    nemolab_comments: src["nemolab_comments"],
    nemolab_authors: src["nemolab_authors"],
    nemolab_mask_authors: src["nemolab_mask_authors"],
    hasNemolabSidecars,
  };
}

/** Converts unknown JSON payload into a flat string map; non-string values are ignored. */
function normalizeStringMap(raw: unknown): AnnotationStringMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const src = raw as Record<string, unknown>;
  const out: AnnotationStringMap = {};
  Object.entries(src).forEach(([key, value]) => {
    if (typeof value !== "string") return;
    if (value === "") return;
    out[key] = value;
  });
  return out;
}

/** Escapes HTML-special characters for safe inline template insertion. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Joins two server-style paths while preserving slash direction from base where possible. */
function joinServerPath(base: string, child: string): string {
  if (!base) return child;
  if (!child) return base;
  if (child.startsWith("/") || /^[A-Za-z]:[\\/]/.test(child)) return child;
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const trimmedBase = base.replace(/[\\/]+$/, "");
  const trimmedChild = child.replace(/^[\\/]+/, "");
  return `${trimmedBase}${sep}${trimmedChild}`;
}

/** Returns filename stem without extension. */
function fileStem(path: string): string {
  const parts = path.split(/[\\/]/);
  const name = parts[parts.length - 1] ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Builds full image path from active task images root and image-list filename. */
function getActiveImageFullPath(): string | null {
  const current = getCurrentImageEntry();
  if (!current) return null;
  if (!appState.activeTaskImagesPath) return current.filename;
  return joinServerPath(appState.activeTaskImagesPath, current.filename);
}

/** Computes the active annotation source/destination file path for current image. */
function getActiveAnnotationFilePath(): string | null {
  const current = getCurrentImageEntry();
  const root = appState.activeTaskAnnotationsPath;
  if (!current || !root) return null;
  if (appState.activeTaskSingleFile) {
    return joinServerPath(root, "nemolab.json");
  }
  return joinServerPath(root, `${fileStem(current.filename)}.json`);
}

/** Summarizes annotation primitive counts in one compact string. */
function summarizeAnnotationTypes(rows: WsAnnotationRow[]): string {
  let pointCount = 0;
  let bboxCount = 0;
  let maskCount = 0;
  rows.forEach((ann) => {
    const keypoints = Array.isArray(ann.keypoints) ? ann.keypoints : [];
    if ((typeof ann.num_keypoints === "number" && ann.num_keypoints > 0) || keypoints.length >= 2) {
      pointCount += 1;
    }
    if (Array.isArray(ann.bbox) && ann.bbox.length >= 4) {
      bboxCount += 1;
    }
    if (ann.segmentation !== undefined && ann.segmentation !== null) {
      maskCount += 1;
    }
  });
  const parts: string[] = [];
  if (pointCount > 0) parts.push(`${pointCount} point`);
  if (bboxCount > 0) parts.push(`${bboxCount} bbox`);
  if (maskCount > 0) parts.push(`${maskCount} mask`);
  return parts.length > 0 ? parts.join(", ") : "0 annotations";
}

/** Emits image-switch annotation logs in required order for newly activated image hash. */
function emitImageActivationLogsIfPending(
  hash: string,
  payload: Required<WsAnnotationFile> & { hasNemolabSidecars: boolean }
): void {
  if (appState.pendingActivationLogHash !== hash) return;
  const imageFullPath = getActiveImageFullPath();
  const annotationFilePath = getActiveAnnotationFilePath();
  if (imageFullPath) {
    logEvent("image_activated", { filename: imageFullPath });
  }
  const hasSourceData =
    payload.annotations.length > 0 ||
    payload.images.length > 0 ||
    payload.categories.length > 0 ||
    payload.hasNemolabSidecars;
  if (annotationFilePath && hasSourceData) {
    logEvent("annotations_source", {
      file: annotationFilePath,
      count: payload.annotations.length,
      file_format: payload.hasNemolabSidecars ? "extended_coco" : "coco",
      annotation_types: summarizeAnnotationTypes(payload.annotations),
    });
  }
  if (annotationFilePath) {
    logEvent("annotations_destination", { file: annotationFilePath });
  }
  appState.pendingActivationLogHash = null;
}

/** Builds and sends save_annotations payload from current in-memory mask state. */
function sendSaveAnnotations(): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const hash = appState.currentImageHash;
  if (!hash) return;

  const { width, height } = getEffectiveImageDimensions();
  const fileName = getCurrentImageEntry()?.filename ?? "";
  const currentImageID = appState.currentImageIndex + 1;

  const masks = appState.masks.slice().sort((a, b) => a.index - b.index);
  const categories: WsAnnotationCategory[] = [];
  const categoryIdByName = new Map<string, number>();
  masks.forEach((mask) => {
    const name = mask.labelName?.trim();
    if (!name || categoryIdByName.has(name)) return;
    const id = categories.length + 1;
    categoryIdByName.set(name, id);
    categories.push({ id, name });
  });

  const annotations: WsAnnotationRow[] = masks.map((mask) => ({
    id: maskPersistedNumericID(mask),
    image_id: currentImageID,
    category_id: mask.labelName ? categoryIdByName.get(mask.labelName.trim()) : undefined,
    ...(mask.kind === "bbox"
      ? {
          bbox: [
            mask.x * width,
            mask.y * height,
            Math.max(0, (mask.w ?? 0) * width),
            Math.max(0, (mask.h ?? 0) * height),
          ],
        }
      : mask.kind === "freehand" && Array.isArray(mask.points) && mask.points.length >= 3
      ? {
          segmentation: [
            mask.points.flatMap((point) => [point.x * width, point.y * height]),
          ],
        }
      : {
          keypoints: [mask.x * width, mask.y * height, 2],
          num_keypoints: 1,
        }),
  }));

  ws.send(JSON.stringify({
    type: "save_annotations",
    hash,
    annotations: {
      images: [{ id: currentImageID, file_name: fileName, width, height }],
      annotations,
      categories,
      nemolab_comments: appState.annotationComments,
      nemolab_authors: appState.annotationAuthors,
      nemolab_mask_authors: appState.annotationMaskAuthors,
    },
  }));
}

/** Converts a mask id into persisted numeric COCO annotation id. */
function maskPersistedNumericID(mask: MaskPoint): number {
  const parsed = Number.parseInt(mask.id, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : mask.index;
}

/** Sends prefetch request for current and next nearby images. */
function sendPrefetch(images: { hash: string }[], fromIndex: number): void {
  const hashes = images.slice(fromIndex, fromIndex + 9).map((img) => img.hash);
  if (hashes.length === 0 || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify({ type: "prefetch", hashes }));
}

/** Activates an image list index and resets per-image annotation/view state. */
function activateImageAtIndex(nextIndex: number): void {
  if (appState.imageList.length === 0) {
    return;
  }
  flushPendingCommentSaveAnnotations();
  clearUndoHistory();
  const clamped = Math.max(0, Math.min(appState.imageList.length - 1, Math.round(nextIndex)));
  appState.currentImageIndex = clamped;
  // Clear active hash so remount does not briefly reload the previous image
  // while waiting for the next image_ready event.
  appState.currentImageHash = null;
  appState.pendingActivationLogHash = null;
  appState.annotationImageWidth = 1;
  appState.annotationImageHeight = 1;
  appState.masks = [];
  appState.draftBboxMask = null;
  appState.draftFreehandStroke = null;
  appState.selectedMaskId = null;
  appState.annotationComments = {};
  appState.annotationAuthors = {};
  appState.annotationMaskAuthors = {};
  appState.maskContextMenu.open = false;
  const current = getCurrentImageEntry();
  if (current) {
    logEvent("image_change", { filename: current.filename, hash: current.hash });
  }
  sendPrefetch(appState.imageList, appState.currentImageIndex);
  updateImageStateUI();
}

/** Moves to previous image and resets mask state for the new image. */
function goPreviousImage(): void {
  if (appState.imageList.length === 0) {
    return;
  }
  activateImageAtIndex((appState.currentImageIndex - 1 + appState.imageList.length) % appState.imageList.length);
}

/** Moves to next image and resets mask state for the new image. */
function goNextImage(): void {
  if (appState.imageList.length === 0) {
    return;
  }
  activateImageAtIndex((appState.currentImageIndex + 1) % appState.imageList.length);
}

/** Sends a disk-based fast-forward scan request to find the next unannotated image. */
function requestFastForwardImage(): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const hashes = appState.imageList.map((item) => item.hash);
  if (hashes.length === 0) return;
  ws.send(JSON.stringify({
    type: "find_first_annotated_image",
    hashes,
    current_hash: appState.imageList[appState.currentImageIndex]?.hash ?? "",
  }));
}

ws.addEventListener("message", (event) => {
  let msg: unknown;
  try {
    msg = JSON.parse(event.data as string);
  } catch {
    return;
  }
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    return;
  }
  const m = msg as Record<string, unknown>;

  if (m["type"] === "image_list") {
    flushPendingCommentSaveAnnotations();
    clearUndoHistory();
    const images = Array.isArray(m["images"])
      ? (m["images"] as Array<Record<string, unknown>>)
        .filter((item) => typeof item["filename"] === "string" && typeof item["hash"] === "string")
        .map((item) => ({ filename: String(item["filename"]), hash: String(item["hash"]) }))
      : [];
    appState.imageList = images;
    appState.currentImageIndex = 0;
    appState.currentImageHash = null;
    appState.pendingActivationLogHash = null;
    appState.annotationImageWidth = 1;
    appState.annotationImageHeight = 1;
    appState.masks = [];
    appState.draftBboxMask = null;
    appState.draftFreehandStroke = null;
    appState.selectedMaskId = null;
    appState.annotationComments = {};
    appState.annotationAuthors = {};
    appState.annotationMaskAuthors = {};
    appState.imageHashWarnings = [];
    appState.maskContextMenu.open = false;
    updateImageStateUI();
    if (images.length > 0) {
      sendPrefetch(images, 0);
    }
    return;
  }

  if (m["type"] === "image_ready") {
    const hash = m["hash"];
    if (typeof hash !== "string" || hash.length === 0) {
      return;
    }
    const level = typeof m["level"] === "number" ? m["level"] : 0;
    const totalLevels = typeof m["total_levels"] === "number" ? m["total_levels"] : 0;
    console.log(`ws image_ready hash=${hash.slice(0, 16)} level=${level}/${totalLevels}`);
    const isNewImage = appState.currentImageHash !== hash;
    // Only reset masks when the image changes.
    if (isNewImage) {
      flushPendingCommentSaveAnnotations();
      clearUndoHistory();
      appState.annotationImageWidth = 1;
      appState.annotationImageHeight = 1;
      appState.masks = [];
      appState.draftBboxMask = null;
      appState.draftFreehandStroke = null;
      appState.selectedMaskId = null;
      appState.annotationComments = {};
      appState.annotationAuthors = {};
      appState.annotationMaskAuthors = {};
      appState.maskContextMenu.open = false;
      appState.pendingActivationLogHash = hash;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "load_annotations", hash }));
      }
    }
    appState.currentImageHash = hash;
    if (viewer) {
      if (isNewImage) {
        // New image: full load with zoom reset.
        void viewer.setImage(hash, level);
      } else {
        // Same image, higher-resolution level available: reload tiles in place.
        viewer.refreshTiles(level);
      }
    }
    return;
  }

  if (m["type"] === "annotations_data") {
    const hash = typeof m["hash"] === "string" ? m["hash"] : "";
    if (!hash || hash !== appState.currentImageHash) {
      return;
    }
    const payload = normalizeWsAnnotationFile(m["annotations"]);
    emitImageActivationLogsIfPending(hash, payload);
    appState.annotationComments = normalizeStringMap(payload.nemolab_comments);
    appState.annotationAuthors = normalizeStringMap(payload.nemolab_authors);
    appState.annotationMaskAuthors = normalizeStringMap(payload.nemolab_mask_authors);
    const image = payload.images[0];
    const decodeWidth = Math.max(1, Math.round(typeof image?.width === "number" ? image.width : appState.annotationImageWidth));
    const decodeHeight = Math.max(1, Math.round(typeof image?.height === "number" ? image.height : appState.annotationImageHeight));
    const manifestDims = viewer?.getSourceImageDimensions() ?? null;
    appState.annotationImageWidth = Math.max(
      1,
      Math.round(
        manifestDims && manifestDims.width > 1
          ? manifestDims.width
          : decodeWidth
      )
    );
    appState.annotationImageHeight = Math.max(
      1,
      Math.round(
        manifestDims && manifestDims.height > 1
          ? manifestDims.height
          : decodeHeight
      )
    );

    const categoryNameByID = new Map<number, string>();
    payload.categories.forEach((cat) => {
      if (typeof cat?.id !== "number" || typeof cat?.name !== "string") return;
      categoryNameByID.set(cat.id, cat.name);
    });

    const masks: MaskPoint[] = [];
    payload.annotations.forEach((ann) => {
      if (!ann || typeof ann !== "object") return;
      const segmentation = Array.isArray(ann.segmentation) ? ann.segmentation : [];
      const firstPolygon = Array.isArray(segmentation[0]) ? segmentation[0] : null;
      if (firstPolygon && firstPolygon.length >= 6) {
        const points: Array<{ x: number; y: number }> = [];
        for (let i = 0; i + 1 < firstPolygon.length; i += 2) {
          const px = typeof firstPolygon[i] === "number" ? firstPolygon[i] : NaN;
          const py = typeof firstPolygon[i + 1] === "number" ? firstPolygon[i + 1] : NaN;
          if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
          points.push({
            x: Math.max(0, Math.min(1, px / decodeWidth)),
            y: Math.max(0, Math.min(1, py / decodeHeight)),
          });
        }
        const deduped = dedupeConsecutivePoints(points, 1e-6);
        if (deduped.length >= 3) {
          masks.push({
            id: String(ann.id),
            index: masks.length + 1,
            kind: "freehand",
            x: deduped[0].x,
            y: deduped[0].y,
            points: deduped.map((point) => ({ x: point.x, y: point.y })),
            labelName: typeof ann.category_id === "number" ? (categoryNameByID.get(ann.category_id) ?? null) : null,
          });
          return;
        }
      }
      const bbox = Array.isArray(ann.bbox) ? ann.bbox : [];
      const bx = typeof bbox[0] === "number" ? bbox[0] : NaN;
      const by = typeof bbox[1] === "number" ? bbox[1] : NaN;
      const bw = typeof bbox[2] === "number" ? bbox[2] : NaN;
      const bh = typeof bbox[3] === "number" ? bbox[3] : NaN;
      if (
        bbox.length >= 4 &&
        Number.isFinite(bx) &&
        Number.isFinite(by) &&
        Number.isFinite(bw) &&
        Number.isFinite(bh) &&
        bw > 0 &&
        bh > 0
      ) {
        const x = bx / decodeWidth;
        const y = by / decodeHeight;
        const w = bw / decodeWidth;
        const h = bh / decodeHeight;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return;
        masks.push({
          id: String(ann.id),
          index: masks.length + 1,
          kind: "bbox",
          x,
          y,
          w,
          h,
          labelName: typeof ann.category_id === "number" ? (categoryNameByID.get(ann.category_id) ?? null) : null,
        });
        return;
      }
      const numKeypoints = typeof ann.num_keypoints === "number" ? ann.num_keypoints : 0;
      const keypoints = Array.isArray(ann.keypoints) ? ann.keypoints : [];
      if (numKeypoints <= 0 || keypoints.length < 2) return;
      const px = typeof keypoints[0] === "number" ? keypoints[0] : NaN;
      const py = typeof keypoints[1] === "number" ? keypoints[1] : NaN;
      if (!Number.isFinite(px) || !Number.isFinite(py)) return;
      const x = px / decodeWidth;
      const y = py / decodeHeight;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      masks.push({
        id: String(ann.id),
        index: masks.length + 1,
        kind: "point",
        x,
        y,
        labelName: typeof ann.category_id === "number" ? (categoryNameByID.get(ann.category_id) ?? null) : null,
      });
    });
    appState.masks = masks;
    appState.draftBboxMask = null;
    appState.draftFreehandStroke = null;
    appState.selectedMaskId = null;
    clearUndoHistory();
    closeMaskContextMenu();
    updateAnnotationUI();
    return;
  }

  if (m["type"] === "image_hash_mismatch") {
    const hash = typeof m["hash"] === "string" ? m["hash"] : "";
    const file = typeof m["file"] === "string" ? m["file"] : "";
    if (!hash || !file) return;
    const key = `${hash}|${file}`;
    if (appState.imageHashWarnings.some((warning) => warning.key === key)) return;
    appState.imageHashWarnings = [...appState.imageHashWarnings, { key, hash, file }];
    updateImageHashWarningsUI();
    return;
  }

  if (m["type"] === "first_annotated_image") {
    const hash = typeof m["hash"] === "string" ? m["hash"] : "";
    if (!hash) return;
    const nextIndex = appState.imageList.findIndex((item) => item.hash === hash);
    if (nextIndex < 0) return;
    activateImageAtIndex(nextIndex);
    return;
  }
});

/** Toggles left sidebar visibility state. */
function toggleLeftSidebar(): void {
  appState.leftCollapsed = !appState.leftCollapsed;
  persistSettingLater("sidebar_left", appState.leftCollapsed ? "hidden" : "visible");
  applySidebarVisibilityUI();
  viewer?.resize();
  viewer?.draw();
}

/** Toggles right sidebar visibility state. */
function toggleRightSidebar(): void {
  appState.rightCollapsed = !appState.rightCollapsed;
  persistSettingLater("sidebar_right", appState.rightCollapsed ? "hidden" : "visible");
  applySidebarVisibilityUI();
  viewer?.resize();
  viewer?.draw();
}

/** Applies collapsed sidebar classes/buttons in-place without full app re-render. */
function applySidebarVisibilityUI(): void {
  const layout = appRoot.querySelector<HTMLElement>(".layout");
  if (layout) {
    layout.classList.toggle("left-collapsed", appState.leftCollapsed);
    layout.classList.toggle("right-collapsed", appState.rightCollapsed);
  }
  const leftBtn = appRoot.querySelector<HTMLButtonElement>('button[data-action="toggle-left"]');
  if (leftBtn) leftBtn.textContent = appState.leftCollapsed ? ">" : "<";
  const rightBtn = appRoot.querySelector<HTMLButtonElement>('button[data-action="toggle-right"]');
  if (rightBtn) rightBtn.textContent = appState.rightCollapsed ? "<" : ">";
}

/** Updates the current layout CSS variable for right sidebar width. */
function applyRightSidebarWidth(widthPx: number): void {
  appState.rightSidebarWidth = Math.max(200, Math.round(widthPx));
  const layout = appRoot.querySelector<HTMLElement>(".layout");
  layout?.style.setProperty("--sidebar-right-width", `${appState.rightSidebarWidth}px`);
}

/** Wires right-sidebar resize-handle drag interactions. */
function bindRightSidebarResizeHandle(): void {
  const handle = appRoot.querySelector<HTMLElement>(".sidebar--right .sidebar__resize-handle");
  if (!handle) return;
  if (handle.dataset["boundResize"] === "1") return;
  handle.dataset["boundResize"] = "1";

  handle.addEventListener("pointerdown", (event) => {
    if (appState.rightCollapsed) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const onPointerMove = (moveEvent: PointerEvent): void => {
      const nextWidth = Math.max(200, document.body.clientWidth - moveEvent.clientX);
      applyRightSidebarWidth(nextWidth);
    };
    const onPointerUp = (): void => {
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerUp);
      handle.removeEventListener("pointercancel", onPointerUp);
      persistSettingLater("sidebar_right_width", String(appState.rightSidebarWidth));
    };
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);
  });
}

/** Binds global navigation/sidebar-toggle actions once via appRoot delegation. */
function bindGlobalNavHandlers(): void {
  if ((bindGlobalNavHandlers as { _bound?: boolean })._bound) return;
  (bindGlobalNavHandlers as { _bound?: boolean })._bound = true;
  appRoot.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    const imageView = target.closest<HTMLElement>(".image-view");
    if (imageView && appRoot.contains(imageView)) {
      imageView.focus();
    }
    if (target.closest('[data-action="previous"]')) {
      goPreviousImage();
      return;
    }
    if (target.closest('[data-action="next"]')) {
      goNextImage();
      return;
    }
    if (target.closest('[data-action="toggle-left"]')) {
      toggleLeftSidebar();
      return;
    }
    if (target.closest('[data-action="toggle-right"]')) {
      toggleRightSidebar();
      return;
    }
    if (target.closest('[data-action="fast-forward"]')) {
      requestFastForwardImage();
      return;
    }
    if (target.closest('[data-action="download-image"]')) {
      downloadCurrentImage();
      return;
    }
    if (target.closest('[data-action="download-annotation"]')) {
      downloadCurrentAnnotation();
      return;
    }
    const dismissWarningBtn = target.closest<HTMLButtonElement>('[data-action="dismiss-image-hash-warning"]');
    if (dismissWarningBtn) {
      const warningKey = dismissWarningBtn.dataset["warningKey"] ?? "";
      if (!warningKey) return;
      appState.imageHashWarnings = appState.imageHashWarnings.filter((warning) => warning.key !== warningKey);
      updateImageHashWarningsUI();
    }
  });
}


/** Creates a compact unique ID for a new mask point. */
function createMaskId(): string {
  return `m-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

/** Returns first leaf label id in depth-first order, or null if tree is empty. */
function firstLeafLabelId(nodes: LabelNode[]): string | null {
  for (const node of nodes) {
    if (node.children.length === 0) {
      return node.id;
    }
    const childLeaf = firstLeafLabelId(node.children);
    if (childLeaf) return childLeaf;
  }
  return null;
}

/** Finds a label node by id in a hierarchical tree. */
function findLabelNodeById(nodes: LabelNode[], id: string): LabelNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findLabelNodeById(node.children, id);
    if (found) return found;
  }
  return null;
}

/** Finds first label node id by name in a hierarchical tree. */
function findLabelNodeIdByName(nodes: LabelNode[], name: string): string | null {
  for (const node of nodes) {
    if (node.text === name) return node.id;
    const found = findLabelNodeIdByName(node.children, name);
    if (found) return found;
  }
  return null;
}

/** Returns currently selected default label name from active labels, or null. */
function getSelectedLabelName(): string | null {
  const selectedId = appState.activeLabelSelectedId;
  if (!selectedId) return null;
  return findLabelNodeById(appState.activeLabels, selectedId)?.text ?? null;
}

/** Returns all label names from a hierarchical label tree in pre-order. */
function flattenLabelNames(nodes: LabelNode[]): string[] {
  const out: string[] = [];
  const walk = (items: LabelNode[]): void => {
    items.forEach((node) => {
      const name = node.text.trim();
      if (name) out.push(name);
      if (node.children.length > 0) walk(node.children);
    });
  };
  walk(nodes);
  return out;
}

/** Builds depth-first label-name index map for active label color lookup. */
function buildLabelDepthFirstIndexMap(nodes: LabelNode[]): Map<string, number> {
  const out = new Map<string, number>();
  let nextIndex = 0;
  const walk = (items: LabelNode[]): void => {
    items.forEach((node) => {
      if (!out.has(node.text)) {
        out.set(node.text, nextIndex);
      }
      nextIndex += 1;
      if (node.children.length > 0) walk(node.children);
    });
  };
  walk(nodes);
  return out;
}

/** Moves label to front of recent labels while preserving order and uniqueness. */
function touchRecentLabel(labelName: string): void {
  const next = [labelName, ...appState.recentLabels.filter((name) => name !== labelName)];
  appState.recentLabels = next;
}

/** Returns context-menu labels: recents first, then remaining task labels. */
function getMaskContextMenuLabels(): string[] {
  const allLabels = flattenLabelNames(appState.activeLabels);
  return [...appState.recentLabels, ...allLabels.filter((name) => !appState.recentLabels.includes(name))];
}

/** Returns a deep-cloned mask for undo snapshots. */
function cloneMaskForUndo(mask: MaskPoint): MaskPoint {
  return {
    ...mask,
    points: mask.points?.map((point) => ({ x: point.x, y: point.y })),
  };
}

/** Captures the current per-image annotation state as a single undo snapshot. */
function snapshotAnnotationStateForUndo(): AnnotationUndoSnapshot {
  return {
    masks: appState.masks.map((mask) => cloneMaskForUndo(mask)),
    selectedMaskId: appState.selectedMaskId,
    annotationComments: { ...appState.annotationComments },
    annotationAuthors: { ...appState.annotationAuthors },
    annotationMaskAuthors: { ...appState.annotationMaskAuthors },
  };
}

/** Pushes one undo snapshot, trimming oldest entries to the configured limit. */
function pushUndoSnapshot(): void {
  appState.undoHistory.push(snapshotAnnotationStateForUndo());
  if (appState.undoHistory.length > UNDO_HISTORY_LIMIT) {
    appState.undoHistory.splice(0, appState.undoHistory.length - UNDO_HISTORY_LIMIT);
  }
}

/** Drops all undo history entries for the current image context. */
function clearUndoHistory(): void {
  appState.undoHistory = [];
}

/** Restores the previous annotation snapshot and persists the reverted state. */
function undoLastAnnotationChange(): void {
  const snapshot = appState.undoHistory.pop();
  if (!snapshot) return;
  appState.masks = snapshot.masks.map((mask) => cloneMaskForUndo(mask));
  const selectedMaskExists = snapshot.selectedMaskId !== null &&
    appState.masks.some((mask) => mask.id === snapshot.selectedMaskId);
  appState.selectedMaskId = selectedMaskExists ? snapshot.selectedMaskId : null;
  appState.annotationComments = { ...snapshot.annotationComments };
  appState.annotationAuthors = { ...snapshot.annotationAuthors };
  appState.annotationMaskAuthors = { ...snapshot.annotationMaskAuthors };
  appState.draftBboxMask = null;
  appState.draftFreehandStroke = null;
  closeMaskContextMenu();
  updateMaskSelectionUI();
  updateMaskContextMenuUI();
  if (appState.currentImageHash) {
    sendSaveAnnotations();
  }
}

/** Applies a label to a mask and emits assignment logging. */
function assignLabelToMask(maskId: string, labelName: string, recordUndo = true): void {
  const mask = appState.masks.find((m) => m.id === maskId);
  if (!mask) return;
  if (recordUndo) {
    pushUndoSnapshot();
  }
  mask.labelName = labelName;
  touchRecentLabel(labelName);
  const assignedId = findLabelNodeIdByName(appState.activeLabels, labelName);
  if (assignedId) {
    appState.activeLabelSelectedId = assignedId;
    updateActiveLabelPanel();
  }
  if (appState.currentImageHash) {
    logEvent("label_assigned", {
      image_hash: appState.currentImageHash,
      mask_index: mask.index,
      label_name: labelName,
    });
    sendSaveAnnotations();
  }
}

/** Adds a mask point and applies last-used label if available. */
function addMask(x: number, y: number): void {
  pushUndoSnapshot();
  const nextIndex = appState.masks.reduce((max, mask) => Math.max(max, mask.index), 0) + 1;
  const defaultLabel = getSelectedLabelName();
  const mask: MaskPoint = {
    id: createMaskId(),
    index: nextIndex,
    kind: "point",
    x,
    y,
    labelName: defaultLabel,
  };
  appState.masks.push(mask);
  if (appState.currentImageHash) {
    logEvent("mask_created", {
      image_hash: appState.currentImageHash,
      mask_index: mask.index,
      x: mask.x,
      y: mask.y,
    });
    sendSaveAnnotations();
  }
  if (mask.labelName) {
    assignLabelToMask(mask.id, mask.labelName, false);
  }
  updateAnnotationUI();
}

/** Builds canonical bbox coordinates from two opposite corners in normalized space. */
function normalizeBboxFromCorners(
  x0: number,
  y0: number,
  x1: number,
  y1: number
): { x: number; y: number; w: number; h: number } {
  const minX = Math.max(0, Math.min(1, Math.min(x0, x1)));
  const minY = Math.max(0, Math.min(1, Math.min(y0, y1)));
  const maxX = Math.max(0, Math.min(1, Math.max(x0, x1)));
  const maxY = Math.max(0, Math.min(1, Math.max(y0, y1)));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Applies one dragged source-space edge to a bbox mask while preserving non-negative size. */
function applyDraggedBboxEdge(mask: MaskPoint, edge: BboxEdge, imageX: number, imageY: number): void {
  if (mask.kind !== "bbox") return;
  const minSize = 1e-6;
  let x0 = mask.x;
  let y0 = mask.y;
  let x1 = mask.x + Math.max(0, mask.w ?? 0);
  let y1 = mask.y + Math.max(0, mask.h ?? 0);
  const nx = Math.max(0, Math.min(1, imageX));
  const ny = Math.max(0, Math.min(1, imageY));
  if (edge === "x0") {
    x0 = Math.max(0, Math.min(nx, x1 - minSize));
  } else if (edge === "x1") {
    x1 = Math.min(1, Math.max(nx, x0 + minSize));
  } else if (edge === "y0") {
    y0 = Math.max(0, Math.min(ny, y1 - minSize));
  } else {
    y1 = Math.min(1, Math.max(ny, y0 + minSize));
  }
  mask.x = x0;
  mask.y = y0;
  mask.w = Math.max(minSize, x1 - x0);
  mask.h = Math.max(minSize, y1 - y0);
}

/** Adds a bbox mask from two opposite corners and applies selected label if available. */
function addBboxMask(x0: number, y0: number, x1: number, y1: number): void {
  const { x, y, w, h } = normalizeBboxFromCorners(x0, y0, x1, y1);
  if (w <= 0 || h <= 0) return;

  pushUndoSnapshot();
  const nextIndex = appState.masks.reduce((max, mask) => Math.max(max, mask.index), 0) + 1;
  const defaultLabel = getSelectedLabelName();
  const mask: MaskPoint = {
    id: createMaskId(),
    index: nextIndex,
    kind: "bbox",
    x,
    y,
    w,
    h,
    labelName: defaultLabel,
  };
  appState.masks.push(mask);
  if (appState.currentImageHash) {
    logEvent("mask_created", {
      image_hash: appState.currentImageHash,
      mask_index: mask.index,
      x: mask.x,
      y: mask.y,
    });
    sendSaveAnnotations();
  }
  if (mask.labelName) {
    assignLabelToMask(mask.id, mask.labelName, false);
  }
  updateAnnotationUI();
}

interface GeometryPoint {
  x: number;
  y: number;
}

type SegmentIntersectionDetailed =
  | { kind: "point"; tA: number; tB: number; point: GeometryPoint }
  | { kind: "overlap"; a0: number; a1: number; b0: number; b1: number; p0: GeometryPoint; p1: GeometryPoint; length: number };

/** Returns Euclidean distance in pixels between two points. */
function distancePx(a: GeometryPoint, b: GeometryPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Returns image dimensions for geometry/save: viewer manifest first, then app-state fallback. */
function getEffectiveImageDimensions(): { width: number; height: number } {
  const viewerDims = viewer?.getSourceImageDimensions() ?? null;
  if (viewerDims && viewerDims.width > 1 && viewerDims.height > 1) {
    return {
      width: Math.max(1, Math.round(viewerDims.width)),
      height: Math.max(1, Math.round(viewerDims.height)),
    };
  }
  return {
    width: Math.max(1, Math.round(appState.annotationImageWidth)),
    height: Math.max(1, Math.round(appState.annotationImageHeight)),
  };
}

function subPx(a: GeometryPoint, b: GeometryPoint): GeometryPoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

function dotPx(a: GeometryPoint, b: GeometryPoint): number {
  return a.x * b.x + a.y * b.y;
}

function crossPx(a: GeometryPoint, b: GeometryPoint): number {
  return a.x * b.y - a.y * b.x;
}

function lerpPx(a: GeometryPoint, b: GeometryPoint, t: number): GeometryPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Converts a normalized image-space point to source pixel coordinates. */
function normalizedToImagePx(point: GeometryPoint): GeometryPoint {
  const dims = getEffectiveImageDimensions();
  return {
    x: point.x * dims.width,
    y: point.y * dims.height,
  };
}

/** Converts a source pixel-space point to normalized image coordinates. */
function imagePxToNormalized(point: GeometryPoint): GeometryPoint {
  const dims = getEffectiveImageDimensions();
  return {
    x: Math.max(0, Math.min(1, point.x / dims.width)),
    y: Math.max(0, Math.min(1, point.y / dims.height)),
  };
}

/** Returns absolute polygon area using shoelace formula. */
function polygonArea(points: GeometryPoint[]): number {
  if (points.length < 3) return 0;
  let acc = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    acc += a.x * b.y - b.x * a.y;
  }
  return Math.abs(acc) * 0.5;
}

function signedArea(points: GeometryPoint[]): number {
  if (points.length < 3) return 0;
  let acc = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    acc += a.x * b.y - b.x * a.y;
  }
  return acc * 0.5;
}

function ensureCCW(points: GeometryPoint[]): GeometryPoint[] {
  return signedArea(points) < 0 ? points.slice().reverse() : points.slice();
}

/** Returns canonical point-key string for graph snap lookup. */
function pointKey(point: GeometryPoint): string {
  return `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`;
}

/** Removes adjacent duplicates and near-duplicates from point lists. */
function dedupeConsecutivePoints(points: GeometryPoint[], epsilon = 1e-6): GeometryPoint[] {
  const out: GeometryPoint[] = [];
  points.forEach((point) => {
    const prev = out[out.length - 1];
    if (prev && distancePx(prev, point) <= epsilon) return;
    out.push({ x: point.x, y: point.y });
  });
  return out;
}

/** Returns signed triangle area helper for orientation checks. */
function orient2d(a: GeometryPoint, b: GeometryPoint, c: GeometryPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Returns segment-segment intersection with segment-relative t values, or null. */
function intersectSegments(
  a0: GeometryPoint,
  a1: GeometryPoint,
  b0: GeometryPoint,
  b1: GeometryPoint,
  epsilon = 1e-9
): { point: GeometryPoint; tA: number; tB: number } | null {
  const hit = segmentIntersectionDetailed(a0, a1, b0, b1, epsilon);
  if (!hit || hit.kind !== "point") return null;
  return { point: hit.point, tA: hit.tA, tB: hit.tB };
}

function segParam(pointOnSegment: GeometryPoint, a: GeometryPoint, b: GeometryPoint): number {
  const ab = subPx(b, a);
  const denom = dotPx(ab, ab);
  if (denom <= 1e-9) return 0;
  return dotPx(subPx(pointOnSegment, a), ab) / denom;
}

/** Segment intersection with overlap handling for robust splitting. */
function segmentIntersectionDetailed(
  a0: GeometryPoint,
  a1: GeometryPoint,
  b0: GeometryPoint,
  b1: GeometryPoint,
  epsilon = 1e-9
): SegmentIntersectionDetailed | null {
  const r = subPx(a1, a0);
  const s = subPx(b1, b0);
  const rxs = crossPx(r, s);
  const qmp = subPx(b0, a0);
  const qmpxr = crossPx(qmp, r);

  if (Math.abs(rxs) <= epsilon && Math.abs(qmpxr) <= epsilon) {
    const rr = dotPx(r, r);
    if (rr <= epsilon) return null;
    const t0 = dotPx(subPx(b0, a0), r) / rr;
    const t1 = dotPx(subPx(b1, a0), r) / rr;
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(1, Math.max(t0, t1));
    if (hi - lo <= epsilon) return null;
    const p0 = lerpPx(a0, a1, lo);
    const p1 = lerpPx(a0, a1, hi);
    const length = distancePx(p0, p1);
    if (length <= epsilon) return null;
    return {
      kind: "overlap",
      a0: lo,
      a1: hi,
      b0: segParam(p0, b0, b1),
      b1: segParam(p1, b0, b1),
      p0,
      p1,
      length,
    };
  }

  if (Math.abs(rxs) <= epsilon) return null;

  const t = crossPx(qmp, s) / rxs;
  const u = crossPx(qmp, r) / rxs;
  if (t < -epsilon || t > 1 + epsilon || u < -epsilon || u > 1 + epsilon) return null;
  const tt = Math.max(0, Math.min(1, t));
  const uu = Math.max(0, Math.min(1, u));
  return {
    kind: "point",
    tA: tt,
    tB: uu,
    point: lerpPx(a0, a1, tt),
  };
}

function pushUniqueNumber(arr: number[], value: number, epsilon = 1e-8): void {
  for (const existing of arr) {
    if (Math.abs(existing - value) <= epsilon) return;
  }
  arr.push(value);
}

function buildSegmentsFromParams(polyline: GeometryPoint[], params: number[][]): GeometryPoint[][] {
  const out: GeometryPoint[][] = [];
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const values = params[i].slice().sort((x, y) => x - y);
    const uniq: number[] = [];
    for (const t of values) {
      if (uniq.length === 0 || Math.abs(t - uniq[uniq.length - 1]) > 1e-8) uniq.push(t);
    }
    for (let k = 0; k < uniq.length - 1; k += 1) {
      const t0 = uniq[k];
      const t1 = uniq[k + 1];
      if (t1 - t0 <= 1e-8) continue;
      const s0 = lerpPx(a, b, t0);
      const s1 = lerpPx(a, b, t1);
      if (distancePx(s0, s1) <= 1e-7) continue;
      out.push([s0, s1]);
    }
  }
  return out;
}

/** Splits subject polyline by cutter intersections with vertex-landing handling. */
function splitPolyline(subject: GeometryPoint[], cutter: GeometryPoint[]): GeometryPoint[][] {
  if (subject.length < 2) return [];
  if (cutter.length < 2) return [subject.map((point) => ({ x: point.x, y: point.y }))];

  const cuts: Array<{ globalT: number; point: GeometryPoint }> = [];
  const subjectMaxT = subject.length - 1;
  const shouldKeepGlobalT = (value: number) => value > 1e-8 && value < subjectMaxT - 1e-8;
  for (let i = 0; i < subject.length - 1; i += 1) {
    const a0 = subject[i];
    const a1 = subject[i + 1];
    for (let j = 0; j < cutter.length - 1; j += 1) {
      const b0 = cutter[j];
      const b1 = cutter[j + 1];
      const hit = segmentIntersectionDetailed(a0, a1, b0, b1);
      if (!hit) continue;
      if (hit.kind === "point") {
        let globalT = i + hit.tA;
        if (hit.tA <= 1e-8) globalT = i;
        if (hit.tA >= 1 - 1e-8) globalT = i + 1;
        if (!shouldKeepGlobalT(globalT)) continue;
        cuts.push({ globalT, point: globalT === i + 1 ? { x: a1.x, y: a1.y } : { x: hit.point.x, y: hit.point.y } });
      } else {
        let globalT0 = i + hit.a0;
        if (hit.a0 <= 1e-8) globalT0 = i;
        if (hit.a0 >= 1 - 1e-8) globalT0 = i + 1;
        if (shouldKeepGlobalT(globalT0)) {
          cuts.push({ globalT: globalT0, point: globalT0 === i + 1 ? { x: a1.x, y: a1.y } : { x: hit.p0.x, y: hit.p0.y } });
        }
        if (Math.abs(hit.a1 - hit.a0) > 1e-8) {
          let globalT1 = i + hit.a1;
          if (hit.a1 <= 1e-8) globalT1 = i;
          if (hit.a1 >= 1 - 1e-8) globalT1 = i + 1;
          if (shouldKeepGlobalT(globalT1)) {
            cuts.push({ globalT: globalT1, point: globalT1 === i + 1 ? { x: a1.x, y: a1.y } : { x: hit.p1.x, y: hit.p1.y } });
          }
        }
      }
    }
  }

  cuts.sort((a, b) => a.globalT - b.globalT);
  const deduped: Array<{ globalT: number; point: GeometryPoint }> = [];
  for (const cut of cuts) {
    const prev = deduped[deduped.length - 1];
    if (!prev || Math.abs(cut.globalT - prev.globalT) > 1e-8) {
      deduped.push(cut);
    }
  }
  if (deduped.length === 0) {
    return [subject.map((point) => ({ x: point.x, y: point.y }))];
  }

  const result: GeometryPoint[][] = [];
  let current: GeometryPoint[] = [{ x: subject[0].x, y: subject[0].y }];
  let cutIdx = 0;

  for (let i = 0; i < subject.length - 1; i += 1) {
    const segEndT = i + 1;
    while (cutIdx < deduped.length && deduped[cutIdx].globalT < segEndT - 1e-8) {
      const cut = deduped[cutIdx];
      if (cut.globalT > i + 1e-8) {
        const last = current[current.length - 1];
        if (!last || distancePx(last, cut.point) > 1e-7) current.push({ x: cut.point.x, y: cut.point.y });
        if (current.length >= 2) result.push(current);
        current = [{ x: cut.point.x, y: cut.point.y }];
      }
      cutIdx += 1;
    }
    const segEnd = subject[i + 1];
    const last = current[current.length - 1];
    if (!last || distancePx(last, segEnd) > 1e-7) current.push({ x: segEnd.x, y: segEnd.y });
    while (cutIdx < deduped.length && Math.abs(deduped[cutIdx].globalT - segEndT) <= 1e-8) {
      if (current.length >= 2) result.push(current);
      current = [{ x: segEnd.x, y: segEnd.y }];
      cutIdx += 1;
    }
  }

  if (current.length >= 2) result.push(current);
  return result.filter((polyline) => polyline.length >= 2 && distancePx(polyline[0], polyline[polyline.length - 1]) > 1e-7);
}

function collectSelfIntersections(stroke: GeometryPoint[]): Array<{ segA: number; segB: number; point: GeometryPoint; tA: number; tB: number }> {
  const hits: Array<{ segA: number; segB: number; point: GeometryPoint; tA: number; tB: number }> = [];
  for (let i = 0; i < stroke.length - 1; i += 1) {
    const a0 = stroke[i];
    const a1 = stroke[i + 1];
    for (let j = i + 2; j < stroke.length - 1; j += 1) {
      const b0 = stroke[j];
      const b1 = stroke[j + 1];
      const hit = segmentIntersectionDetailed(a0, a1, b0, b1);
      if (!hit || hit.kind !== "point") continue;
      if (hit.tA <= 1e-6 || hit.tA >= 1 - 1e-6) continue;
      if (hit.tB <= 1e-6 || hit.tB >= 1 - 1e-6) continue;
      hits.push({ segA: i, segB: j, point: hit.point, tA: hit.tA, tB: hit.tB });
    }
  }
  return hits;
}

/** Splits self-intersecting stroke into segment pieces and counts crossings. */
function splitSelfIntersecting(stroke: GeometryPoint[]): { segments: GeometryPoint[][]; intersections: number } {
  if (stroke.length < 2) return { segments: [], intersections: 0 };
  const params = Array.from({ length: stroke.length - 1 }, () => [0, 1]);
  const intersections = collectSelfIntersections(stroke);
  for (const hit of intersections) {
    pushUniqueNumber(params[hit.segA], hit.tA);
    pushUniqueNumber(params[hit.segB], hit.tB);
  }
  return { segments: buildSegmentsFromParams(stroke, params), intersections: intersections.length };
}

function canonicalCycleKey(nodes: string[]): string {
  if (nodes.length < 3) return "";
  const n = nodes.length;
  const forward = nodes.slice();
  const reverse = nodes.slice().reverse();
  const minRotation = (arr: string[]): string => {
    let best = 0;
    for (let i = 1; i < n; i += 1) {
      for (let k = 0; k < n; k += 1) {
        const lhs = arr[(i + k) % n];
        const rhs = arr[(best + k) % n];
        if (lhs < rhs) { best = i; break; }
        if (lhs > rhs) break;
      }
    }
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) out.push(arr[(best + i) % n]);
    return out.join("|");
  };
  const k1 = minRotation(forward);
  const k2 = minRotation(reverse);
  return k1 < k2 ? k1 : k2;
}

function nodeAllSegments(segmentPolylines: GeometryPoint[][]): Array<[GeometryPoint, GeometryPoint]> {
  const segments: Array<[GeometryPoint, GeometryPoint]> = [];
  for (const polyline of segmentPolylines) {
    if (!polyline || polyline.length < 2) continue;
    for (let i = 0; i < polyline.length - 1; i += 1) {
      const a = polyline[i];
      const b = polyline[i + 1];
      if (distancePx(a, b) <= 1e-8) continue;
      segments.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }]);
    }
  }

  const cuts: number[][] = Array.from({ length: segments.length }, () => [0, 1]);
  for (let i = 0; i < segments.length; i += 1) {
    const [a0, a1] = segments[i];
    for (let j = i + 1; j < segments.length; j += 1) {
      const [b0, b1] = segments[j];
      const hit = segmentIntersectionDetailed(a0, a1, b0, b1);
      if (!hit) continue;
      if (hit.kind === "point") {
        pushUniqueNumber(cuts[i], hit.tA);
        pushUniqueNumber(cuts[j], hit.tB);
      } else {
        pushUniqueNumber(cuts[i], hit.a0);
        pushUniqueNumber(cuts[i], hit.a1);
        pushUniqueNumber(cuts[j], hit.b0);
        pushUniqueNumber(cuts[j], hit.b1);
      }
    }
  }

  const noded: Array<[GeometryPoint, GeometryPoint]> = [];
  for (let i = 0; i < segments.length; i += 1) {
    const [a, b] = segments[i];
    const values = cuts[i].slice().sort((x, y) => x - y);
    const uniq: number[] = [];
    for (const t of values) {
      if (uniq.length === 0 || Math.abs(t - uniq[uniq.length - 1]) > 1e-8) uniq.push(t);
    }
    for (let k = 0; k < uniq.length - 1; k += 1) {
      const t0 = uniq[k];
      const t1 = uniq[k + 1];
      if (t1 - t0 <= 1e-8) continue;
      const s0 = lerpPx(a, b, t0);
      const s1 = lerpPx(a, b, t1);
      if (distancePx(s0, s1) <= 1e-7) continue;
      noded.push([s0, s1]);
    }
  }
  return noded;
}

/** Polygonizes segment polylines with dangling-edge pruning to avoid tail artifacts. */
function polygonize(segmentPolylines: GeometryPoint[][]): GeometryPoint[][] {
  const removeDeadEnds = (nodedSegments: Array<[GeometryPoint, GeometryPoint]>): Array<[GeometryPoint, GeometryPoint]> => {
    let segs = nodedSegments.slice();
    let changed = true;
    while (changed) {
      changed = false;
      const degree = new Map<string, number>();
      for (const [a, b] of segs) {
        const ka = pointKey(a);
        const kb = pointKey(b);
        degree.set(ka, (degree.get(ka) ?? 0) + 1);
        degree.set(kb, (degree.get(kb) ?? 0) + 1);
      }
      const next = segs.filter(([a, b]) => (degree.get(pointKey(a)) ?? 0) >= 2 && (degree.get(pointKey(b)) ?? 0) >= 2);
      if (next.length < segs.length) {
        segs = next;
        changed = true;
      }
    }
    return segs;
  };

  const noded = removeDeadEnds(nodeAllSegments(segmentPolylines));
  const nodes = new Map<string, { id: string; x: number; y: number; outs: number[] }>();
  const halfEdges: Array<{ id: number; from: string; to: string; angle: number; rev: number; used: boolean }> = [];

  const ensureNode = (point: GeometryPoint): { id: string; x: number; y: number; outs: number[] } => {
    const id = pointKey(point);
    let node = nodes.get(id);
    if (!node) {
      node = { id, x: point.x, y: point.y, outs: [] };
      nodes.set(id, node);
    }
    return node;
  };

  const directedSeen = new Set<string>();
  for (const [aPoint, bPoint] of noded) {
    const a = ensureNode(aPoint);
    const b = ensureNode(bPoint);
    if (a.id === b.id) continue;
    const d1 = `${a.id}>${b.id}`;
    if (directedSeen.has(d1)) continue;
    directedSeen.add(d1);
    directedSeen.add(`${b.id}>${a.id}`);
    const e1 = halfEdges.length;
    const e2 = halfEdges.length + 1;
    halfEdges.push({ id: e1, from: a.id, to: b.id, angle: Math.atan2(b.y - a.y, b.x - a.x), rev: e2, used: false });
    halfEdges.push({ id: e2, from: b.id, to: a.id, angle: Math.atan2(a.y - b.y, a.x - b.x), rev: e1, used: false });
    a.outs.push(e1);
    b.outs.push(e2);
  }

  for (const node of nodes.values()) {
    node.outs.sort((ia, ib) => halfEdges[ia].angle - halfEdges[ib].angle);
  }

  const rings: GeometryPoint[][] = [];
  const seenCycles = new Set<string>();
  for (const start of halfEdges) {
    if (start.used) continue;
    const cycleNodes = [start.from];
    let current = start;
    let ok = true;
    let steps = 0;
    const maxSteps = Math.max(8, halfEdges.length * 2);

    while (steps++ < maxSteps) {
      if (current.used) { ok = false; break; }
      current.used = true;
      cycleNodes.push(current.to);
      const at = nodes.get(current.to);
      if (!at || at.outs.length === 0) { ok = false; break; }
      const revIdx = at.outs.indexOf(current.rev);
      if (revIdx < 0) { ok = false; break; }
      const nextIdx = (revIdx - 1 + at.outs.length) % at.outs.length;
      current = halfEdges[at.outs[nextIdx]];
      if (current.id === start.id) break;
    }

    if (!ok) continue;
    if (current.id !== start.id) continue;
    if (cycleNodes.length < 4) continue;
    if (cycleNodes[0] !== cycleNodes[cycleNodes.length - 1]) continue;
    const open = cycleNodes.slice(0, -1);
    const cycleKey = canonicalCycleKey(open);
    if (!cycleKey || seenCycles.has(cycleKey)) continue;
    const ring = open.map((id) => {
      const node = nodes.get(id)!;
      return { x: node.x, y: node.y };
    });
    const deduped = dedupeConsecutivePoints(ring, 1e-7);
    if (deduped.length < 3) continue;
    if (polygonArea(deduped) <= 1e-6) continue;
    seenCycles.add(cycleKey);
    rings.push(ensureCCW(deduped));
  }
  return rings;
}

/** Finds stroke/polygon-edge intersections with stroke-order metadata. */
function findStrokePolygonIntersections(
  strokePx: GeometryPoint[],
  polygonPx: GeometryPoint[]
): Array<{ point: GeometryPoint; strokeSeg: number; strokeT: number; polyEdge: number; polyT: number }> {
  const out: Array<{ point: GeometryPoint; strokeSeg: number; strokeT: number; polyEdge: number; polyT: number }> = [];
  const n = polygonPx.length;
  for (let s = 0; s < strokePx.length - 1; s += 1) {
    for (let e = 0; e < n; e += 1) {
      const hit = segmentIntersectionDetailed(strokePx[s], strokePx[s + 1], polygonPx[e], polygonPx[(e + 1) % n]);
      if (!hit) continue;
      if (hit.kind === "point") {
        out.push({ point: hit.point, strokeSeg: s, strokeT: hit.tA, polyEdge: e, polyT: hit.tB });
      }
    }
  }
  out.sort((a, b) => (a.strokeSeg - b.strokeSeg) || (a.strokeT - b.strokeT));
  const deduped: typeof out = [];
  out.forEach((entry) => {
    const prev = deduped[deduped.length - 1];
    if (prev && distancePx(prev.point, entry.point) < 1e-4) return;
    deduped.push(entry);
  });
  return deduped;
}

/** Returns overlap score between stroke and polygon outline (length-first, then count). */
function strokeOverlapScore(loop: GeometryPoint[], stroke: GeometryPoint[]): number {
  let overlapLength = 0;
  const points: GeometryPoint[] = [];
  const outline = loop.concat([loop[0]]);
  for (let i = 0; i < outline.length - 1; i += 1) {
    for (let j = 0; j < stroke.length - 1; j += 1) {
      const hit = segmentIntersectionDetailed(outline[i], outline[i + 1], stroke[j], stroke[j + 1]);
      if (!hit) continue;
      if (hit.kind === "overlap") {
        overlapLength += hit.length;
      } else {
        points.push(hit.point);
      }
    }
  }
  if (overlapLength > 0) return overlapLength;
  const unique: GeometryPoint[] = [];
  for (const point of points) {
    if (!unique.some((u) => distancePx(u, point) <= 1e-3)) unique.push(point);
  }
  return unique.length;
}

function polylineLength(points: GeometryPoint[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) total += distancePx(points[i], points[i + 1]);
  return total;
}

/** Applies freehand split/rejoin edit to one polygon, returning updated polygon pixels or null. */
function editPolygonWithStroke(
  loop: GeometryPoint[],
  stroke: GeometryPoint[],
  simplifyTolerance = config.freehandSimplifyTolerance
): GeometryPoint[] | null {
  const originalArea = polygonArea(loop);
  const minAcceptedArea = originalArea * 0.1;
  const minPartLen = 2.0;
  const outline = loop.concat([loop[0]]);
  const outlineParts = splitPolyline(outline, stroke).filter(
    (segment) => segment.length >= 2 && distancePx(segment[0], segment[segment.length - 1]) > 1e-7 && polylineLength(segment) > minPartLen
  );
  const strokeParts = splitPolyline(stroke, outline).filter(
    (segment) => segment.length >= 2 && distancePx(segment[0], segment[segment.length - 1]) > 1e-7 && polylineLength(segment) > minPartLen
  );
  if (outlineParts.length < 3 || strokeParts.length < 3) return null;

  let best: GeometryPoint[] | null = null;
  let bestArea = 0;
  for (let replaceIdx = 0; replaceIdx < outlineParts.length; replaceIdx += 1) {
    const keptOutline = outlineParts.filter((_, i) => i !== replaceIdx);
    for (const strokePart of strokeParts) {
      const merged = keptOutline.concat([strokePart]);
      const candidates = polygonize(merged);
      for (const candidate of candidates) {
        const area = polygonArea(candidate);
        if (area < minAcceptedArea) continue;
        if (area > bestArea) {
          bestArea = area;
          best = candidate;
        }
      }
    }
  }
  if (!best) return null;
  const simplified = simplifyClosedPolygon(best, simplifyTolerance);
  if (simplified.length < 3) return null;
  return simplified;
}

/** Simplifies an open polyline with Douglas-Peucker in source pixel space. */
function simplifyPolyline(points: GeometryPoint[], epsilon: number): GeometryPoint[] {
  if (points.length <= 2) return points.slice();
  let bestDist = 0;
  let bestIndex = -1;
  const a = points[0];
  const b = points[points.length - 1];
  const ab = subPx(b, a);
  const ab2 = dotPx(ab, ab);
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i];
    const dist = ab2 <= 1e-12
      ? distancePx(a, p)
      : distancePx(p, lerpPx(a, b, Math.max(0, Math.min(1, dotPx(subPx(p, a), ab) / ab2))));
    if (dist > bestDist) {
      bestDist = dist;
      bestIndex = i;
    }
  }
  if (bestDist <= epsilon || bestIndex < 0) return [a, b];
  const left = simplifyPolyline(points.slice(0, bestIndex + 1), epsilon);
  const right = simplifyPolyline(points.slice(bestIndex), epsilon);
  return [...left.slice(0, -1), ...right];
}

/** Simplifies a closed polygon ring and returns open vertices (first not repeated). */
function simplifyClosedPolygon(points: GeometryPoint[], epsilon: number): GeometryPoint[] {
  const ring = dedupeConsecutivePoints(points);
  if (ring.length < 3) return [];
  const closed = [...ring, ring[0]];
  const simplified = simplifyPolyline(closed, epsilon);
  const open = dedupeConsecutivePoints(simplified.slice(0, -1));
  if (open.length < 3) return [];
  return open;
}

/** Triangulates a simple polygon using ear clipping; returns triangle vertex indices. */
function triangulatePolygon(points: Array<{ x: number; y: number }>): number[] {
  if (points.length < 3) return [];
  const areaSigned = points.reduce((acc, point, i) => {
    const next = points[(i + 1) % points.length];
    return acc + point.x * next.y - next.x * point.y;
  }, 0);
  const ccw = areaSigned >= 0;
  const indices = points.map((_, i) => i);
  const triangles: number[] = [];

  const pointInTriangle = (
    p: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
    c: { x: number; y: number }
  ): boolean => {
    const o1 = orient2d(a, b, p);
    const o2 = orient2d(b, c, p);
    const o3 = orient2d(c, a, p);
    if (ccw) return o1 >= -1e-9 && o2 >= -1e-9 && o3 >= -1e-9;
    return o1 <= 1e-9 && o2 <= 1e-9 && o3 <= 1e-9;
  };

  const isEar = (idxPos: number): boolean => {
    const prevIdx = indices[(idxPos - 1 + indices.length) % indices.length];
    const currIdx = indices[idxPos];
    const nextIdx = indices[(idxPos + 1) % indices.length];
    const a = points[prevIdx];
    const b = points[currIdx];
    const c = points[nextIdx];
    const turn = orient2d(a, b, c);
    if (ccw ? turn <= 1e-9 : turn >= -1e-9) return false;
    for (let i = 0; i < indices.length; i += 1) {
      const testIdx = indices[i];
      if (testIdx === prevIdx || testIdx === currIdx || testIdx === nextIdx) continue;
      if (pointInTriangle(points[testIdx], a, b, c)) return false;
    }
    return true;
  };

  let guard = 0;
  while (indices.length > 2 && guard < points.length * points.length) {
    let clipped = false;
    for (let i = 0; i < indices.length; i += 1) {
      if (!isEar(i)) continue;
      const prevIdx = indices[(i - 1 + indices.length) % indices.length];
      const currIdx = indices[i];
      const nextIdx = indices[(i + 1) % indices.length];
      triangles.push(prevIdx, currIdx, nextIdx);
      indices.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
    guard += 1;
  }
  return triangles;
}

/** Adds a freehand polygon mask from normalized points and applies selected label if available. */
function addFreehandMask(points: Array<{ x: number; y: number }>): void {
  if (points.length < 3) return;
  pushUndoSnapshot();
  const nextIndex = appState.masks.reduce((max, mask) => Math.max(max, mask.index), 0) + 1;
  const defaultLabel = getSelectedLabelName();
  const mask: MaskPoint = {
    id: createMaskId(),
    index: nextIndex,
    kind: "freehand",
    x: points[0].x,
    y: points[0].y,
    points: points.map((point) => ({ x: point.x, y: point.y })),
    labelName: defaultLabel,
  };
  appState.masks.push(mask);
  if (appState.currentImageHash) {
    logEvent("mask_created", {
      image_hash: appState.currentImageHash,
      mask_index: mask.index,
      x: mask.x,
      y: mask.y,
    });
    sendSaveAnnotations();
  }
  if (mask.labelName) {
    assignLabelToMask(mask.id, mask.labelName, false);
  }
  updateAnnotationUI();
}

/** Applies a new polygon point-set to an existing freehand mask and persists changes. */
function updateFreehandMask(mask: MaskPoint, points: Array<{ x: number; y: number }>): void {
  if (mask.kind !== "freehand" || points.length < 3) return;
  pushUndoSnapshot();
  mask.points = points.map((point) => ({ x: point.x, y: point.y }));
  mask.x = points[0].x;
  mask.y = points[0].y;
  if (appState.currentImageHash) {
    sendSaveAnnotations();
  }
  updateAnnotationUI();
}

/** Finalizes a sampled freehand stroke into either a new loop or an edited existing loop. */
function finalizeFreehandStroke(samples: FreehandSample[]): {
  outcome: string;
  sampled_points: number;
  self_intersections: number;
  is_near_closure: boolean;
  existing_freehand_masks: number;
  target_intersections?: number;
  target_score?: number;
  edited_mask_id?: string;
} {
  const sampled = dedupeConsecutivePoints(
    samples.map((sample) => ({ x: sample.imageX, y: sample.imageY })),
    1e-6
  );
  const freehandMasks = appState.masks.filter(
    (mask) => mask.kind === "freehand" && Array.isArray(mask.points) && (mask.points?.length ?? 0) >= 3
  );
  const existingFreehandCount = freehandMasks.length;
  if (sampled.length < 2) {
    return {
      outcome: "drop_too_few_points",
      sampled_points: sampled.length,
      self_intersections: 0,
      is_near_closure: false,
      existing_freehand_masks: existingFreehandCount,
    };
  }
  const strokePx = sampled.map((point) => normalizedToImagePx(point));
  const isNearClosure =
    distancePx(strokePx[0], strokePx[strokePx.length - 1]) < config.freehandClosureDistancePx;

  const selfSplit = splitSelfIntersecting(strokePx);
  if (selfSplit.intersections > 0) {
    const segmentComplexity = selfSplit.intersections + 1;
    if (segmentComplexity > config.freehandMaxSelfIntersectionSegments) {
      return {
        outcome: "drop_self_intersecting_no_loop",
        sampled_points: sampled.length,
        self_intersections: selfSplit.intersections,
        is_near_closure: isNearClosure,
        existing_freehand_masks: existingFreehandCount,
      };
    }
    const loops = polygonize(selfSplit.segments);
    if (loops.length === 0) {
      return {
        outcome: "drop_self_intersecting_no_loop",
        sampled_points: sampled.length,
        self_intersections: selfSplit.intersections,
        is_near_closure: isNearClosure,
        existing_freehand_masks: existingFreehandCount,
      };
    }
    let chosen = loops[0];
    let chosenArea = polygonArea(chosen);
    for (let i = 1; i < loops.length; i += 1) {
      const area = polygonArea(loops[i]);
      if (area > chosenArea) {
        chosen = loops[i];
        chosenArea = area;
      }
    }
    const loopPx = simplifyClosedPolygon(chosen, config.freehandSimplifyTolerance);
    if (loopPx.length < 3) {
      return {
        outcome: "drop_self_intersecting_no_loop",
        sampled_points: sampled.length,
        self_intersections: selfSplit.intersections,
        is_near_closure: isNearClosure,
        existing_freehand_masks: existingFreehandCount,
      };
    }
    const points = loopPx.map((point) => imagePxToNormalized(point));
    addFreehandMask(points);
    return {
      outcome: "new_loop_from_self_intersecting",
      sampled_points: sampled.length,
      self_intersections: selfSplit.intersections,
      is_near_closure: isNearClosure,
      existing_freehand_masks: existingFreehandCount,
    };
  }

  if (existingFreehandCount === 0) {
    if (!isNearClosure) {
      return {
        outcome: "drop_simple_not_closed_no_existing",
        sampled_points: sampled.length,
        self_intersections: 0,
        is_near_closure: isNearClosure,
        existing_freehand_masks: existingFreehandCount,
      };
    }
    const closedStroke = [...strokePx, strokePx[0]];
    const loopPx = simplifyClosedPolygon(closedStroke, config.freehandSimplifyTolerance);
    if (loopPx.length < 3) {
      return {
        outcome: "drop_simple_closed_invalid",
        sampled_points: sampled.length,
        self_intersections: 0,
        is_near_closure: isNearClosure,
        existing_freehand_masks: existingFreehandCount,
      };
    }
    const points = loopPx.map((point) => imagePxToNormalized(point));
    addFreehandMask(points);
    return {
      outcome: "new_loop_from_simple_closed",
      sampled_points: sampled.length,
      self_intersections: 0,
      is_near_closure: isNearClosure,
      existing_freehand_masks: existingFreehandCount,
    };
  }

  const ranked = freehandMasks
    .map((mask) => {
      const polygonPx = (mask.points ?? []).map((point) => normalizedToImagePx(point));
      return {
        mask,
        polygonPx,
        score: strokeOverlapScore(polygonPx, strokePx),
        area: polygonArea(polygonPx),
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => (b.score - a.score) || (b.area - a.area) || (a.mask.index - b.mask.index));
  if (ranked.length === 0) {
    return {
      outcome: "drop_no_overlap",
      sampled_points: sampled.length,
      self_intersections: 0,
      is_near_closure: isNearClosure,
      existing_freehand_masks: existingFreehandCount,
    };
  }

  const target = ranked[0];
  const targetIntersections = findStrokePolygonIntersections(strokePx, target.polygonPx);
  const editedPx = editPolygonWithStroke(target.polygonPx, strokePx, config.freehandSimplifyTolerance);
  if (!editedPx || editedPx.length < 3) {
    return {
      outcome: "drop_edit_failed",
      sampled_points: sampled.length,
      self_intersections: 0,
      is_near_closure: isNearClosure,
      existing_freehand_masks: existingFreehandCount,
      target_intersections: targetIntersections.length,
      target_score: target.score,
    };
  }
  const normalized = editedPx.map((point) => imagePxToNormalized(point));
  updateFreehandMask(target.mask, normalized);
  return {
    outcome: "existing_mask_edited",
    sampled_points: sampled.length,
    self_intersections: selfSplit.intersections,
    is_near_closure: isNearClosure,
    existing_freehand_masks: existingFreehandCount,
    edited_mask_id: target.mask.id,
  };
}

/** Removes one mask by id and emits logging. */
function removeMask(maskId: string): void {
  const idx = appState.masks.findIndex((mask) => mask.id === maskId);
  if (idx === -1) return;
  pushUndoSnapshot();
  const [removed] = appState.masks.splice(idx, 1);
  const removedCommentKey = String(maskPersistedNumericID(removed));
  delete appState.annotationComments[removedCommentKey];
  delete appState.annotationAuthors[removedCommentKey];
  delete appState.annotationMaskAuthors[removedCommentKey];
  if (appState.currentImageHash) {
    logEvent("mask_removed", {
      image_hash: appState.currentImageHash,
      mask_index: removed.index,
    });
    sendSaveAnnotations();
  }
  if (appState.maskContextMenu.maskId === maskId) {
    appState.maskContextMenu.open = false;
    appState.maskContextMenu.maskId = null;
  }
  if (appState.selectedMaskId === maskId) {
    appState.selectedMaskId = null;
  }
  updateAnnotationUI();
}

/** Clears all masks for the current image. */
function clearMasks(): void {
  clearUndoHistory();
  appState.masks = [];
  appState.draftBboxMask = null;
  appState.draftFreehandStroke = null;
  appState.selectedMaskId = null;
  appState.maskContextMenu.open = false;
  appState.maskContextMenu.maskId = null;
  updateAnnotationUI();
}

/** Produces markup for a panel in the right sidebar. */
function renderPanel(
  panelName: string,
  _title: string,
  contentHtml: string
): string {
  const shortcutScope =
    panelName === "optics" ? "optics"
    : panelName === "labels" ? "labels"
    : panelName === "annotations" ? "annotations"
    : panelName === "commentPicture" ? "commentImage"
    : panelName === "commentAnnotation" ? "commentAnnotation"
    : null;
  const shortcutScopeAttr = shortcutScope ? ` data-shortcut-scope="${shortcutScope}"` : "";
  return `
    <section class="panel" data-panel="${panelName}">
      <div class="panel__body"${shortcutScopeAttr}>${contentHtml}</div>
    </section>
  `;
}

/** Renders dismissible warning banners for backend image hash mismatch events. */
function renderImageHashWarnings(): string {
  if (appState.imageHashWarnings.length === 0) return "";
  const rows = appState.imageHashWarnings
    .map((warning) => `
      <div class="image-hash-warning" role="alert">
        <div class="image-hash-warning__text">
          Image file changed since hash capture: <span class="image-hash-warning__file">${escapeHtml(warning.file)}</span>
        </div>
        <button
          type="button"
          class="image-hash-warning__dismiss"
          data-action="dismiss-image-hash-warning"
          data-warning-key="${escapeHtml(warning.key)}"
          aria-label="Dismiss image hash warning"
        >Dismiss</button>
      </div>
    `)
    .join("");
  return `<div class="image-hash-warnings">${rows}</div>`;
}

/** Updates only the image-hash warning banner container without remounting the viewer. */
function updateImageHashWarningsUI(): void {
  const alerts = appRoot.querySelector<HTMLElement>(".image-view__alerts");
  if (!alerts) return;
  alerts.innerHTML = renderImageHashWarnings();
}

/** Renders mask mode selector panel body. */
function renderMaskModeBody(): string {
  const selectedMode = appState.maskMode;
  const modeDescription: Record<MaskMode, string> = {
    point: "Click to annotate a location on the picture",
    "bounding box": "Draws a rectangle to indicate both location and size",
    freehand: "Hand drawn mask without holes",
  };
  const messageHtml = appState.maskModeError
    ? `<div class="mask-mode-panel__error" role="status">${appState.maskModeError}</div>`
    : "";
  return `
    <div class="mask-mode-panel">
      <select class="mask-mode-panel__select" data-action="set-mask-mode" aria-label="Mask mode" title="Choose mask drawing mode">
        <option value="point"${selectedMode === "point" ? " selected" : ""}>point</option>
        <option value="bounding box"${selectedMode === "bounding box" ? " selected" : ""}>bounding box</option>
        <option value="freehand"${selectedMode === "freehand" ? " selected" : ""}>freehand</option>
      </select>
      ${messageHtml}
      <div class="mask-mode-panel__hint">${modeDescription[selectedMode]}</div>
    </div>
  `;
}

/** Produces list markup for current masks and assigned labels. */
function renderAnnotationList(): string {
  if (appState.masks.length === 0) {
    return '<div class="muted">No masks yet. Left-click to add, Shift+left-click to remove nearest.</div>';
  }

  const items = appState.masks
    .map(
      (mask) => {
        const selectedClass = appState.selectedMaskId === mask.id ? " is-selected" : "";
        const persistedID = String(maskPersistedNumericID(mask));
        const maskAuthor = appState.annotationMaskAuthors[persistedID];
        const maskAuthorHtml = maskAuthor ? ` <span class="comment-panel__author">by ${escapeHtml(maskAuthor)}</span>` : "";
        return `<li class="annotation-list__item${selectedClass}" data-mask-id="${mask.id}" title="Click to select mask; right-click canvas to relabel">#${mask.index}${maskAuthorHtml} <span class="mask-label-chip">${mask.labelName ? mask.labelName.replace(/</g, "&lt;") : "unlabeled"}</span>` +
        ` <button type="button" class="task-pin__remove" data-action="remove-mask" data-id="${mask.id}" title="Remove mask">✕</button></li>`
      }
    )
    .join("");
  return `<ul class="annotation-list">${items}</ul>`;
}

/** Returns selected annotation-id key for comment mapping, or null when none is selected. */
function getSelectedCommentKey(): string | null {
  const selectedMaskId = appState.selectedMaskId;
  if (!selectedMaskId) return null;
  const selected = appState.masks.find((mask) => mask.id === selectedMaskId);
  return selected ? String(maskPersistedNumericID(selected)) : null;
}

/** Renders read-only author helper text for a comment key, when available. */
function renderCommentAuthorText(key: string): string {
  const author = appState.annotationAuthors[key];
  if (!author) return "";
  return `<div class="comment-panel__author">Last edited by ${escapeHtml(author)}</div>`;
}

/** Renders the always-visible image-level comment panel body. */
function renderPictureCommentBody(): string {
  const value = appState.annotationComments["image"] ?? "";
  return `
    <textarea rows="3" placeholder="Image comment" data-action="image-comment-input" title="Edit image comment">${escapeHtml(value)}</textarea>
    ${renderCommentAuthorText("image")}
  `;
}

/** Renders the selected-annotation comment panel body. */
function renderAnnotationCommentBody(): string {
  const key = getSelectedCommentKey();
  if (!key) {
    return "";
  }
  const value = appState.annotationComments[key] ?? "";
  return `
    <textarea rows="3" placeholder="Annotation comment" data-action="annotation-comment-input" title="Edit selected annotation comment">${escapeHtml(value)}</textarea>
    ${renderCommentAuthorText(key)}
  `;
}

/** Renders the mask label-assignment context menu. */
function renderMaskContextMenu(): string {
  if (!appState.maskContextMenu.open || !appState.maskContextMenu.maskId) return "";
  const labels = getMaskContextMenuLabels();
  if (labels.length === 0) {
    return `
      <div class="mask-context-menu" style="left:${appState.maskContextMenu.clientX}px;top:${appState.maskContextMenu.clientY}px;">
        <div class="mask-context-menu__empty">No labels</div>
      </div>
    `;
  }
  const items = labels
    .map((label) =>
      `<button type="button" class="mask-context-menu__item" data-action="assign-mask-label" data-label="${label.replace(/"/g, "&quot;")}">${label.replace(/</g, "&lt;")}</button>`
    )
    .join("");
  return `
    <div class="mask-context-menu" style="left:${appState.maskContextMenu.clientX}px;top:${appState.maskContextMenu.clientY}px;">
      ${items}
    </div>
  `;
}

/** Updates only the floating mask context-menu DOM without remounting the viewer. */
function updateMaskContextMenuUI(): void {
  appRoot.querySelector(".mask-context-menu")?.remove();
  const menuHtml = renderMaskContextMenu();
  if (!menuHtml) return;
  const dirOverlay = appRoot.querySelector("#dir-browser-overlay");
  if (dirOverlay) {
    dirOverlay.insertAdjacentHTML("beforebegin", menuHtml);
  } else {
    appRoot.insertAdjacentHTML("beforeend", menuHtml);
  }
}

/** Updates only the mask-mode panel body DOM without remounting the viewer. */
function updateMaskModePanelUI(): void {
  const panelBody = appRoot.querySelector<HTMLElement>('[data-panel="maskMode"] .panel__body');
  if (!panelBody) return;
  panelBody.innerHTML = renderMaskModeBody();
}

/** Shows a transient toast for mode changes inside the image canvas wrapper. */
function showModeToast(label: string): void {
  const canvasWrap = appRoot.querySelector<HTMLElement>(".image-view__canvas-wrap");
  if (!canvasWrap) return;
  let toast = canvasWrap.querySelector<HTMLElement>(".mode-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "mode-toast";
    canvasWrap.appendChild(toast);
  }
  toast.textContent = `Mode: ${label}`;
  toast.classList.add("mode-toast--visible");
  if (modeToastTimer !== null) {
    window.clearTimeout(modeToastTimer);
  }
  modeToastTimer = window.setTimeout(() => {
    toast?.classList.remove("mode-toast--visible");
    modeToastTimer = null;
  }, 2000);
}

/** Applies mask mode state change from keyboard/dropdown and updates related UI. */
function setMaskMode(mode: MaskMode): void {
  const previousMode = appState.maskMode;
  appState.maskMode = mode;
  appState.maskModeError = null;
  appState.draftBboxMask = null;
  appState.draftFreehandStroke = null;
  if (mode === "freehand" && appState.selectedMaskId !== null) {
    appState.selectedMaskId = null;
    closeMaskContextMenu();
    updateMaskSelectionUI();
    updateMaskContextMenuUI();
  }
  if (previousMode !== mode) {
    logEvent("mask_mode_changed", { from: previousMode, to: mode });
    persistSettingLater("annotation_mode", mode);
  }
  updateMaskModePanelUI();
  showModeToast(appState.maskMode);
  viewer?.draw();
}

/** Updates only the optics panel body DOM without remounting the viewer. */
function updateOpticsPanelUI(): void {
  const panelBody = appRoot.querySelector<HTMLElement>('[data-panel="optics"] .panel__body');
  if (!panelBody) return;
  panelBody.innerHTML = renderOpticsBody();
}

/** Re-renders annotation panel body and redraws WebGL annotations only. */
function updateAnnotationUI(): void {
  const annotationsPanelBody = appRoot.querySelector<HTMLElement>(
    '[data-panel="annotations"] .panel__body'
  );
  if (annotationsPanelBody) {
    annotationsPanelBody.innerHTML = renderAnnotationList();
  }
  updateCommentPanelsUI();
  viewer?.draw();
}

/** Updates comment panels in-place without remounting the viewer. */
function updateCommentPanelsUI(): void {
  const pictureBody = appRoot.querySelector<HTMLElement>('[data-panel="commentPicture"] .panel__body');
  if (pictureBody) {
    pictureBody.innerHTML = renderPictureCommentBody();
  }

  const annotationPanel = appRoot.querySelector<HTMLElement>('[data-panel="commentAnnotation"]');
  const annotationBody = appRoot.querySelector<HTMLElement>('[data-panel="commentAnnotation"] .panel__body');
  const selectedCommentKey = getSelectedCommentKey();
  if (annotationPanel) {
    annotationPanel.hidden = selectedCommentKey === null;
  }
  if (annotationBody) {
    annotationBody.innerHTML = renderAnnotationCommentBody();
  }
}

/** Refreshes selection-dependent annotation visuals without full app re-render. */
function updateMaskSelectionUI(): void {
  updateAnnotationUI();
  viewer?.draw();
  const selectedMaskId = appState.selectedMaskId;
  if (!selectedMaskId) return;
  const selectedItem = appRoot.querySelector<HTMLElement>(
    `[data-panel="annotations"] .annotation-list__item[data-mask-id="${CSS.escape(selectedMaskId)}"]`
  );
  selectedItem?.scrollIntoView({ block: "nearest" });
}

/** Updates image-reset UI state without remounting the viewer. */
function updateImageStateUI(): void {
  updateLeftSidebarImageNavUI();
  updateAnnotationUI();
  updateMaskSelectionUI();
  const canvas = appRoot.querySelector<HTMLCanvasElement>(".image-view__canvas");
  const waitingForImageReady = appState.currentImageHash === null;
  canvas?.classList.toggle("image-view__canvas--zoom-loading", waitingForImageReady);
  viewer?.draw();
}

/** Updates left-sidebar image label, download state, and 1-based index input. */
function updateLeftSidebarImageNavUI(): void {
  const imageMeta = appRoot.querySelector<HTMLElement>('[data-role="image-label"]');
  if (imageMeta) {
    imageMeta.textContent = getCurrentImageLabel();
  }
  const imageIndexInput = appRoot.querySelector<HTMLInputElement>('input[data-action="jump-image-index"]');
  const hasImages = appState.imageList.length > 0;
  const hasActiveImage = getCurrentImageEntry() !== null;
  const downloadImageBtn = appRoot.querySelector<HTMLButtonElement>('button[data-action="download-image"]');
  if (downloadImageBtn) {
    downloadImageBtn.disabled = !hasActiveImage;
  }
  const downloadAnnotationBtn = appRoot.querySelector<HTMLButtonElement>('button[data-action="download-annotation"]');
  if (downloadAnnotationBtn) {
    downloadAnnotationBtn.disabled = !hasActiveImage;
  }
  if (!imageIndexInput) return;
  const oneBasedIndex = hasImages ? (appState.currentImageIndex + 1) : 0;
  imageIndexInput.value = String(oneBasedIndex);
  imageIndexInput.min = hasImages ? "1" : "0";
  imageIndexInput.max = hasImages ? String(appState.imageList.length) : "0";
  imageIndexInput.disabled = !hasImages;
}

/** Wires annotation list action buttons after panel-body updates. */
function bindAnnotationPanelHandlers(): void {
  if ((bindAnnotationPanelHandlers as { _bound?: boolean })._bound) return;
  (bindAnnotationPanelHandlers as { _bound?: boolean })._bound = true;
  appRoot.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const btn = target?.closest<HTMLButtonElement>('button[data-action="remove-mask"]');
    if (!btn || !appRoot.contains(btn)) return;
    const id = btn.getAttribute("data-id");
    if (id) {
      removeMask(id);
    }
  });
  appRoot.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    if (target.closest('button[data-action="remove-mask"]')) return;
    const row = target.closest<HTMLElement>('.annotation-list__item[data-mask-id]');
    if (!row || !appRoot.contains(row)) return;
    const maskId = row.getAttribute("data-mask-id");
    if (!maskId) return;
    appState.selectedMaskId = maskId;
    const selectedMask = appState.masks.find((mask) => mask.id === maskId) ?? null;
    if (selectedMask?.kind === "bbox" && appState.maskMode !== "bounding box") {
      setMaskMode("bounding box");
    }
    closeMaskContextMenu();
    updateMaskSelectionUI();
  });
  appRoot.addEventListener("input", (event) => {
    const target = event.target as Element | null;
    const imageTextarea = target?.closest<HTMLTextAreaElement>('textarea[data-action="image-comment-input"]');
    if (imageTextarea && appRoot.contains(imageTextarea)) {
      const nextValue = imageTextarea.value;
      if (nextValue === "") {
        delete appState.annotationComments["image"];
      } else {
        appState.annotationComments["image"] = nextValue;
      }
      if (appState.currentImageHash) {
        scheduleCommentSaveAnnotations();
      }
      return;
    }

    const annotationTextarea = target?.closest<HTMLTextAreaElement>('textarea[data-action="annotation-comment-input"]');
    if (!annotationTextarea || !appRoot.contains(annotationTextarea)) return;
    const key = getSelectedCommentKey();
    if (!key) return;
    const nextValue = annotationTextarea.value;
    if (nextValue === "") {
      delete appState.annotationComments[key];
    } else {
      appState.annotationComments[key] = nextValue;
    }
    if (appState.currentImageHash) {
      scheduleCommentSaveAnnotations();
    }
  });
}

/** Binds mask mode dropdown change behavior. */
function bindMaskModePanelHandlers(): void {
  if ((bindMaskModePanelHandlers as { _bound?: boolean })._bound) return;
  (bindMaskModePanelHandlers as { _bound?: boolean })._bound = true;
  appRoot.addEventListener("change", (event) => {
    const target = event.target as Element | null;
    const select = target?.closest<HTMLSelectElement>('select[data-action="set-mask-mode"]');
    if (!select || !appRoot.contains(select)) return;
    const selected = select.value as MaskMode;
    if (selected === "point" || selected === "bounding box" || selected === "freehand") {
      setMaskMode(selected);
    } else {
      setMaskMode("point");
    }
  });
}

/** Binds handlers for the floating mask context menu. */
function bindMaskContextMenuHandlers(): void {
  if ((bindMaskContextMenuHandlers as { _bound?: boolean })._bound) return;
  (bindMaskContextMenuHandlers as { _bound?: boolean })._bound = true;
  appRoot.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const btn = target?.closest<HTMLButtonElement>('button[data-action="assign-mask-label"]');
    if (!btn || !appRoot.contains(btn)) return;
    const labelName = btn.getAttribute("data-label");
    const maskId = appState.maskContextMenu.maskId;
    if (!labelName || !maskId) return;
    assignLabelToMask(maskId, labelName);
    closeMaskContextMenu();
    updateAnnotationUI();
    updateMaskContextMenuUI();
  });
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!appState.maskContextMenu.open) return;
    if (target?.closest(".mask-context-menu")) return;
    closeMaskContextMenu();
    updateMaskContextMenuUI();
  });
}

/** Updates active-label panel body content without full app re-render. */
function updateActiveLabelPanel(): void {
  const panelBody = appRoot.querySelector<HTMLElement>('[data-panel="labels"] .panel__body');
  if (!panelBody) return;
  panelBody.innerHTML = renderLabelTree(appState.activeLabels, appState.activeLabelSelectedId, false);
}

/** Binds read-only label selection in the sidebar labels panel. */
function bindActiveLabelPanelHandlers(): void {
  if ((bindActiveLabelPanelHandlers as { _bound?: boolean })._bound) return;
  (bindActiveLabelPanelHandlers as { _bound?: boolean })._bound = true;
  appRoot.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const row = target?.closest<HTMLElement>('[data-panel="labels"] .label-tree__row');
    if (!row || !appRoot.contains(row)) return;
    const nodeId = row.dataset["nodeId"];
    if (!nodeId) return;
    appState.activeLabelSelectedId = nodeId;
    updateActiveLabelPanel();
  });
}

/** Produces the optics panel body HTML with sliders and transform toggles. */
function renderOpticsBody(): string {
  const {
    gamma,
    multiply,
    add,
    rotate90cw,
    flipH,
    flipV,
    maskStrokeOpacity,
    maskFillOpacity,
    maskStrokeWidth,
    markerSize,
  } = appState.optics;
  return `
    <label class="optics-row">
      <span>gamma</span>
      <input type="range" data-optics="gamma"
        min="1.0" max="2.2" step="0.01" value="${gamma}" title="Adjust gamma correction">
      <span class="optics-val">${gamma.toFixed(2)}</span>
    </label>
    <label class="optics-row">
      <span>multiply</span>
      <input type="range" data-optics="multiply"
        min="0.5" max="2.5" step="0.01" value="${multiply}" title="Adjust brightness multiplier">
      <span class="optics-val">${multiply.toFixed(2)}</span>
    </label>
    <label class="optics-row">
      <span>add</span>
      <input type="range" data-optics="add"
        min="-100" max="100" step="1" value="${add}" title="Adjust additive brightness offset">
      <span class="optics-val">${add.toFixed(0)}</span>
    </label>
    <label class="optics-row">
      <input type="checkbox" data-transform="rotate90cw" ${rotate90cw ? "checked" : ""} title="Toggle 90 degree rotation">
      <span>Rotate 90 CW</span>
      <span class="optics-val"></span>
    </label>
    <label class="optics-row">
      <input type="checkbox" data-transform="flipH" ${flipH ? "checked" : ""} title="Toggle horizontal flip">
      <span>Horizontal flip</span>
      <span class="optics-val"></span>
    </label>
    <label class="optics-row">
      <input type="checkbox" data-transform="flipV" ${flipV ? "checked" : ""} title="Toggle vertical flip">
      <span>Vertical flip</span>
      <span class="optics-val"></span>
    </label>
    <label class="optics-row">
      <span>stroke opacity</span>
      <input type="range" data-mask-render="maskStrokeOpacity"
        min="0" max="1" step="0.05" value="${maskStrokeOpacity}" title="Adjust mask stroke opacity">
      <span class="optics-val">${maskStrokeOpacity.toFixed(2)}</span>
    </label>
    <label class="optics-row">
      <span>fill opacity</span>
      <input type="range" data-mask-render="maskFillOpacity"
        min="0" max="1" step="0.05" value="${maskFillOpacity}" title="Adjust mask fill opacity">
      <span class="optics-val">${maskFillOpacity.toFixed(2)}</span>
    </label>
    <label class="optics-row">
      <span>stroke width</span>
      <input type="range" data-mask-render="maskStrokeWidth"
        min="1" max="5" step="1" value="${maskStrokeWidth}" title="Adjust mask stroke width">
      <span class="optics-val">${maskStrokeWidth.toFixed(0)}</span>
    </label>
    <label class="optics-row">
      <span>marker size</span>
      <input type="range" data-mask-render="markerSize"
        min="5" max="30" step="1" value="${markerSize}" title="Adjust point marker size">
      <span class="optics-val">${markerSize.toFixed(0)}</span>
    </label>
    <div class="optics-reset-row">
      <button type="button" class="ghost" data-action="reset-optics" title="Reset optics">↺</button>
    </div>
  `;
}

/** Wires optics slider input events after panel render. */
function bindOpticsPanelHandlers(): void {
  if ((bindOpticsPanelHandlers as { _bound?: boolean })._bound) return;
  (bindOpticsPanelHandlers as { _bound?: boolean })._bound = true;
  appRoot.addEventListener("input", (event) => {
    const target = event.target as Element | null;
    const opticsSlider = target?.closest<HTMLInputElement>('input[data-optics]');
    if (opticsSlider && appRoot.contains(opticsSlider)) {
      const key = opticsSlider.getAttribute("data-optics") as "gamma" | "multiply" | "add";
      const val = parseFloat(opticsSlider.value);
      appState.optics[key] = val;
      const valSpan = opticsSlider.nextElementSibling as HTMLElement | null;
      if (valSpan) {
        valSpan.textContent = key === "add" ? val.toFixed(0) : val.toFixed(2);
      }
      applyOpticsToViewer();
      const settingsKey = key === "gamma"
        ? "optics_gamma"
        : key === "multiply"
          ? "optics_brightness_mul"
          : "optics_brightness_add";
      persistSettingDebouncedLater(settingsKey, String(val));
      return;
    }
    const maskSlider = target?.closest<HTMLInputElement>('input[data-mask-render]');
    if (!maskSlider || !appRoot.contains(maskSlider)) return;
    const key = maskSlider.getAttribute("data-mask-render") as "maskStrokeOpacity" | "maskFillOpacity" | "maskStrokeWidth" | "markerSize";
    const raw = parseFloat(maskSlider.value);
    const val = key === "maskStrokeWidth" || key === "markerSize" ? Math.round(raw) : raw;
    appState.optics[key] = val;
    const valSpan = maskSlider.nextElementSibling as HTMLElement | null;
    if (valSpan) {
      valSpan.textContent = key === "maskStrokeWidth" || key === "markerSize" ? val.toFixed(0) : val.toFixed(2);
    }
    const settingsKey = key === "maskStrokeOpacity"
      ? "mask_stroke_opacity"
      : key === "maskFillOpacity"
        ? "mask_fill_opacity"
        : key === "maskStrokeWidth"
          ? "mask_stroke_width"
          : "mask_marker_size";
    persistSettingDebouncedLater(settingsKey, String(val));
    applyOpticsToViewer();
  });
  appRoot.addEventListener("change", (event) => {
    const target = event.target as Element | null;
    const checkbox = target?.closest<HTMLInputElement>('input[data-transform]');
    if (!checkbox || !appRoot.contains(checkbox)) return;
    const key = checkbox.getAttribute("data-transform") as "rotate90cw" | "flipH" | "flipV";
    appState.optics[key] = checkbox.checked;
    applyOpticsToViewer();
    const settingsKey = key === "rotate90cw"
      ? "optics_rotate90cw"
      : key === "flipH"
        ? "optics_flip_h"
        : "optics_flip_v";
    persistSettingLater(settingsKey, String(checkbox.checked));
  });
  appRoot.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const btn = target?.closest<HTMLButtonElement>('[data-action="reset-optics"]');
    if (!btn || !appRoot.contains(btn)) return;
    appState.optics = {
      gamma: 1.0,
      multiply: 1.0,
      add: 0.0,
      rotate90cw: false,
      flipH: false,
      flipV: false,
      maskStrokeOpacity: 1.0,
      maskFillOpacity: 0.4,
      maskStrokeWidth: 3,
      markerSize: 10,
    };
    applyOpticsToViewer();
    persistOpticsSettingsLater();
    updateOpticsPanelUI();
  });
}

function applyOpticsToViewer(): void {
  viewer?.setOptics(
    appState.optics.gamma,
    appState.optics.multiply,
    appState.optics.add,
    appState.optics.rotate90cw,
    appState.optics.flipH,
    appState.optics.flipV
  );
}

function cycleOpticsTransform(step: 1 | -1): void {
  const currentIndex = OPTICS_TRANSFORM_SEQUENCE.findIndex(
    (state) =>
      state.rotate90cw === appState.optics.rotate90cw &&
      state.flipH === appState.optics.flipH &&
      state.flipV === appState.optics.flipV
  );
  const base = currentIndex >= 0 ? currentIndex : 0;
  const next = (base + step + OPTICS_TRANSFORM_SEQUENCE.length) % OPTICS_TRANSFORM_SEQUENCE.length;
  const nextState = OPTICS_TRANSFORM_SEQUENCE[next];
  appState.optics.rotate90cw = nextState.rotate90cw;
  appState.optics.flipH = nextState.flipH;
  appState.optics.flipV = nextState.flipV;
  applyOpticsToViewer();
  persistOpticsSettingsLater();
  updateOpticsPanelUI();
}

/** Resolves level dimensions from the full-size manifest dimensions. */
function getLevelDimensions(manifest: TileManifest, level: number): { width: number; height: number } {
  const scale = 2 ** (level - (manifest.levels - 1));
  return {
    width: Math.max(1, Math.round(manifest.width * scale)),
    height: Math.max(1, Math.round(manifest.height * scale)),
  };
}

/** Fetches an image element from URL. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    image.src = url;
  });
}

/** WebGL tile viewer that renders tiles and mask points into one canvas. */
class WebGLTileViewer {
  /** Drawing canvas. */
  private readonly canvas: HTMLCanvasElement;
  /** Current WebGL context. */
  private readonly gl: WebGLRenderingContext;
  /** Access to current mask array. */
  private readonly getMasks: () => MaskPoint[];
  /** Callback for primary/secondary mask interactions from canvas clicks. */
  private readonly onMaskCanvasClick: (payload: MaskCanvasClick) => void;
  /** Returns true when left-button drag should be interpreted as bbox placement. */
  private readonly isBboxDragPlacementEnabled: () => boolean;
  /** Returns true when any mask-placement mode is active (used to suppress pan-drag). */
  private readonly isMaskModeActive: () => boolean;
  /** Callback for bbox placement drag gestures. */
  private readonly onMaskCanvasDrag: (payload: MaskCanvasDrag) => void;
  /** Returns the currently editable bbox mask, or null when side-editing is disabled. */
  private readonly getEditableBboxMask: () => MaskPoint | null;
  /** Callback for bbox-side editing drag gestures. */
  private readonly onMaskCanvasBboxSideDrag: (payload: MaskCanvasBboxSideDrag) => void;
  /** Callback for selecting a mask by double-click hit-testing. */
  private readonly onMaskCanvasDoubleClick: (maskId: string) => void;
  /** Access to current freehand draft stroke preview points. */
  private readonly getDraftFreehandStroke: () => DraftFreehandStroke | null;

  /** Manifest for current image. */
  private manifest: TileManifest | null = null;
  /** Active image stem. */
  private imageStem = "";
  /** Fit transform for current draw pass. */
  private transform: ViewTransform = { x: 0, y: 0, width: 0, height: 0 };
  /** Unrotated source-geometry transform used before shader matrix is applied. */
  private baseTransform: ViewTransform = { x: 0, y: 0, width: 0, height: 0 };
  /** Selected fit-level index. */
  private fitLevel = 0;
  /** Highest backend-ready level seen for the current image, if provided. */
  private maxReadyLevel = -1;
  /** Last level for which tiles are being loaded. */
  private loadingLevel = -1;
  /** Monotonic id for fit-level tile load batches; rejects stale async callbacks. */
  private loadingGeneration = 0;

  /** Current async request generation token. */
  private generation = 0;

  /** Lowest-level texture used as immediate placeholder. */
  private level0Tile: LoadedTile | null = null;
  /** Textures for fit-level tiles keyed by x/y. */
  private fitTiles = new Map<string, LoadedTile>();

  /** Texture shader program. */
  private readonly tileProgram: WebGLProgram;
  /** Tile program position attribute location. */
  private readonly tilePosAttrib: number;
  /** Tile program UV attribute location. */
  private readonly tileUvAttrib: number;
  /** Tile program sampler uniform location. */
  private readonly tileSamplerUniform: WebGLUniformLocation;
  /** Tile program gamma uniform location. */
  private readonly tileGammaUniform: WebGLUniformLocation;
  /** Tile program multiply uniform location. */
  private readonly tileMultiplyUniform: WebGLUniformLocation;
  /** Tile program additive uniform location. */
  private readonly tileAddUniform: WebGLUniformLocation;
  /** Tile program transform matrix uniform location. */
  private readonly tileTransformUniform: WebGLUniformLocation;

  /** Current optics: gamma exponent. */
  private opticsGamma = 1.0;
  /** Current optics: multiplicative brightness. */
  private opticsMultiply = 1.0;
  /** Current optics: additive brightness offset (normalized). */
  private opticsAdd = 0.0;
  /** Current transform: rotate 90 degrees clockwise flag. */
  private opticsRotate90cw = false;
  /** Current transform: horizontal-flip flag. */
  private opticsFlipH = false;
  /** Current transform: vertical-flip flag. */
  private opticsFlipV = false;

  /** Point shader program. */
  private readonly pointProgram: WebGLProgram;
  /** Point program position attribute location. */
  private readonly pointPosAttrib: number;
  /** Point program color uniform location. */
  private readonly pointColorUniform: WebGLUniformLocation;
  /** Point program size uniform location. */
  private readonly pointSizeUniform: WebGLUniformLocation;
  /** Point program ring-cutout uniform location (0 = solid fill, >0 = annulus). */
  private readonly pointRingUniform: WebGLUniformLocation;
  /** Point program transform matrix uniform location. */
  private readonly pointTransformUniform: WebGLUniformLocation;
  /** Solid-rectangle shader program used for bbox fill/outline quads. */
  private readonly rectProgram: WebGLProgram;
  /** Rect program position attribute location. */
  private readonly rectPosAttrib: number;
  /** Rect program color uniform location. */
  private readonly rectColorUniform: WebGLUniformLocation;
  /** Rect program transform matrix uniform location. */
  private readonly rectTransformUniform: WebGLUniformLocation;

  /** Shared buffer for quad positions and point positions. */
  private readonly positionBuffer: WebGLBuffer;
  /** Shared buffer for quad UV coordinates. */
  private readonly uvBuffer: WebGLBuffer;

  /** Canvas resize observer. */
  private resizeObserver: ResizeObserver | null = null;
  /** Fallback window resize listener for environments without ResizeObserver. */
  private windowResizeHandler: (() => void) | null = null;

  /** Current zoom in CSS pixels per source pixel. */
  private zoom = 1;
  /** Current left offset of image in canvas CSS pixels. */
  private offsetX = 0;
  /** Current top offset of image in canvas CSS pixels. */
  private offsetY = 0;
  /** True while primary-pointer drag pan is active. */
  private isDragging = false;
  /** True while a primary-pointer bbox placement drag is active. */
  private isBboxDragPlacing = false;
  /** Active pointer id for bbox placement drag, or null when idle. */
  private bboxDragPointerId: number | null = null;
  /** True while a primary-pointer bbox side-edit drag is active. */
  private isBboxSideEditing = false;
  /** Active pointer id for bbox side-edit drag, or null when idle. */
  private bboxSideEditPointerId: number | null = null;
  /** Active bbox side-edit mask id, or null when idle. */
  private bboxSideEditMaskId: string | null = null;
  /** Active bbox source-edge being edited, or null when idle. */
  private bboxSideEditEdge: BboxEdge | null = null;
  /** Debounce timer for zoom log events (fires 500 ms after last wheel tick). */
  private zoomLogTimer: ReturnType<typeof setTimeout> | null = null;
  /** Previous pointer X used for drag delta integration. */
  private dragLastX = 0;
  /** Previous pointer Y used for drag delta integration. */
  private dragLastY = 0;
  /** Accumulated pointer travel in CSS px since last pointerdown. */
  private dragTotalDistance = 0;
  /** Current full R/H/V transform matrix in NDC (column-major mat3). */
  private transformMatrix = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  /** Suppresses duplicate dblclick handler execution after pointerdown pre-check selection. */
  private suppressNextNativeDoubleClick = false;

  constructor(
    canvas: HTMLCanvasElement,
    getMasks: () => MaskPoint[],
    onMaskCanvasClick: (payload: MaskCanvasClick) => void,
    isBboxDragPlacementEnabled: () => boolean,
    isMaskModeActive: () => boolean,
    onMaskCanvasDrag: (payload: MaskCanvasDrag) => void,
    getEditableBboxMask: () => MaskPoint | null,
    onMaskCanvasBboxSideDrag: (payload: MaskCanvasBboxSideDrag) => void,
    onMaskCanvasDoubleClick: (maskId: string) => void,
    getDraftFreehandStroke: () => DraftFreehandStroke | null
  ) {
    this.canvas = canvas;
    this.getMasks = getMasks;
    this.onMaskCanvasClick = onMaskCanvasClick;
    this.isBboxDragPlacementEnabled = isBboxDragPlacementEnabled;
    this.isMaskModeActive = isMaskModeActive;
    this.onMaskCanvasDrag = onMaskCanvasDrag;
    this.getEditableBboxMask = getEditableBboxMask;
    this.onMaskCanvasBboxSideDrag = onMaskCanvasBboxSideDrag;
    this.onMaskCanvasDoubleClick = onMaskCanvasDoubleClick;
    this.getDraftFreehandStroke = getDraftFreehandStroke;

    const gl = canvas.getContext("webgl", { alpha: false, antialias: true });
    if (!gl) {
      throw new Error("WebGL not supported");
    }
    this.gl = gl;

    this.tileProgram = this.createProgram(
      `
      attribute vec2 a_pos;
      attribute vec2 a_uv;
      varying vec2 v_uv;
      uniform mat3 u_transform;
      void main() {
        v_uv = a_uv;
        vec3 pos = u_transform * vec3(a_pos, 1.0);
        gl_Position = vec4(pos.xy, 0.0, 1.0);
      }
      `,
      `
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D u_tex;
      uniform float u_gamma;
      uniform float u_multiply;
      uniform float u_add;
      void main() {
        vec4 c = texture2D(u_tex, v_uv);
        vec3 rgb = pow(c.rgb, vec3(1.0 / u_gamma));
        rgb = rgb * u_multiply + vec3(u_add);
        gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), c.a);
      }
      `
    );

    this.pointProgram = this.createProgram(
      `
      attribute vec2 a_pos;
      uniform float u_size;
      uniform mat3 u_transform;
      void main() {
        vec3 pos = u_transform * vec3(a_pos, 1.0);
        gl_Position = vec4(pos.xy, 0.0, 1.0);
        gl_PointSize = u_size;
      }
      `,
      `
      precision mediump float;
      uniform vec4 u_color;
      uniform float u_ring;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = dot(c, c);
        if (d > 0.25) {
          discard;
        }
        if (u_ring > 0.0 && d < u_ring) {
          discard;
        }
        gl_FragColor = u_color;
      }
      `
    );

    this.rectProgram = this.createProgram(
      `
      attribute vec2 a_pos;
      uniform mat3 u_transform;
      void main() {
        vec3 pos = u_transform * vec3(a_pos, 1.0);
        gl_Position = vec4(pos.xy, 0.0, 1.0);
      }
      `,
      `
      precision mediump float;
      uniform vec4 u_color;
      void main() {
        gl_FragColor = u_color;
      }
      `
    );

    this.tilePosAttrib = gl.getAttribLocation(this.tileProgram, "a_pos");
    this.tileUvAttrib = gl.getAttribLocation(this.tileProgram, "a_uv");
    const tileSampler = gl.getUniformLocation(this.tileProgram, "u_tex");
    const tileGamma = gl.getUniformLocation(this.tileProgram, "u_gamma");
    const tileMultiply = gl.getUniformLocation(this.tileProgram, "u_multiply");
    const tileAdd = gl.getUniformLocation(this.tileProgram, "u_add");
    const tileTransform = gl.getUniformLocation(this.tileProgram, "u_transform");
    if (!tileSampler || !tileGamma || !tileMultiply || !tileAdd || !tileTransform) {
      throw new Error("Tile uniforms missing");
    }
    this.tileSamplerUniform = tileSampler;
    this.tileGammaUniform = tileGamma;
    this.tileMultiplyUniform = tileMultiply;
    this.tileAddUniform = tileAdd;
    this.tileTransformUniform = tileTransform;

    this.pointPosAttrib = gl.getAttribLocation(this.pointProgram, "a_pos");
    const pointColor = gl.getUniformLocation(this.pointProgram, "u_color");
    const pointSize = gl.getUniformLocation(this.pointProgram, "u_size");
    const pointRing = gl.getUniformLocation(this.pointProgram, "u_ring");
    const pointTransform = gl.getUniformLocation(this.pointProgram, "u_transform");
    if (!pointColor || !pointSize || !pointRing || !pointTransform) {
      throw new Error("Point uniforms missing");
    }
    this.pointColorUniform = pointColor;
    this.pointSizeUniform = pointSize;
    this.pointRingUniform = pointRing;
    this.pointTransformUniform = pointTransform;

    this.rectPosAttrib = gl.getAttribLocation(this.rectProgram, "a_pos");
    const rectColor = gl.getUniformLocation(this.rectProgram, "u_color");
    const rectTransform = gl.getUniformLocation(this.rectProgram, "u_transform");
    if (!rectColor || !rectTransform) {
      throw new Error("Rect uniforms missing");
    }
    this.rectColorUniform = rectColor;
    this.rectTransformUniform = rectTransform;

    const positionBuffer = gl.createBuffer();
    const uvBuffer = gl.createBuffer();
    if (!positionBuffer || !uvBuffer) {
      throw new Error("Unable to create buffers");
    }
    this.positionBuffer = positionBuffer;
    this.uvBuffer = uvBuffer;

    this.setupCanvasListeners();
    this.resize();
  }

  /** Updates optics adjustment values and redraws. */
  setOptics(
    gamma: number,
    multiply: number,
    add: number,
    rotate90cw: boolean,
    flipH: boolean,
    flipV: boolean
  ): void {
    const rotationChanged = this.opticsRotate90cw !== rotate90cw;
    const transformChanged =
      rotationChanged ||
      this.opticsFlipH !== flipH ||
      this.opticsFlipV !== flipV;
    this.opticsGamma = gamma;
    this.opticsMultiply = multiply;
    /** Add value is stored as a normalized offset (divide by 255 so the shader
     *  operates in [0,1] color space regardless of the slider's -100..100 range). */
    this.opticsAdd = add / 255;
    this.opticsRotate90cw = rotate90cw;
    this.opticsFlipH = flipH;
    this.opticsFlipV = flipV;

    if (transformChanged) {
      if (rotationChanged && this.manifest) {
        const displayed = this.getDisplayedImageDimensions();
        const fitScale = this.fitScaleForDimensions(displayed.width, displayed.height);
        this.zoom = fitScale;
        this.offsetX = (this.canvas.clientWidth - fitScale * displayed.width) / 2;
        this.offsetY = (this.canvas.clientHeight - fitScale * displayed.height) / 2;
      } else {
        this.clampPanZoom();
      }
      this.draw();
      const previousLevel = this.fitLevel;
      this.maybeChangeFitLevel();
      if (this.fitLevel === previousLevel) {
        this.loadFitLevelTiles(this.generation);
      }
      return;
    }

    this.draw();
  }

  /** Releases listeners and GPU resources. */
  destroy(): void {
    const gl = this.gl;

    this.generation += 1;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.windowResizeHandler) {
      window.removeEventListener("resize", this.windowResizeHandler);
      this.windowResizeHandler = null;
    }
    this.canvas.removeEventListener("click", this.handleCanvasClick);
    this.canvas.removeEventListener("contextmenu", this.handleCanvasContextMenu);
    this.canvas.removeEventListener("dblclick", this.handleCanvasDoubleClick);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerUp);

    this.clearTextures();
    gl.deleteBuffer(this.positionBuffer);
    gl.deleteBuffer(this.uvBuffer);
    gl.deleteProgram(this.tileProgram);
    gl.deleteProgram(this.pointProgram);
    gl.deleteProgram(this.rectProgram);
  }

  /** Loads a new tiled image by stem name. */
  async setImage(imageStem: string, readyLevel: number | null = null): Promise<void> {
    this.imageStem = imageStem;
    this.manifest = null;
    this.level0Tile = null;
    this.fitTiles.clear();
    this.maxReadyLevel = typeof readyLevel === "number" ? readyLevel : -1;
    this.loadingLevel = -1;
    this.loadingGeneration = 0;
    this.clearTextures();
    this.updateCanvasZoomLevelClass();
    this.draw();

    const requestId = ++this.generation;
    const manifestUrl = `/images/${imageStem}/manifest.json`;

    let manifest: TileManifest;
    try {
      const response = await fetch(manifestUrl);
      if (!response.ok) {
        throw new Error(`Manifest fetch failed (${response.status})`);
      }
      manifest = (await response.json()) as TileManifest;
    } catch (error) {
      console.error("tile viewer: manifest load failed", error);
      return;
    }

    if (requestId !== this.generation) {
      return;
    }

    this.manifest = manifest;
    const displayed = this.getDisplayedImageDimensions();
    const fitScale = this.fitScaleForDimensions(displayed.width, displayed.height);
    this.zoom = fitScale;
    this.offsetX = (this.canvas.clientWidth - fitScale * displayed.width) / 2;
    this.offsetY = (this.canvas.clientHeight - fitScale * displayed.height) / 2;
    this.fitLevel = this.pickFitLevel();
    this.updateCanvasZoomLevelClass();

    await this.loadLevel0(requestId);
    this.loadFitLevelTiles(requestId);
  }

  /**
   * Reloads tiles for the current image without resetting zoom or position.
   * Called when a higher-resolution level becomes available for the already-displayed image.
   */
  refreshTiles(readyLevel: number | null = null): void {
    if (!this.manifest) {
      return;
    }
    if (typeof readyLevel === "number") {
      this.maxReadyLevel = Math.max(this.maxReadyLevel, readyLevel);
    }
    // If a higher-resolution level is now the best fit, force re-evaluation by
    // resetting loadingLevel so loadFitLevelTiles clears cached tiles and re-fetches.
    const best = this.pickFitLevel();
    if (best > this.fitLevel) {
      this.loadingLevel = -1;
    }
    this.loadFitLevelTiles(this.generation);
  }

  /** Redraws all currently available content. */
  draw(): void {
    const gl = this.gl;
    this.resize();
    gl.clearColor(0.10, 0.13, 0.16, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (!this.manifest) {
      return;
    }

    this.computeTransform();
    this.updateTransformMatrix();

    if (this.level0Tile) {
      const dims = getLevelDimensions(this.manifest, 0);
      this.drawTile(this.level0Tile, dims.width, dims.height);
    }

    if (this.fitLevel >= 0 && this.fitTiles.size > 0) {
      const dims = getLevelDimensions(this.manifest, this.fitLevel);
      this.fitTiles.forEach((tile) => {
        this.drawTile(tile, dims.width, dims.height);
      });
    }

    this.drawAnnotations();
  }

  /** Resizes canvas backing store to match CSS size and DPR. */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      if (this.manifest) {
        this.clampPanZoom();
        this.draw();
      }
      return;
    }

    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Loads the coarsest level single tile and uploads it as texture. */
  private async loadLevel0(requestId: number): Promise<void> {
    if (!this.manifest) {
      return;
    }

    const tileUrl = this.tileUrl(0, 0, 0);
    try {
      const image = await loadImage(tileUrl);
      if (requestId !== this.generation) {
        return;
      }
      this.level0Tile = this.uploadTileTexture(0, 0, 0, image);
      this.draw();
    } catch (error) {
      console.error("tile viewer: level0 tile load failed", error);
    }
  }

  /** Picks a fit level and streams all its tiles, redrawing as each arrives. */
  private loadFitLevelTiles(requestId: number): void {
    if (!this.manifest) {
      return;
    }

    const bestLevel = this.pickFitLevel();
    const level = this.maxReadyLevel >= 0 ? Math.min(bestLevel, this.maxReadyLevel) : bestLevel;
    this.fitLevel = level;

    if (this.loadingLevel !== level) {
      this.clearFitTiles();
      this.loadingLevel = level;
    }
    const loadingGen = ++this.loadingGeneration;

    const dims = getLevelDimensions(this.manifest, level);
    const cols = Math.ceil(dims.width / this.manifest.tile_size);
    const rows = Math.ceil(dims.height / this.manifest.tile_size);
    const tileSize = this.manifest.tile_size;

    for (let ty = 0; ty < rows; ty += 1) {
      for (let tx = 0; tx < cols; tx += 1) {
        if (!this.tileIntersectsViewport(tx, ty, tileSize, dims.width, dims.height)) {
          continue;
        }
        const key = `${tx}_${ty}`;
        if (this.fitTiles.has(key)) {
          continue;
        }

        const url = this.tileUrl(level, tx, ty);
        void loadImage(url)
          .then((image) => {
            if (
              requestId !== this.generation ||
              this.fitLevel !== level ||
              this.loadingGeneration !== loadingGen
            ) {
              return;
            }
            const tile = this.uploadTileTexture(tx, ty, level, image);
            this.fitTiles.set(key, tile);
            this.draw();
          })
          .catch((error) => {
            console.error("tile viewer: fit tile load failed", { level, tx, ty, error });
          });
      }
    }
  }

  /** True when a fit-level tile intersects the current canvas viewport. */
  private tileIntersectsViewport(
    tx: number,
    ty: number,
    tileSize: number,
    levelWidth: number,
    levelHeight: number
  ): boolean {
    if (!this.manifest) {
      return false;
    }

    const drawW = this.transform.width;
    const drawH = this.transform.height;
    if (drawW <= 0 || drawH <= 0) {
      return false;
    }

    const vpX0 = (0 - this.offsetX) / drawW;
    const vpY0 = (0 - this.offsetY) / drawH;
    const vpX1 = (this.canvas.clientWidth - this.offsetX) / drawW;
    const vpY1 = (this.canvas.clientHeight - this.offsetY) / drawH;

    const vpCorners = [
      this.applyInverseTransformToNormalizedPoint(vpX0, vpY0),
      this.applyInverseTransformToNormalizedPoint(vpX1, vpY0),
      this.applyInverseTransformToNormalizedPoint(vpX0, vpY1),
      this.applyInverseTransformToNormalizedPoint(vpX1, vpY1),
    ];
    const sourceMinX = Math.min(vpCorners[0].x, vpCorners[1].x, vpCorners[2].x, vpCorners[3].x);
    const sourceMaxX = Math.max(vpCorners[0].x, vpCorners[1].x, vpCorners[2].x, vpCorners[3].x);
    const sourceMinY = Math.min(vpCorners[0].y, vpCorners[1].y, vpCorners[2].y, vpCorners[3].y);
    const sourceMaxY = Math.max(vpCorners[0].y, vpCorners[1].y, vpCorners[2].y, vpCorners[3].y);

    const nx0 = (tx * tileSize) / levelWidth;
    const ny0 = (ty * tileSize) / levelHeight;
    const nx1 = Math.min(nx0 + (tileSize / levelWidth), 1);
    const ny1 = Math.min(ny0 + (tileSize / levelHeight), 1);

    return (
      nx0 < sourceMaxX &&
      nx1 > sourceMinX &&
      ny0 < sourceMaxY &&
      ny1 > sourceMinY
    );
  }

  /** Picks the first level whose resolution exceeds canvas pixels*dpr target. */
  private pickFitLevel(): number {
    if (!this.manifest) {
      return 0;
    }

    const dpr = window.devicePixelRatio || 1;
    const displayed = this.getDisplayedImageDimensions();
    const targetW = this.zoom * displayed.width * dpr;
    const targetH = this.zoom * displayed.height * dpr;

    for (let level = 0; level < this.manifest.levels; level += 1) {
      const dims = getLevelDimensions(this.manifest, level);
      if (dims.width >= targetW || dims.height >= targetH) {
        return level;
      }
    }

    return this.manifest.levels - 1;
  }

  /** Computes the image placement transform based on active content level. */
  private computeTransform(): void {
    if (!this.manifest) {
      return;
    }
    const displayed = this.getDisplayedImageDimensions();
    this.transform = {
      x: this.offsetX,
      y: this.offsetY,
      width: this.zoom * displayed.width,
      height: this.zoom * displayed.height,
    };
    const centerX = this.transform.x + this.transform.width / 2;
    const centerY = this.transform.y + this.transform.height / 2;
    const baseWidth = this.zoom * this.manifest.width;
    const baseHeight = this.zoom * this.manifest.height;
    this.baseTransform = {
      x: centerX - baseWidth / 2,
      y: centerY - baseHeight / 2,
      width: baseWidth,
      height: baseHeight,
    };
  }

  /** Returns fit-to-canvas scale for given source dimensions. */
  private fitScaleForDimensions(width: number, height: number): number {
    return Math.min(this.canvas.clientWidth / width, this.canvas.clientHeight / height);
  }

  /** Constrains zoom and pan offsets so image remains near viewport bounds. */
  private clampPanZoom(): void {
    if (!this.manifest) {
      return;
    }
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const pad = 20;
    const displayed = this.getDisplayedImageDimensions();

    const minZoom = Math.max(
      Math.min(
        (cw - 2 * pad) / displayed.width,
        (ch - 2 * pad) / displayed.height
      ),
      1e-6
    );
    this.zoom = Math.max(minZoom, Math.min(4, this.zoom));

    const imgW = this.zoom * displayed.width;
    const imgH = this.zoom * displayed.height;

    const xA = -pad;
    const xB = cw + pad - imgW;
    const xMin = Math.min(xA, xB);
    const xMax = Math.max(xA, xB);
    this.offsetX = Math.max(xMin, Math.min(xMax, this.offsetX));

    const yA = -pad;
    const yB = ch + pad - imgH;
    const yMin = Math.min(yA, yB);
    const yMax = Math.max(yA, yB);
    this.offsetY = Math.max(yMin, Math.min(yMax, this.offsetY));
  }

  /** Reloads fit-level tiles if zoom-driven target level changed. */
  private maybeChangeFitLevel(): void {
    if (!this.manifest) {
      return;
    }
    const newLevel = this.pickFitLevel();
    if (newLevel !== this.fitLevel) {
      this.fitLevel = newLevel;
      this.loadingLevel = -1;
      this.loadFitLevelTiles(this.generation);
    }
    this.updateCanvasZoomLevelClass();
  }

  /** Updates canvas border-color state class based on whether fit level is maxed. */
  private updateCanvasZoomLevelClass(): void {
    if (!this.manifest) {
      this.canvas.classList.remove("image-view__canvas--zoom-at-max");
      this.canvas.classList.remove("image-view__canvas--zoom-below-max");
      this.canvas.classList.toggle("image-view__canvas--zoom-loading", this.imageStem.length > 0);
      return;
    }
    const atMax = this.fitLevel === this.manifest.levels - 1;
    this.canvas.classList.remove("image-view__canvas--zoom-loading");
    this.canvas.classList.toggle("image-view__canvas--zoom-at-max", atMax);
    this.canvas.classList.toggle("image-view__canvas--zoom-below-max", !atMax);
  }

  /** Draws one tile texture into the current transform space. */
  private drawTile(tile: LoadedTile, levelWidth: number, levelHeight: number): void {
    const gl = this.gl;
    const placement = this.getTilePlacementRect(tile, levelWidth, levelHeight);
    const x0 = placement.x;
    const y0 = placement.y;
    const x1 = placement.x + placement.width;
    const y1 = placement.y + placement.height;

    const ndc = this.rectToNdc(x0, y0, x1, y1);

    gl.useProgram(this.tileProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, ndc, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.tilePosAttrib);
    gl.vertexAttribPointer(this.tilePosAttrib, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STREAM_DRAW
    );
    gl.enableVertexAttribArray(this.tileUvAttrib);
    gl.vertexAttribPointer(this.tileUvAttrib, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tile.texture);
    gl.uniform1i(this.tileSamplerUniform, 0);
    gl.uniform1f(this.tileGammaUniform, this.opticsGamma);
    gl.uniform1f(this.tileMultiplyUniform, this.opticsMultiply);
    gl.uniform1f(this.tileAddUniform, this.opticsAdd);
    gl.uniformMatrix3fv(this.tileTransformUniform, false, this.transformMatrix);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Returns CSS-pixel placement for one tile in the current view transform. */
  private getTilePlacementRect(
    tile: Pick<LoadedTile, "tx" | "ty" | "width" | "height">,
    levelWidth: number,
    levelHeight: number
  ): TilePlacementRect {
    const tileSize = this.manifest?.tile_size ?? 256;
    const nx0 = (tile.tx * tileSize) / levelWidth;
    const ny0 = (tile.ty * tileSize) / levelHeight;
    const x = this.baseTransform.x + nx0 * this.baseTransform.width;
    const y = this.baseTransform.y + ny0 * this.baseTransform.height;
    const width = (tile.width / levelWidth) * this.baseTransform.width;
    const height = (tile.height / levelHeight) * this.baseTransform.height;
    return { x, y, width, height };
  }

/** Draws normalized masks (point + bbox + freehand) over image content. */
  private drawAnnotations(): void {
    if (ctrlHeld) {
      return;
    }
    const masks = this.getMasks().slice().sort((a, b) => a.index - b.index);
    const draftFreehand = this.getDraftFreehandStroke();
    if (masks.length === 0 && (!draftFreehand || draftFreehand.points.length < 2)) {
      return;
    }

    const gl = this.gl;
    const selectedMaskId = appState.selectedMaskId;
    const hasSelectedMask = selectedMaskId !== null && masks.some((mask) => mask.id === selectedMaskId);
    const labelDepthFirstIndex = buildLabelDepthFirstIndexMap(appState.activeLabels);
    const point = new Float32Array(2);
    const strokeWidth = Math.min(5, Math.max(1, appState.optics.maskStrokeWidth));
    const markerSize = Math.max(5, appState.optics.markerSize);
    const fillSize = markerSize;
    const outlineSize = markerSize + strokeWidth * 2;
    const strokeOpacity = Math.max(0, Math.min(1, appState.optics.maskStrokeOpacity));
    const fillOpacity = Math.max(0, Math.min(1, appState.optics.maskFillOpacity));
    const ringInnerRadius = Math.max(0, 0.5 - strokeWidth / outlineSize);
    const ringThreshold = ringInnerRadius * ringInnerRadius;
    const rectStrokeX = this.baseTransform.width > 0 ? strokeWidth / this.baseTransform.width : 0;
    const rectStrokeY = this.baseTransform.height > 0 ? strokeWidth / this.baseTransform.height : 0;
    const sourceToNdc = (xNorm: number, yNorm: number): [number, number] => {
      const x = this.baseTransform.x + xNorm * this.baseTransform.width;
      const y = this.baseTransform.y + yNorm * this.baseTransform.height;
      return [
        (x / this.canvas.clientWidth) * 2 - 1,
        1 - (y / this.canvas.clientHeight) * 2,
      ];
    };

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const setupPointProgram = (): void => {
      gl.useProgram(this.pointProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl.enableVertexAttribArray(this.pointPosAttrib);
      gl.vertexAttribPointer(this.pointPosAttrib, 2, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix3fv(this.pointTransformUniform, false, this.transformMatrix);
    };
    const setupRectProgram = (): void => {
      gl.useProgram(this.rectProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl.enableVertexAttribArray(this.rectPosAttrib);
      gl.vertexAttribPointer(this.rectPosAttrib, 2, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix3fv(this.rectTransformUniform, false, this.transformMatrix);
    };
    const drawRectNormalized = (
      x0Norm: number,
      y0Norm: number,
      x1Norm: number,
      y1Norm: number,
      color: [number, number, number],
      alpha: number
    ): void => {
      if (alpha <= 0 || x1Norm <= x0Norm || y1Norm <= y0Norm) return;
      const x0 = this.baseTransform.x + x0Norm * this.baseTransform.width;
      const y0 = this.baseTransform.y + y0Norm * this.baseTransform.height;
      const x1 = this.baseTransform.x + x1Norm * this.baseTransform.width;
      const y1 = this.baseTransform.y + y1Norm * this.baseTransform.height;
      gl.bufferData(gl.ARRAY_BUFFER, this.rectToNdc(x0, y0, x1, y1), gl.STREAM_DRAW);
      gl.uniform4f(this.rectColorUniform, color[0], color[1], color[2], alpha);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    let pointProgramActive = false;
    let rectProgramActive = false;
    const ensureRectProgram = (): void => {
      if (rectProgramActive) return;
      setupRectProgram();
      rectProgramActive = true;
      pointProgramActive = false;
    };
    const drawPolylineNormalized = (
      points: Array<{ x: number; y: number }>,
      color: [number, number, number],
      alpha: number,
      closed: boolean
    ): void => {
      if (alpha <= 0 || points.length < 2) return;
      ensureRectProgram();
      const coords: number[] = [];
      points.forEach((point) => {
        const [nx, ny] = sourceToNdc(point.x, point.y);
        coords.push(nx, ny);
      });
      if (closed) {
        const [nx, ny] = sourceToNdc(points[0].x, points[0].y);
        coords.push(nx, ny);
      }
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(coords), gl.STREAM_DRAW);
      gl.uniform4f(this.rectColorUniform, color[0], color[1], color[2], alpha);
      gl.lineWidth(strokeWidth);
      gl.drawArrays(gl.LINE_STRIP, 0, coords.length / 2);
    };
    const drawFilledPolygonNormalized = (
      points: Array<{ x: number; y: number }>,
      color: [number, number, number],
      alpha: number
    ): void => {
      if (alpha <= 0 || points.length < 3) return;
      const triangles = triangulatePolygon(points);
      if (triangles.length < 3) return;
      ensureRectProgram();
      const coords: number[] = [];
      triangles.forEach((idx) => {
        const [nx, ny] = sourceToNdc(points[idx].x, points[idx].y);
        coords.push(nx, ny);
      });
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(coords), gl.STREAM_DRAW);
      gl.uniform4f(this.rectColorUniform, color[0], color[1], color[2], alpha);
      gl.drawArrays(gl.TRIANGLES, 0, coords.length / 2);
    };

    const haloStrokeWidth = strokeWidth * 2.5;
    const haloRectStrokeX = this.baseTransform.width > 0 ? haloStrokeWidth / this.baseTransform.width : 0;
    const haloRectStrokeY = this.baseTransform.height > 0 ? haloStrokeWidth / this.baseTransform.height : 0;
    const haloOutlineSize = markerSize + haloStrokeWidth * 2;
    const haloRingInnerRadius = Math.max(0, 0.5 - haloStrokeWidth / haloOutlineSize);
    const haloRingThreshold = haloRingInnerRadius * haloRingInnerRadius;

    masks.forEach((mask) => {
      const fillHex = maskFillColor(mask.index);
      const labelIndex = mask.labelName ? (labelDepthFirstIndex.get(mask.labelName) ?? null) : null;
      const outlineHex = labelIndex === null ? "#888888" : labelColor(labelIndex);
      const [outlineR, outlineG, outlineB] = cssHexToRgb01(outlineHex);
      const shouldFill = !hasSelectedMask || mask.id === selectedMaskId;
      const isSelected = mask.id === selectedMaskId;
      if (mask.kind === "point") {
        if (!pointProgramActive) {
          setupPointProgram();
          pointProgramActive = true;
          rectProgramActive = false;
        }
        const x = this.baseTransform.x + mask.x * this.baseTransform.width;
        const y = this.baseTransform.y + mask.y * this.baseTransform.height;
        point[0] = (x / this.canvas.clientWidth) * 2 - 1;
        point[1] = 1 - (y / this.canvas.clientHeight) * 2;
        gl.bufferData(gl.ARRAY_BUFFER, point, gl.STREAM_DRAW);

        if (isSelected) {
          gl.uniform4f(this.pointColorUniform, 1, 1, 1, strokeOpacity);
          gl.uniform1f(this.pointSizeUniform, haloOutlineSize);
          gl.uniform1f(this.pointRingUniform, haloRingThreshold);
          gl.drawArrays(gl.POINTS, 0, 1);
        }
        gl.uniform4f(this.pointColorUniform, outlineR, outlineG, outlineB, strokeOpacity);
        gl.uniform1f(this.pointSizeUniform, outlineSize);
        gl.uniform1f(this.pointRingUniform, ringThreshold);
        gl.drawArrays(gl.POINTS, 0, 1);

        if (shouldFill) {
          const [fillR, fillG, fillB] = cssHexToRgb01(fillHex);
          gl.uniform4f(this.pointColorUniform, fillR, fillG, fillB, fillOpacity);
          gl.uniform1f(this.pointSizeUniform, fillSize);
          gl.uniform1f(this.pointRingUniform, 0.0);
          gl.drawArrays(gl.POINTS, 0, 1);
        }
        return;
      }
      if (mask.kind === "bbox") {
        if (!rectProgramActive) {
          setupRectProgram();
          rectProgramActive = true;
          pointProgramActive = false;
        }
        const bw = Math.max(0, mask.w ?? 0);
        const bh = Math.max(0, mask.h ?? 0);
        const x0 = mask.x;
        const y0 = mask.y;
        const x1 = mask.x + bw;
        const y1 = mask.y + bh;
        const outlineColor: [number, number, number] = [outlineR, outlineG, outlineB];

        if (isSelected) {
          const hInsetX = Math.min(haloRectStrokeX, bw / 2);
          const hInsetY = Math.min(haloRectStrokeY, bh / 2);
          drawRectNormalized(x0, y0, x1, Math.min(y1, y0 + hInsetY), [1, 1, 1], strokeOpacity);
          drawRectNormalized(x0, Math.max(y0, y1 - hInsetY), x1, y1, [1, 1, 1], strokeOpacity);
          drawRectNormalized(x0, Math.min(y1, y0 + hInsetY), Math.min(x1, x0 + hInsetX), Math.max(y0, y1 - hInsetY), [1, 1, 1], strokeOpacity);
          drawRectNormalized(Math.max(x0, x1 - hInsetX), Math.min(y1, y0 + hInsetY), x1, Math.max(y0, y1 - hInsetY), [1, 1, 1], strokeOpacity);
        }

        const insetX = Math.min(rectStrokeX, bw / 2);
        const insetY = Math.min(rectStrokeY, bh / 2);
        const topY1 = Math.min(y1, y0 + insetY);
        const bottomY0 = Math.max(y0, y1 - insetY);
        const leftX1 = Math.min(x1, x0 + insetX);
        const rightX0 = Math.max(x0, x1 - insetX);
        drawRectNormalized(x0, y0, x1, topY1, outlineColor, strokeOpacity);
        drawRectNormalized(x0, bottomY0, x1, y1, outlineColor, strokeOpacity);
        drawRectNormalized(x0, topY1, leftX1, bottomY0, outlineColor, strokeOpacity);
        drawRectNormalized(rightX0, topY1, x1, bottomY0, outlineColor, strokeOpacity);

        if (shouldFill) {
          const [fillR, fillG, fillB] = cssHexToRgb01(fillHex);
          drawRectNormalized(
            x0 + insetX,
            y0 + insetY,
            x1 - insetX,
            y1 - insetY,
            [fillR, fillG, fillB],
            fillOpacity
          );
        }
        return;
      }
      if (mask.kind !== "freehand" || !Array.isArray(mask.points) || mask.points.length < 3) return;
      const outlineColor: [number, number, number] = [outlineR, outlineG, outlineB];
      if (shouldFill) {
        const [fillR, fillG, fillB] = cssHexToRgb01(fillHex);
        drawFilledPolygonNormalized(mask.points, [fillR, fillG, fillB], fillOpacity);
      }
      if (isSelected) {
        gl.lineWidth(haloStrokeWidth);
        drawPolylineNormalized(mask.points, [1, 1, 1], strokeOpacity, true);
        gl.lineWidth(strokeWidth);
      }
      drawPolylineNormalized(mask.points, outlineColor, strokeOpacity, true);
    });

    if (draftFreehand && draftFreehand.points.length >= 2) {
      const previewPoints = draftFreehand.points.map((point) => ({ x: point.imageX, y: point.imageY }));
      drawPolylineNormalized(previewPoints, [1, 0, 0], 1.0, false);
    }

    gl.disable(gl.BLEND);
  }

  /** Uploads one image tile as a WebGL texture. */
  private uploadTileTexture(tx: number, ty: number, level: number, image: HTMLImageElement): LoadedTile {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) {
      throw new Error("Failed to create texture");
    }

    console.log(
      `tile upload hash=${this.imageStem.slice(0, 16)} level=${level} tile=${tx},${ty} size=${image.naturalWidth}x${image.naturalHeight}`
    );

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

    return {
      texture,
      tx,
      ty,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  }

  /** Builds tile URL from manifest template values. */
  private tileUrl(level: number, tx: number, ty: number): string {
    if (!this.manifest) {
      throw new Error("Manifest not loaded");
    }
    const relative = this.manifest.tiles
      .replace("{z}", String(level))
      .replace("{x}", String(tx))
      .replace("{y}", String(ty));
    return `/images/${this.imageStem}/${relative}`;
  }

  /** Creates shader program from source strings. */
  private createProgram(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl = this.gl;
    const vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);

    const program = gl.createProgram();
    if (!program) {
      throw new Error("Unable to create program");
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(program) ?? "unknown link error";
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      throw new Error(`Program link failed: ${error}`);
    }

    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return program;
  }

  /** Compiles one shader stage. */
  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error("Unable to create shader");
    }

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader) ?? "unknown compile error";
      gl.deleteShader(shader);
      throw new Error(`Shader compile failed: ${error}`);
    }

    return shader;
  }

  /** Converts a CSS-space rectangle to clip-space triangle-strip vertices. */
  private rectToNdc(x0: number, y0: number, x1: number, y1: number): Float32Array {
    const left = (x0 / this.canvas.clientWidth) * 2 - 1;
    const right = (x1 / this.canvas.clientWidth) * 2 - 1;
    const top = 1 - (y0 / this.canvas.clientHeight) * 2;
    const bottom = 1 - (y1 / this.canvas.clientHeight) * 2;

    return new Float32Array([left, bottom, right, bottom, left, top, right, top]);
  }

  /** Finds the closest mask to a canvas-space point within a CSS-pixel radius. */
  private findClosestMaskId(px: number, py: number, radiusPx: number): string | null {
    const maxDistSq = radiusPx * radiusPx;
    let best: { id: string; distSq: number } | null = null;
    this.getMasks().forEach((mask) => {
      let distSq = Number.POSITIVE_INFINITY;
      if (mask.kind === "bbox") {
        const bw = Math.max(0, mask.w ?? 0);
        const bh = Math.max(0, mask.h ?? 0);
        const corners = [
          this.applyForwardTransformToNormalizedPoint(mask.x, mask.y),
          this.applyForwardTransformToNormalizedPoint(mask.x + bw, mask.y),
          this.applyForwardTransformToNormalizedPoint(mask.x, mask.y + bh),
          this.applyForwardTransformToNormalizedPoint(mask.x + bw, mask.y + bh),
        ];
        const xs = corners.map((c) => this.transform.x + c.x * this.transform.width);
        const ys = corners.map((c) => this.transform.y + c.y * this.transform.height);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const dx = Math.max(minX - px, 0, px - maxX);
        const dy = Math.max(minY - py, 0, py - maxY);
        distSq = dx * dx + dy * dy;
      } else if (mask.kind === "point") {
        const display = this.applyForwardTransformToNormalizedPoint(mask.x, mask.y);
        const mx = this.transform.x + display.x * this.transform.width;
        const my = this.transform.y + display.y * this.transform.height;
        const dx = mx - px;
        const dy = my - py;
        distSq = dx * dx + dy * dy;
      } else if (mask.kind === "freehand" && Array.isArray(mask.points) && mask.points.length >= 2) {
        const polygonCanvas = mask.points.map((vertex) => {
          const display = this.applyForwardTransformToNormalizedPoint(vertex.x, vertex.y);
          return {
            x: this.transform.x + display.x * this.transform.width,
            y: this.transform.y + display.y * this.transform.height,
          };
        });
        if (polygonCanvas.length >= 3 && this.isPointInsidePolygon(px, py, polygonCanvas)) {
          distSq = 0;
        } else {
          let bestSegmentDistSq = Number.POSITIVE_INFINITY;
          for (let i = 0; i < polygonCanvas.length; i += 1) {
            const a = polygonCanvas[i];
            const b = polygonCanvas[(i + 1) % polygonCanvas.length];
            const segDist = this.distancePointToSegment(px, py, a.x, a.y, b.x, b.y);
            bestSegmentDistSq = Math.min(bestSegmentDistSq, segDist * segDist);
          }
          distSq = bestSegmentDistSq;
        }
      }
      if (distSq > maxDistSq) return;
      if (!best || distSq < best.distSq) {
        best = { id: mask.id, distSq };
      }
    });
    return best?.id ?? null;
  }

  /** Returns shortest Euclidean distance from point to finite line segment in CSS pixels. */
  private distancePointToSegment(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number
  ): number {
    const vx = bx - ax;
    const vy = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const vv = vx * vx + vy * vy;
    if (vv <= 1e-12) {
      const dx = px - ax;
      const dy = py - ay;
      return Math.sqrt(dx * dx + dy * dy);
    }
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / vv));
    const cx = ax + t * vx;
    const cy = ay + t * vy;
    const dx = px - cx;
    const dy = py - cy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Returns true when a canvas-space point lies inside a polygon ring. */
  private isPointInsidePolygon(px: number, py: number, polygon: Array<{ x: number; y: number }>): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;
      const intersects = ((yi > py) !== (yj > py)) &&
        (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  /** Finds nearest editable bbox source-edge by display-space side hit-testing. */
  private findNearestEditableBboxEdge(mask: MaskPoint, px: number, py: number, radiusPx: number): BboxEdge | null {
    if (mask.kind !== "bbox") return null;
    const bw = Math.max(0, mask.w ?? 0);
    const bh = Math.max(0, mask.h ?? 0);
    if (bw <= 0 || bh <= 0) return null;

    const c00 = this.applyForwardTransformToNormalizedPoint(mask.x, mask.y);
    const c10 = this.applyForwardTransformToNormalizedPoint(mask.x + bw, mask.y);
    const c01 = this.applyForwardTransformToNormalizedPoint(mask.x, mask.y + bh);
    const c11 = this.applyForwardTransformToNormalizedPoint(mask.x + bw, mask.y + bh);
    const toCanvas = (p: { x: number; y: number }): { x: number; y: number } => ({
      x: this.transform.x + p.x * this.transform.width,
      y: this.transform.y + p.y * this.transform.height,
    });
    const p00 = toCanvas(c00);
    const p10 = toCanvas(c10);
    const p01 = toCanvas(c01);
    const p11 = toCanvas(c11);
    const candidates: Array<{ edge: BboxEdge; dist: number }> = [
      { edge: "x0", dist: this.distancePointToSegment(px, py, p00.x, p00.y, p01.x, p01.y) },
      { edge: "x1", dist: this.distancePointToSegment(px, py, p10.x, p10.y, p11.x, p11.y) },
      { edge: "y0", dist: this.distancePointToSegment(px, py, p00.x, p00.y, p10.x, p10.y) },
      { edge: "y1", dist: this.distancePointToSegment(px, py, p01.x, p01.y, p11.x, p11.y) },
    ];
    candidates.sort((a, b) => a.dist - b.dist);
    const nearest = candidates[0];
    if (!nearest) return null;
    if (nearest.dist > radiusPx) {
      logEvent("bbox_edge_hit_test", {
        result: "miss",
        mask_id: mask.id,
        nearest_edge: nearest.edge,
        nearest_dist_px: Number(nearest.dist.toFixed(2)),
        threshold_px: radiusPx,
      });
      return null;
    }
    logEvent("bbox_edge_hit_test", {
      result: "hit",
      mask_id: mask.id,
      nearest_edge: nearest.edge,
      nearest_dist_px: Number(nearest.dist.toFixed(2)),
      threshold_px: radiusPx,
    });
    return nearest.edge;
  }

  /** Maps client coordinates into canvas/image coordinates, optionally clamping to image bounds. */
  private mapClientToMaskEvent(
    clientX: number,
    clientY: number,
    options: { clampToImage: boolean; includeHitMask: boolean }
  ): Omit<MaskCanvasClick, "button" | "shiftKey"> | null {
    const bounds = this.canvas.getBoundingClientRect();
    let px = clientX - bounds.left;
    let py = clientY - bounds.top;

    const minX = this.transform.x;
    const maxX = this.transform.x + this.transform.width;
    const minY = this.transform.y;
    const maxY = this.transform.y + this.transform.height;

    const inImage = px >= minX && px <= maxX && py >= minY && py <= maxY;
    if (!inImage && !options.clampToImage) {
      return null;
    }
    if (!inImage && options.clampToImage) {
      px = Math.max(minX, Math.min(maxX, px));
      py = Math.max(minY, Math.min(maxY, py));
    }

    const displayX = (px - this.transform.x) / this.transform.width;
    const displayY = (py - this.transform.y) / this.transform.height;
    const source = this.applyInverseTransformToNormalizedPoint(displayX, displayY);
    return {
      canvasX: px,
      canvasY: py,
      imageX: source.x,
      imageY: source.y,
      hitMaskId: options.includeHitMask ? this.findClosestMaskId(px, py, 10) : null,
      clientX,
      clientY,
    };
  }

  /** Handles primary-button click by mapping into normalized image coordinates. */
  private readonly handleCanvasClick = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    if (this.dragTotalDistance > config.clickMaxDragPx) return;
    const mapped = this.mapClientToMaskEvent(event.clientX, event.clientY, {
      clampToImage: false,
      includeHitMask: true,
    });
    if (!mapped) return;
    this.onMaskCanvasClick({
      button: "left",
      canvasX: mapped.canvasX,
      canvasY: mapped.canvasY,
      imageX: mapped.imageX,
      imageY: mapped.imageY,
      shiftKey: event.shiftKey,
      hitMaskId: mapped.hitMaskId,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };

  /** Handles right-click by mapping into normalized image coordinates and nearest mask hit. */
  private readonly handleCanvasContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    if (this.dragTotalDistance > config.clickMaxDragPx) return;
    const mapped = this.mapClientToMaskEvent(event.clientX, event.clientY, {
      clampToImage: false,
      includeHitMask: true,
    });
    if (!mapped) return;
    this.onMaskCanvasClick({
      button: "right",
      canvasX: mapped.canvasX,
      canvasY: mapped.canvasY,
      imageX: mapped.imageX,
      imageY: mapped.imageY,
      shiftKey: event.shiftKey,
      hitMaskId: mapped.hitMaskId,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };

  /** Handles double-click hit-testing for mask selection. */
  private readonly handleCanvasDoubleClick = (event: MouseEvent): void => {
    if (this.suppressNextNativeDoubleClick) {
      this.suppressNextNativeDoubleClick = false;
      return;
    }
    if (event.button !== 0) return;
    if (this.dragTotalDistance > config.clickMaxDragPx) return;
    const mapped = this.mapClientToMaskEvent(event.clientX, event.clientY, {
      clampToImage: false,
      includeHitMask: true,
    });
    if (!mapped) return;
    const hitMaskId = mapped.hitMaskId;
    if (hitMaskId) {
      this.onMaskCanvasDoubleClick(hitMaskId);
    }
  };

  /** Returns the effective displayed image dimensions after rotation toggle. */
  private getDisplayedImageDimensions(): { width: number; height: number } {
    if (!this.manifest) {
      return { width: 1, height: 1 };
    }
    if (!this.opticsRotate90cw) {
      return { width: this.manifest.width, height: this.manifest.height };
    }
    return { width: this.manifest.height, height: this.manifest.width };
  }

  /** Returns source image dimensions from current manifest, if loaded. */
  getSourceImageDimensions(): { width: number; height: number } | null {
    if (!this.manifest) return null;
    return { width: this.manifest.width, height: this.manifest.height };
  }

  /** Applies inverse active transform to map display-normalized point to source-normalized point. */
  private applyInverseTransformToNormalizedPoint(x: number, y: number): { x: number; y: number } {
    let tx = x;
    let ty = y;
    if (this.opticsFlipV) {
      ty = 1 - ty;
    }
    if (this.opticsFlipH) {
      tx = 1 - tx;
    }
    if (this.opticsRotate90cw) {
      const nextX = ty;
      const nextY = 1 - tx;
      tx = nextX;
      ty = nextY;
    }
    return { x: tx, y: ty };
  }

  /** Applies active transform to map source-normalized point to display-normalized point. */
  private applyForwardTransformToNormalizedPoint(x: number, y: number): { x: number; y: number } {
    let tx = x;
    let ty = y;
    if (this.opticsRotate90cw) {
      const nextX = 1 - ty;
      const nextY = tx;
      tx = nextX;
      ty = nextY;
    }
    if (this.opticsFlipH) {
      tx = 1 - tx;
    }
    if (this.opticsFlipV) {
      ty = 1 - ty;
    }
    return { x: tx, y: ty };
  }

  /** Recomputes the full image transform matrix in NDC for current optics + pan/zoom. */
  private updateTransformMatrix(): void {
    const idx = (this.opticsRotate90cw ? 4 : 0) | (this.opticsFlipH ? 2 : 0) | (this.opticsFlipV ? 1 : 0);
    const pure = PURE_TRANSFORM_MATRICES[idx];
    const cw = Math.max(1, this.canvas.clientWidth);
    const ch = Math.max(1, this.canvas.clientHeight);
    // Compensate NDC anisotropy so 90-degree rotations are correct in pixel space.
    const m00 = pure[0];
    const m01 = pure[1] * (cw / ch);
    const m10 = pure[3] * (ch / cw);
    const m11 = pure[4];
    const cx = ((this.transform.x + this.transform.width / 2) / this.canvas.clientWidth) * 2 - 1;
    const cy = 1 - ((this.transform.y + this.transform.height / 2) / this.canvas.clientHeight) * 2;
    const tx = cx - (m00 * cx + m10 * cy);
    const ty = cy - (m01 * cx + m11 * cy);
    this.transformMatrix = new Float32Array([m00, m01, 0, m10, m11, 0, tx, ty, 1]);
  }

  /** Handles wheel-based pan/zoom gestures centered at cursor. */
  private readonly handleWheel = (event: WheelEvent): void => {
    if (!this.manifest) {
      return;
    }
    event.preventDefault();
    const bounds = this.canvas.getBoundingClientRect();
    const mx = event.clientX - bounds.left;
    const my = event.clientY - bounds.top;

    if (event.ctrlKey) {
      const factor = event.deltaY < 0 ? 1.1 : 0.9;
      const previousZoom = this.zoom;
      const nextZoom = Math.max(1e-6, Math.min(2, previousZoom * factor));
      const appliedFactor = nextZoom / previousZoom;
      this.offsetX = mx - (mx - this.offsetX) * appliedFactor;
      this.offsetY = my - (my - this.offsetY) * appliedFactor;
      this.zoom = nextZoom;
    } else if (event.shiftKey) {
      this.offsetX -= event.deltaY;
    } else {
      this.offsetY -= event.deltaY;
    }

    this.clampPanZoom();
    this.draw();
    const previousLevel = this.fitLevel;
    this.maybeChangeFitLevel();
    if (this.fitLevel === previousLevel) {
      this.loadFitLevelTiles(this.generation);
    }

    // Debounced zoom log — fires once 500 ms after the last wheel tick.
    if (this.zoomLogTimer !== null) {
      clearTimeout(this.zoomLogTimer);
    }
    this.zoomLogTimer = setTimeout(() => {
      this.zoomLogTimer = null;
      logEvent("zoom", { hash: this.imageStem, zoom: this.zoom, fit_level: this.fitLevel });
    }, 500);
  };

  /** Starts drag-pan tracking on primary-pointer down. */
  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    this.canvas.focus();
    this.dragTotalDistance = 0;

    if (this.isBboxDragPlacementEnabled()) {
      const mapped = this.mapClientToMaskEvent(event.clientX, event.clientY, {
        clampToImage: false,
        includeHitMask: true,
      });
      if (mapped) {
        // Run dblclick mask selection before entering drag capture so freehand
        // mode never starts a stroke on a mask-double-click interaction.
        if (event.detail >= 2 && mapped.hitMaskId) {
          this.suppressNextNativeDoubleClick = true;
          this.onMaskCanvasDoubleClick(mapped.hitMaskId);
          return;
        }
        this.suppressNextNativeDoubleClick = false;
        this.isBboxDragPlacing = true;
        this.bboxDragPointerId = event.pointerId;
        this.dragLastX = event.clientX;
        this.dragLastY = event.clientY;
        this.dragTotalDistance = 0;
        this.canvas.setPointerCapture(event.pointerId);
        this.onMaskCanvasDrag({
          phase: "start",
          canvasX: mapped.canvasX,
          canvasY: mapped.canvasY,
          imageX: mapped.imageX,
          imageY: mapped.imageY,
          dragDistance: 0,
        });
        return;
      }
    }

    const editableBbox = this.getEditableBboxMask();
    if (editableBbox) {
      const mapped = this.mapClientToMaskEvent(event.clientX, event.clientY, {
        clampToImage: false,
        includeHitMask: false,
      });
      if (mapped) {
        const edge = this.findNearestEditableBboxEdge(
          editableBbox,
          mapped.canvasX,
          mapped.canvasY,
          Number.POSITIVE_INFINITY
        );
        if (edge) {
          logEvent("bbox_edit_pointerdown", {
            result: "start",
            mask_id: editableBbox.id,
            edge,
            canvas_x: mapped.canvasX,
            canvas_y: mapped.canvasY,
            image_x: mapped.imageX,
            image_y: mapped.imageY,
          });
          this.isBboxSideEditing = true;
          this.bboxSideEditPointerId = event.pointerId;
          this.bboxSideEditMaskId = editableBbox.id;
          this.bboxSideEditEdge = edge;
          this.dragLastX = event.clientX;
          this.dragLastY = event.clientY;
          this.dragTotalDistance = 0;
          this.canvas.setPointerCapture(event.pointerId);
          this.onMaskCanvasBboxSideDrag({
            phase: "start",
            maskId: editableBbox.id,
            edge,
            imageX: mapped.imageX,
            imageY: mapped.imageY,
          });
          return;
        }
        logEvent("bbox_edit_pointerdown", {
          result: "blocked",
          reason: "edge_not_hit",
          mask_id: editableBbox.id,
          canvas_x: mapped.canvasX,
          canvas_y: mapped.canvasY,
          image_x: mapped.imageX,
          image_y: mapped.imageY,
        });
      } else {
        logEvent("bbox_edit_pointerdown", {
          result: "blocked",
          reason: "pointer_outside_image",
          mask_id: editableBbox.id,
        });
      }
    }

    if (this.isMaskModeActive()) {
      return;
    }

    this.isDragging = true;
    this.dragLastX = event.clientX;
    this.dragLastY = event.clientY;
    this.dragTotalDistance = 0;
    this.canvas.setPointerCapture(event.pointerId);
  };

  /** Integrates pointer movement into pan offset while dragging. */
  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.isBboxSideEditing) {
      if (this.bboxSideEditPointerId !== null && event.pointerId !== this.bboxSideEditPointerId) {
        return;
      }
      if (this.dragLastX !== event.clientX || this.dragLastY !== event.clientY) {
        const dx = event.clientX - this.dragLastX;
        const dy = event.clientY - this.dragLastY;
        this.dragTotalDistance += Math.sqrt(dx * dx + dy * dy);
        this.dragLastX = event.clientX;
        this.dragLastY = event.clientY;
      }
      const mapped = this.mapClientToMaskEvent(event.clientX, event.clientY, {
        clampToImage: true,
        includeHitMask: false,
      });
      if (!mapped || !this.bboxSideEditMaskId || !this.bboxSideEditEdge) return;
      this.onMaskCanvasBboxSideDrag({
        phase: "move",
        maskId: this.bboxSideEditMaskId,
        edge: this.bboxSideEditEdge,
        imageX: mapped.imageX,
        imageY: mapped.imageY,
      });
      return;
    }

    if (this.isBboxDragPlacing) {
      if (this.bboxDragPointerId !== null && event.pointerId !== this.bboxDragPointerId) {
        return;
      }
      if (this.dragLastX !== event.clientX || this.dragLastY !== event.clientY) {
        const dx = event.clientX - this.dragLastX;
        const dy = event.clientY - this.dragLastY;
        this.dragTotalDistance += Math.sqrt(dx * dx + dy * dy);
        this.dragLastX = event.clientX;
        this.dragLastY = event.clientY;
      }
      const mapped = this.mapClientToMaskEvent(event.clientX, event.clientY, {
        clampToImage: true,
        includeHitMask: false,
      });
      if (!mapped) return;
      this.onMaskCanvasDrag({
        phase: "move",
        canvasX: mapped.canvasX,
        canvasY: mapped.canvasY,
        imageX: mapped.imageX,
        imageY: mapped.imageY,
        dragDistance: this.dragTotalDistance,
      });
      return;
    }

    if (!this.isDragging || !this.manifest) {
      return;
    }
    if (this.dragLastX === event.clientX && this.dragLastY === event.clientY) {
      return;
    }
    const dx = event.clientX - this.dragLastX;
    const dy = event.clientY - this.dragLastY;
    this.dragTotalDistance += Math.sqrt(dx * dx + dy * dy);
    this.offsetX += dx;
    this.offsetY += dy;
    this.dragLastX = event.clientX;
    this.dragLastY = event.clientY;
    this.clampPanZoom();
    this.draw();
    const previousLevel = this.fitLevel;
    this.maybeChangeFitLevel();
    if (this.fitLevel === previousLevel) {
      this.loadFitLevelTiles(this.generation);
    }
  };

  /** Ends drag-pan and refreshes level selection if needed. */
  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.isBboxSideEditing) {
      if (this.bboxSideEditPointerId !== null && event.pointerId !== this.bboxSideEditPointerId) {
        return;
      }
      const mapped = this.mapClientToMaskEvent(event.clientX, event.clientY, {
        clampToImage: true,
        includeHitMask: false,
      });
      if (mapped && this.bboxSideEditMaskId && this.bboxSideEditEdge) {
        this.onMaskCanvasBboxSideDrag({
          phase: "end",
          maskId: this.bboxSideEditMaskId,
          edge: this.bboxSideEditEdge,
          imageX: mapped.imageX,
          imageY: mapped.imageY,
        });
      }
      this.isBboxSideEditing = false;
      this.bboxSideEditPointerId = null;
      this.bboxSideEditMaskId = null;
      this.bboxSideEditEdge = null;
      this.dragTotalDistance = 0;
      return;
    }

    if (this.isBboxDragPlacing) {
      if (this.bboxDragPointerId !== null && event.pointerId !== this.bboxDragPointerId) {
        return;
      }
      const mapped = this.mapClientToMaskEvent(event.clientX, event.clientY, {
        clampToImage: true,
        includeHitMask: false,
      });
      if (mapped) {
        this.onMaskCanvasDrag({
          phase: "end",
          canvasX: mapped.canvasX,
          canvasY: mapped.canvasY,
          imageX: mapped.imageX,
          imageY: mapped.imageY,
          dragDistance: this.dragTotalDistance,
        });
      }
      this.isBboxDragPlacing = false;
      this.bboxDragPointerId = null;
      this.dragTotalDistance = 0;
      return;
    }

    if (!this.isDragging) {
      return;
    }
    this.isDragging = false;
    this.dragTotalDistance = 0;
    this.maybeChangeFitLevel();
    logEvent("pan", { hash: this.imageStem, offset_x: this.offsetX, offset_y: this.offsetY, zoom: this.zoom });
  };

  /** Sets up listeners for click and resize-driven level refit. */
  private setupCanvasListeners(): void {
    this.canvas.addEventListener("click", this.handleCanvasClick);
    this.canvas.addEventListener("contextmenu", this.handleCanvasContextMenu);
    this.canvas.addEventListener("dblclick", this.handleCanvasDoubleClick);
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerUp);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        this.resize();
        this.clampPanZoom();
        this.draw();
        this.maybeChangeFitLevel();
      });
      this.resizeObserver.observe(this.canvas);
    } else {
      this.windowResizeHandler = () => {
        this.resize();
        this.clampPanZoom();
        this.draw();
        this.maybeChangeFitLevel();
      };
      window.addEventListener("resize", this.windowResizeHandler);
    }
  }

  /** Deletes all loaded textures. */
  private clearTextures(): void {
    if (this.level0Tile) {
      this.gl.deleteTexture(this.level0Tile.texture);
      this.level0Tile = null;
    }
    this.clearFitTiles();
  }

  /** Deletes all fit-level tile textures. */
  private clearFitTiles(): void {
    this.fitTiles.forEach((tile) => {
      this.gl.deleteTexture(tile.texture);
    });
    this.fitTiles.clear();
  }
}

/** Binds WebGL viewer to the current image canvas and state callbacks. */
function mountViewer(): void {
  const canvas = appRoot.querySelector<HTMLCanvasElement>(".image-view__canvas");
  if (!canvas) {
    return;
  }

  viewer?.destroy();
  let bboxDragStart: { imageX: number; imageY: number } | null = null;
  let freehandSamples: FreehandSample[] = [];
  viewer = new WebGLTileViewer(
    canvas,
    () => (appState.draftBboxMask ? [...appState.masks, appState.draftBboxMask] : appState.masks),
    (payload) => {
      if (!appState.currentImageHash) return;
      logEvent("mouse_click", {
        button: payload.button,
        canvas_x: payload.canvasX,
        canvas_y: payload.canvasY,
        image_x: payload.imageX,
        image_y: payload.imageY,
      });
      if (payload.button === "left") {
        const hadMenuOpen = appState.maskContextMenu.open;
        closeMaskContextMenu();
        if (hadMenuOpen) {
          updateMaskContextMenuUI();
        }
        if (payload.shiftKey) {
          if (payload.hitMaskId) {
            removeMask(payload.hitMaskId);
          }
          return;
        }
        if (appState.selectedMaskId !== null) {
          return;
        }
        if (appState.maskMode === "bounding box" || appState.maskMode === "freehand") {
          return;
        }
        if (payload.hitMaskId) {
          return;
        }
        addMask(payload.imageX, payload.imageY);
        return;
      }
      if (payload.hitMaskId) {
        appState.maskContextMenu.open = true;
        appState.maskContextMenu.clientX = payload.clientX;
        appState.maskContextMenu.clientY = payload.clientY;
        appState.maskContextMenu.maskId = payload.hitMaskId;
      } else {
        closeMaskContextMenu();
      }
      updateMaskContextMenuUI();
    },
    () =>
      (appState.maskMode === "bounding box" || appState.maskMode === "freehand") &&
      appState.selectedMaskId === null,
    () => appState.maskMode === "point" || appState.maskMode === "bounding box" || appState.maskMode === "freehand",
    (payload) => {
      if (payload.phase === "start") {
        const hadMenuOpen = appState.maskContextMenu.open;
        closeMaskContextMenu();
        if (hadMenuOpen) {
          updateMaskContextMenuUI();
        }
        bboxDragStart = { imageX: payload.imageX, imageY: payload.imageY };
        appState.draftBboxMask = null;
        freehandSamples = [{
          canvasX: payload.canvasX,
          canvasY: payload.canvasY,
          imageX: payload.imageX,
          imageY: payload.imageY,
        }];
        if (appState.maskMode === "freehand") {
          logEvent("freehand_drag", {
            phase: "start",
            canvas_x: payload.canvasX,
            canvas_y: payload.canvasY,
            image_x: payload.imageX,
            image_y: payload.imageY,
          });
        }
        appState.draftFreehandStroke = appState.maskMode === "freehand" ? { points: freehandSamples.slice() } : null;
        return;
      }
      if (!bboxDragStart || appState.selectedMaskId !== null) {
        if (appState.maskMode === "freehand" && freehandSamples.length > 0) {
          logEvent("freehand_drag", {
            phase: "cancel",
            reason: !bboxDragStart ? "missing_drag_start" : "selected_mask",
            sampled_points: freehandSamples.length,
          });
        }
        appState.draftBboxMask = null;
        appState.draftFreehandStroke = null;
        freehandSamples = [];
        bboxDragStart = null;
        return;
      }
      if (appState.maskMode === "freehand") {
        const latest = { canvasX: payload.canvasX, canvasY: payload.canvasY, imageX: payload.imageX, imageY: payload.imageY };
        const prev = freehandSamples[freehandSamples.length - 1];
        const distFromPrev = !prev
          ? Number.POSITIVE_INFINITY
          : Math.hypot(latest.canvasX - prev.canvasX, latest.canvasY - prev.canvasY);
        if (!prev || distFromPrev >= config.freehandMinSamplePx || payload.phase === "end") {
          freehandSamples.push(latest);
        }
        appState.draftFreehandStroke = { points: freehandSamples.slice() };
        viewer?.draw();
        if (payload.phase === "end") {
          logEvent("freehand_drag", {
            phase: "end",
            canvas_x: payload.canvasX,
            canvas_y: payload.canvasY,
            image_x: payload.imageX,
            image_y: payload.imageY,
            drag_distance: payload.dragDistance,
            sampled_points: freehandSamples.length,
          });
          appState.draftFreehandStroke = null;
          if (freehandSamples.length >= 2) {
            const result = finalizeFreehandStroke(freehandSamples);
            logEvent("freehand_finalize", result);
          } else {
            logEvent("freehand_finalize", {
              outcome: "drop_too_few_points",
              sampled_points: freehandSamples.length,
              self_intersections: 0,
              is_near_closure: false,
            });
          }
          freehandSamples = [];
          bboxDragStart = null;
          viewer?.draw();
        }
        return;
      }
      if (appState.maskMode !== "bounding box") {
        appState.draftBboxMask = null;
        appState.draftFreehandStroke = null;
        return;
      }
      if (payload.dragDistance < config.clickMaxDragPx) {
        appState.draftBboxMask = null;
        if (payload.phase === "end") {
          bboxDragStart = null;
          viewer?.draw();
        }
        return;
      }

      const preview = normalizeBboxFromCorners(
        bboxDragStart.imageX,
        bboxDragStart.imageY,
        payload.imageX,
        payload.imageY
      );
      const previewMask: MaskPoint = {
        id: "__draft-bbox__",
        index: appState.masks.reduce((max, mask) => Math.max(max, mask.index), 0) + 1,
        kind: "bbox",
        x: preview.x,
        y: preview.y,
        w: preview.w,
        h: preview.h,
        labelName: null,
      };
      appState.draftBboxMask = previewMask;
      viewer?.draw();

      if (payload.phase === "end") {
        appState.draftBboxMask = null;
        addBboxMask(bboxDragStart.imageX, bboxDragStart.imageY, payload.imageX, payload.imageY);
        bboxDragStart = null;
      }
    },
    () => {
      if (appState.maskMode !== "bounding box") return null;
      if (!appState.selectedMaskId) {
        logEvent("bbox_edit_selection_gate", {
          result: "blocked",
          reason: "no_selected_mask",
          mask_mode: appState.maskMode,
        });
        return null;
      }
      const selected = appState.masks.find((mask) => mask.id === appState.selectedMaskId) ?? null;
      if (!selected) {
        logEvent("bbox_edit_selection_gate", {
          result: "blocked",
          reason: "selected_mask_not_found",
          selected_mask_id: appState.selectedMaskId,
          mask_mode: appState.maskMode,
        });
        return null;
      }
      if (selected.kind !== "bbox") {
        logEvent("bbox_edit_selection_gate", {
          result: "blocked",
          reason: "selected_mask_not_bbox",
          selected_mask_id: selected.id,
          selected_kind: selected.kind,
          mask_mode: appState.maskMode,
        });
        return null;
      }
      logEvent("bbox_edit_selection_gate", {
        result: "eligible",
        selected_mask_id: selected.id,
        selected_kind: selected.kind,
        mask_mode: appState.maskMode,
      });
      return selected;
    },
    (payload) => {
      const mask = appState.masks.find((m) => m.id === payload.maskId);
      if (!mask || mask.kind !== "bbox") return;
      if (payload.phase === "start") {
        pushUndoSnapshot();
      }
      logEvent("bbox_edit", {
        phase: payload.phase,
        mask_id: payload.maskId,
        edge: payload.edge,
        image_x: payload.imageX,
        image_y: payload.imageY,
        mask_mode: appState.maskMode,
      });
      applyDraggedBboxEdge(mask, payload.edge, payload.imageX, payload.imageY);
      if (payload.phase === "end") {
        if (appState.currentImageHash) {
          sendSaveAnnotations();
        }
        updateAnnotationUI();
        return;
      }
      viewer?.draw();
    },
    (maskId) => {
      appState.selectedMaskId = maskId;
      const selectedMask = appState.masks.find((mask) => mask.id === maskId) ?? null;
      if (selectedMask?.kind === "bbox" && appState.maskMode !== "bounding box") {
        setMaskMode("bounding box");
      }
      closeMaskContextMenu();
      updateMaskSelectionUI();
      updateMaskContextMenuUI();
    },
    () => appState.draftFreehandStroke
  );

  applyOpticsToViewer();
  const waitingForImageReady = appState.imageList.length > 0 && appState.currentImageHash === null;
  canvas.classList.toggle("image-view__canvas--zoom-loading", waitingForImageReady);
  if (appState.currentImageHash) {
    void viewer.setImage(appState.currentImageHash);
  }

}

// ── Menu bar ─────────────────────────────────────────────────────────────────

/** Toggles the top menu bar open/closed without a full re-render. */
function toggleMenu(): void {
  appState.menuOpen = !appState.menuOpen;
  const nav = appRoot.querySelector<HTMLElement>(".menu-bar");
  const btn = appRoot.querySelector<HTMLButtonElement>(".hamburger");
  if (nav) nav.classList.toggle("menu-bar--open", appState.menuOpen);
  if (btn) btn.setAttribute("aria-expanded", String(appState.menuOpen));
}

/** Returns the first label id from a nested tree in pre-order, or null if empty. */
function firstLabelId(nodes: LabelNode[]): string | null {
  if (nodes.length === 0) return null;
  const first = nodes[0];
  return first.id || firstLabelId(first.children);
}

/** Normalizes a backend status string into a known UI status value. */
function normalizeTaskStatus(status: string): Task["status"] {
  return TASK_STATUSES.some((s) => s.key === status) ? (status as Task["status"]) : "new";
}

/** Normalizes backend label nodes into UI label nodes. */
function normalizeLabelNodes(nodes: BackendLabelNode[] | undefined): LabelNode[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((node) => ({
    id: String(node.id ?? ""),
    text: String(node.text ?? ""),
    children: normalizeLabelNodes(node.children),
  }));
}

/** Maps backend /api/tasks results into UI task state, sorted by ord. */
function mapBackendTasksToUi(tasks: BackendTask[]): Task[] {
  return [...tasks]
    .sort((a, b) => (a.ord - b.ord) || a.id.localeCompare(b.id))
    .map((task, index) => {
      const labels = normalizeLabelNodes(task.labels);
      return {
        id: String(task.id ?? ""),
        description: String(task.description ?? ""),
        status: normalizeTaskStatus(String(task.status ?? "")),
        tags: Array.isArray(task.tags) ? task.tags.map((t) => String(t)) : [],
        images: String(task.images ?? ""),
        annotations: String(task.annotations ?? ""),
        checkmark: Boolean(task.checkmark),
        comment: String(task.comment ?? ""),
        labels,
        selectedLabelId: firstLabelId(labels),
        collapsed: index !== 0,
      };
    });
}

/** Returns current task order index for backend ord persistence. */
function taskOrd(taskId: string): number {
  const idx = appState.tasks.findIndex((t) => t.id === taskId);
  return idx >= 0 ? idx : 0;
}

/** Starts a save operation and updates dialog status UI. */
function beginTaskSave(): void {
  appState.tasksSavingCount += 1;
  appState.tasksError = null;
  if (appState.tasksDialogOpen) render();
}

/** Reports a task-related UI/API error to browser console and backend event log. */
function reportTaskError(
  context: string,
  error: unknown,
  extra: Record<string, unknown> = {}
): void {
  console.error(context, error);
  const message = error instanceof Error ? error.message : String(error);
  logEvent("task_error", { context, message, ...extra });
}

/** Runs a task save operation with shared saving/error status handling. */
async function runTaskSave(
  work: () => Promise<void>,
  errorMessage: string,
  logContext: string
): Promise<boolean> {
  beginTaskSave();
  try {
    await work();
    appState.tasksError = null;
    return true;
  } catch (error) {
    reportTaskError(logContext, error);
    appState.tasksError = errorMessage;
    return false;
  } finally {
    appState.tasksSavingCount = Math.max(0, appState.tasksSavingCount - 1);
    if (appState.tasksDialogOpen) render();
  }
}

/** Persists scalar task fields to backend. */
async function persistTaskScalars(task: Task): Promise<void> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: task.id,
      ord: taskOrd(task.id),
      description: task.description,
      status: task.status,
      images: task.images,
      annotations: task.annotations,
      checkmark: task.checkmark,
      comment: task.comment,
    }),
  });
  if (!response.ok) {
    throw new Error(`save task failed (${response.status})`);
  }
}

/** Persists full tag list for a task to backend. */
async function persistTaskTags(task: Task): Promise<void> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/tags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags: task.tags }),
  });
  if (!response.ok) {
    throw new Error(`save tags failed (${response.status})`);
  }
}

/** Persists full label tree for a task to backend. */
async function persistTaskLabels(task: Task): Promise<void> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/labels`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(task.labels),
  });
  if (!response.ok) {
    throw new Error(`save labels failed (${response.status})`);
  }
}

/** Deletes one task on backend. */
async function persistTaskDelete(taskId: string): Promise<void> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(`delete task failed (${response.status})`);
  }
}

/** Loads current user role and tasks from backend and updates dialog state. */
async function loadTasksDialogState(loadToken: number): Promise<void> {
  try {
    const [meResponse, tasksResponse] = await Promise.all([
      fetch("/api/me"),
      fetch("/api/tasks"),
    ]);
    if (!meResponse.ok) {
      throw new Error(`me fetch failed (${meResponse.status})`);
    }
    if (!tasksResponse.ok) {
      throw new Error(`tasks fetch failed (${tasksResponse.status})`);
    }
    const meRaw = (await meResponse.json()) as unknown;
    const raw = (await tasksResponse.json()) as unknown;
    if (typeof meRaw !== "object" || meRaw === null || !("is_admin" in meRaw)) {
      throw new Error("me fetch failed (invalid response)");
    }
    if (!Array.isArray(raw)) {
      throw new Error("tasks fetch failed (response is not an array)");
    }
    const me = meRaw as BackendMe;
    const backendTasks = raw as BackendTask[];
    if (loadToken !== appState.tasksLoadToken) return;
    appState.tasksError = null;
    appState.isAdmin = Boolean(me.is_admin);
    appState.tasks = mapBackendTasksToUi(backendTasks);
    if (appState.tasksDialogOpen) render();
  } catch (error) {
    reportTaskError("tasks dialog: load failed", error, { endpoint: "/api/me,/api/tasks" });
    if (loadToken !== appState.tasksLoadToken) return;
    appState.tasksError = "Failed to load tasks from backend.";
    if (appState.tasksDialogOpen) render();
  } finally {
    if (loadToken !== appState.tasksLoadToken) return;
    appState.tasksLoading = false;
    if (appState.tasksDialogOpen) render();
  }
}

/** Opens the Tasks dialog and loads role/tasks from backend. */
function openTasksDialog(): void {
  appState.isAdmin = false;
  appState.tasksDialogOpen = true;
  appState.tasksLoading = true;
  appState.tasksError = null;
  appState.tasksLoadToken += 1;
  const loadToken = appState.tasksLoadToken;
  render();
  void loadTasksDialogState(loadToken);
}

/** Closes the Tasks dialog. */
function closeTasksDialog(): void {
  appState.tasksDialogOpen = false;
  appState.tasksError = null;
  render();
}

/** Fetches immediate subdirectories for the given filesystem path from backend. */
async function fetchDirs(path: string): Promise<string[]> {
  const response = await fetch(`/api/dirs?${new URLSearchParams({ path }).toString()}`, {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`dir list failed (${response.status})`);
  }
  const payload = (await response.json()) as { dirs?: string[] };
  return Array.isArray(payload.dirs) ? payload.dirs : [];
}

/** Renders directory entries and breadcrumbs in the open directory browser modal. */
async function renderDirBrowser(): Promise<void> {
  const breadcrumb = document.getElementById("dir-browser-breadcrumb");
  const list = document.getElementById("dir-browser-list");
  const selected = document.getElementById("dir-browser-selected");
  if (!breadcrumb || !list || !selected) {
    return;
  }

  breadcrumb.textContent = dirBrowserPath;
  selected.textContent = dirBrowserPath;
  list.innerHTML = "";

  if (dirBrowserPath !== "/") {
    const up = document.createElement("div");
    up.className = "dir-browser-entry dir-browser-entry--up";
    up.textContent = "..";
    up.addEventListener("click", () => {
      const parts = dirBrowserPath.split("/").filter(Boolean);
      parts.pop();
      dirBrowserPath = parts.length > 0 ? `/${parts.join("/")}` : "/";
      void renderDirBrowser();
    });
    list.appendChild(up);
  }

  try {
    const dirs = await fetchDirs(dirBrowserPath);
    if (dirs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "dir-browser-entry";
      empty.textContent = "(empty)";
      list.appendChild(empty);
      return;
    }
    for (const name of dirs) {
      const nextPath = dirBrowserPath === "/" ? `/${name}` : `${dirBrowserPath}/${name}`;
      const entry = document.createElement("div");
      entry.className = "dir-browser-entry";
      entry.textContent = name;
      entry.addEventListener("click", () => {
        dirBrowserPath = nextPath;
        void renderDirBrowser();
      });
      list.appendChild(entry);
    }
  } catch (error) {
    reportTaskError("tasks: dir browser load failed", error, { path: dirBrowserPath });
    const errLine = document.createElement("div");
    errLine.className = "dir-browser-entry";
    errLine.textContent = `error: ${error instanceof Error ? error.message : String(error)}`;
    list.appendChild(errLine);
  }
}

/** Opens the directory browser modal. */
function openDirBrowser(initialPath: string, callback: (path: string) => void): void {
  dirBrowserCallback = callback;
  dirBrowserPath = initialPath.trim() || "/";
  const overlay = document.getElementById("dir-browser-overlay");
  overlay?.removeAttribute("aria-hidden");
  overlay?.classList.add("dir-browser-overlay--open");
  void renderDirBrowser();
}

/** Closes the directory browser modal. */
function closeDirBrowser(): void {
  const overlay = document.getElementById("dir-browser-overlay");
  overlay?.setAttribute("aria-hidden", "true");
  overlay?.classList.remove("dir-browser-overlay--open");
  dirBrowserCallback = null;
}

/** Returns the directory browser modal markup. */
function renderDirBrowserOverlay(): string {
  return `
    <div id="dir-browser-overlay" class="dir-browser-overlay" aria-hidden="true">
      <div class="dir-browser-box" role="dialog" aria-modal="true" aria-label="Browse directory">
        <div class="dir-browser-header">
          <span>Browse directory</span>
          <button type="button" class="dir-browser-close" id="dir-browser-close" aria-label="Close">✕</button>
        </div>
        <div class="dir-browser-breadcrumb" id="dir-browser-breadcrumb">/</div>
        <div class="dir-browser-list" id="dir-browser-list"></div>
        <div class="dir-browser-footer">
          <span class="dir-browser-selected" id="dir-browser-selected"></span>
          <button type="button" class="dir-browser-cancel" id="dir-browser-cancel">Cancel</button>
          <button type="button" class="dir-browser-select" id="dir-browser-select">Select</button>
        </div>
      </div>
    </div>
  `;
}

/** Binds directory browser modal handlers. */
function bindDirBrowserHandlers(): void {
  if ((bindDirBrowserHandlers as { _bound?: boolean })._bound) return;
  (bindDirBrowserHandlers as { _bound?: boolean })._bound = true;
  appRoot.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    const closeBtn = target.closest("#dir-browser-close, #dir-browser-cancel");
    if (closeBtn && appRoot.contains(closeBtn)) {
      closeDirBrowser();
      return;
    }
    const selectBtn = target.closest("#dir-browser-select");
    if (selectBtn && appRoot.contains(selectBtn)) {
      dirBrowserCallback?.(dirBrowserPath);
      closeDirBrowser();
      return;
    }
    const overlay = target.closest("#dir-browser-overlay");
    if (overlay && target === overlay) {
      closeDirBrowser();
    }
  });
}

/** Produces the hamburger button and menu bar HTML. */
function renderMenuBar(): string {
  const open = appState.menuOpen;
  return `
    <button class="hamburger" type="button" aria-label="Toggle menu" aria-expanded="${open}" title="Open or close top menu"
            data-action="toggle-menu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <line x1="3" y1="6"  x2="21" y2="6"/>
        <line x1="3" y1="12" x2="21" y2="12"/>
        <line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    </button>
    <div class="menu-bar ${open ? "menu-bar--open" : ""}">
      <nav class="menu-bar__items" aria-hidden="${!open}">
        <div class="menu-bar__item" data-menu="tasks">
          <button type="button" class="menu-bar__btn" data-action="open-tasks" title="Open tasks dialog">Tasks</button>
        </div>
        <div class="menu-bar__item" data-menu="views">
          <button type="button" class="menu-bar__btn" data-action="toggle-menu-dropdown" title="Open view options">Views</button>
          <div class="menu-bar__dropdown">
            <button type="button" class="menu-bar__dropdown-btn" data-action="toggle-left-sidebar"
                    aria-checked="${!appState.leftCollapsed}" title="Show or hide left sidebar">
              <span class="menu-bar__check">✓</span><span>Left sidebar</span>
            </button>
            <button type="button" class="menu-bar__dropdown-btn" data-action="toggle-right-sidebar"
                    aria-checked="${!appState.rightCollapsed}" title="Show or hide right sidebar">
              <span class="menu-bar__check">✓</span><span>Right sidebar</span>
            </button>
            <hr class="menu-bar__separator">
            <button type="button" class="menu-bar__dropdown-btn" data-action="set-theme" data-theme="light"
                    aria-checked="${document.documentElement.getAttribute('data-theme') === 'light'}" title="Switch to light theme">
              <span class="menu-bar__check">✓</span><span>Light theme</span>
            </button>
            <button type="button" class="menu-bar__dropdown-btn" data-action="set-theme" data-theme="dark"
                    aria-checked="${document.documentElement.getAttribute('data-theme') === 'dark'}" title="Switch to dark theme">
              <span class="menu-bar__check">✓</span><span>Dark theme</span>
            </button>
          </div>
        </div>
        <div class="menu-bar__item" data-menu="help">
          <button type="button" class="menu-bar__btn" data-action="open-help" title="Open help dialog">Help</button>
        </div>
      </nav>
    </div>
  `;
}

/** Wires menu bar and hamburger handlers after render. */
function bindMenuHandlers(): void {
  if ((bindMenuHandlers as { _bound?: boolean })._bound) return;
  (bindMenuHandlers as { _bound?: boolean })._bound = true;
  appRoot.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    const toggleMenuBtn = target.closest<HTMLButtonElement>('[data-action="toggle-menu"]');
    if (toggleMenuBtn && appRoot.contains(toggleMenuBtn)) {
      toggleMenu();
      return;
    }
    const openTasksBtn = target.closest<HTMLButtonElement>('[data-action="open-tasks"]');
    if (openTasksBtn && appRoot.contains(openTasksBtn)) {
      appState.menuOpen = false;
      openTasksDialog();
      return;
    }
    if (target.closest('[data-action="toggle-left-sidebar"]')) {
      toggleLeftSidebar();
      return;
    }
    if (target.closest('[data-action="toggle-right-sidebar"]')) {
      toggleRightSidebar();
      return;
    }
    const menuDropBtn = target.closest<HTMLButtonElement>('[data-action="toggle-menu-dropdown"]');
    if (menuDropBtn) {
      event.stopPropagation();
      menuDropBtn.closest<HTMLElement>(".menu-bar__item")?.classList.toggle("menu-bar__item--active");
      return;
    }
    const themeBtn = target.closest<HTMLButtonElement>('[data-action="set-theme"]');
    if (themeBtn) {
      const theme = themeBtn.getAttribute("data-theme") === "dark" ? "dark" : "light";
      applyTheme(theme);
      persistSettingLater("theme", theme);
      appRoot.querySelectorAll<HTMLButtonElement>('[data-action="set-theme"]').forEach((b) =>
        b.setAttribute("aria-checked", String(b.getAttribute("data-theme") === theme))
      );
      themeBtn.closest<HTMLElement>(".menu-bar__item")?.classList.remove("menu-bar__item--active");
    }
  });
  document.addEventListener("click", closeMenuDropdowns);
}

/** Closes all open menu dropdowns. */
function closeMenuDropdowns(): void {
  appRoot.querySelectorAll(".menu-bar__item--active").forEach((el) =>
    el.classList.remove("menu-bar__item--active")
  );
}

/** Loads app version once for Help/About tab; keeps null on failures. */
async function ensureHelpDialogVersionLoaded(): Promise<void> {
  if (helpDialogVersionFetchAttempted) return;
  helpDialogVersionFetchAttempted = true;
  try {
    const response = await fetch("/api/version");
    if (!response.ok) return;
    const version = await response.json();
    if (typeof version === "string" && version.trim() !== "") {
      helpDialogVersion = version.trim();
      if (appState.helpDialogOpen && appState.helpDialogTab === "about") {
        updateHelpDialogBodyUI();
      }
    }
  } catch {
    // Ignore version fetch failures; About tab simply omits the version row.
  }
}

/** Opens the Help dialog and starts one-time About-version loading. */
function openHelpDialog(): void {
  appState.helpDialogOpen = true;
  void ensureHelpDialogVersionLoaded();
  render();
}

/** Closes the Help dialog. */
function closeHelpDialog(): void {
  appState.helpDialogOpen = false;
  render();
}

/** Renders tab-strip + tab-content for the Help dialog body. */
function renderHelpDialogBody(): string {
  const tab = appState.helpDialogTab;
  const tabButton = (id: HelpDialogTab, label: string) =>
    `<button type="button" class="help-dialog__tab${tab === id ? " is-active" : ""}" data-action="help-tab" data-tab="${id}">${label}</button>`;

  let content = "";
  if (tab === "shortcuts") {
    content = `
      <p class="help-dialog__note"><em>Shortcuts are active only when the relevant UI area has focus.</em></p>
      <table class="help-dialog__table">
        <thead><tr><th>Scope</th><th>Key</th><th>Action</th></tr></thead>
        <tbody>
          <tr><td><code>canvas</code></td><td><code>PageUp</code></td><td>Cycle optics transform forward</td></tr>
          <tr><td><code>canvas</code></td><td><code>PageDown</code></td><td>Cycle optics transform backward</td></tr>
          <tr><td><code>canvas</code></td><td><code>ArrowLeft</code></td><td>Go to previous image</td></tr>
          <tr><td><code>canvas</code></td><td><code>ArrowRight</code></td><td>Go to next image</td></tr>
          <tr><td><code>canvas</code></td><td><code>Ctrl</code> (hold)</td><td>Hide all masks while held</td></tr>
          <tr><td><code>canvas</code></td><td><code>Escape</code></td><td>Deselect selected mask; close context menu</td></tr>
          <tr><td><code>canvas</code></td><td><code>Delete</code></td><td>Remove selected mask</td></tr>
          <tr><td><code>canvas</code></td><td><code>Backspace</code></td><td>Undo last annotation change</td></tr>
          <tr><td><code>canvas</code></td><td><code>ArrowUp</code></td><td>Cycle mask selection backward</td></tr>
          <tr><td><code>canvas</code></td><td><code>ArrowDown</code></td><td>Cycle mask selection forward</td></tr>
          <tr><td><code>navigation</code></td><td><code>Enter</code></td><td>Jump to typed image index</td></tr>
          <tr><td><code>taskDialog</code></td><td><code>Enter</code></td><td>Add tag / commit field / add label (by target selector)</td></tr>
          <tr><td><code>taskLabelTree</code></td><td><code>ArrowUp</code> / <code>ArrowDown</code></td><td>Reorder label within parent</td></tr>
          <tr><td><code>taskLabelTree</code></td><td><code>ArrowLeft</code> / <code>ArrowRight</code></td><td>Promote / demote label in hierarchy</td></tr>
          <tr><td><code>taskLabelTree</code></td><td><code>Tab</code> / <code>Shift+Tab</code></td><td>Move focus between label rows</td></tr>
        </tbody>
      </table>
    `;
  } else if (tab === "annotations") {
    content = `
      <ul class="help-dialog__list">
        <li>Point mode: left-click places a mask; shift+left-click removes the nearest mask.</li>
        <li>Double-click selects one mask. Escape clears selection. Arrow keys cycle selection.</li>
        <li>Right-click near a mask opens label assignment with recent labels first.</li>
        <li>Annotations list mirrors current masks and highlights the selected mask row.</li>
        <li>Image and annotation comments sync live across users with author metadata.</li>
      </ul>
    `;
  } else if (tab === "navigation") {
    content = `
      <ul class="help-dialog__list">
        <li>Use previous/next buttons in the left sidebar to switch images.</li>
        <li>Type a 1-based image index and press Enter to jump directly.</li>
        <li>Fast-forward jumps to the next image whose annotation file is missing or empty.</li>
        <li>The top menu includes Tasks, Views, and Help.</li>
      </ul>
    `;
  } else {
    const versionLine = helpDialogVersion
      ? `<div><strong>Version:</strong> ${escapeHtml(helpDialogVersion)}</div>`
      : "";
    content = `
      <div class="help-dialog__about">
        <div><strong>App:</strong> Nemo-Lab</div>
        ${versionLine}
      </div>
    `;
  }

  return `
    <div class="help-dialog__tabs" role="tablist" aria-label="Help sections">
      ${tabButton("shortcuts", "Shortcuts")}
      ${tabButton("annotations", "Annotations & Masks")}
      ${tabButton("navigation", "Navigation")}
      ${tabButton("about", "About")}
    </div>
    <div class="help-dialog__content">${content}</div>
  `;
}

/** Produces the full Help modal HTML. */
function renderHelpDialog(): string {
  if (!appState.helpDialogOpen) return "";
  return `
    <div class="help-backdrop" data-action="close-help-backdrop">
      <div class="help-dialog" role="dialog" aria-modal="true" aria-label="Help">
        <div class="help-dialog__header">
          <h2 class="help-dialog__title">Help</h2>
          <button type="button" class="help-dialog__close" data-action="close-help">✕</button>
        </div>
        <div class="help-dialog__body">${renderHelpDialogBody()}</div>
      </div>
    </div>
  `;
}

/** Updates only the Help-dialog body, preserving the rest of the modal tree. */
function updateHelpDialogBodyUI(): void {
  const body = appRoot.querySelector<HTMLElement>(".help-dialog__body");
  if (!body) return;
  body.innerHTML = renderHelpDialogBody();
}

/** Wires delegated handlers for Help dialog open/close/tab actions. */
function bindHelpDialogHandlers(): void {
  if ((bindHelpDialogHandlers as { _bound?: boolean })._bound) return;
  (bindHelpDialogHandlers as { _bound?: boolean })._bound = true;
  appRoot.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    if (target.closest('[data-action="open-help"]')) {
      appState.menuOpen = false;
      openHelpDialog();
      return;
    }
    if (target.closest('[data-action="close-help"]')) {
      closeHelpDialog();
      return;
    }
    const backdrop = target.closest<HTMLElement>('[data-action="close-help-backdrop"]');
    if (backdrop && target === backdrop) {
      closeHelpDialog();
      return;
    }
    const tabButton = target.closest<HTMLButtonElement>('[data-action="help-tab"]');
    if (!tabButton) return;
    const nextTab = tabButton.dataset["tab"] as HelpDialogTab | undefined;
    if (
      nextTab !== "shortcuts" &&
      nextTab !== "annotations" &&
      nextTab !== "navigation" &&
      nextTab !== "about"
    ) {
      return;
    }
    appState.helpDialogTab = nextTab;
    updateHelpDialogBodyUI();
  });
}

// ── Tasks dialog ──────────────────────────────────────────────────────────────

const TASK_STATUSES: Array<{ key: Task["status"]; label: string; color: string }> = [
  { key: "new",   label: "new",   color: "#f0c040" },
  { key: "doing", label: "doing", color: "#5baaf5" },
  { key: "done",  label: "done",  color: "#4caf50" },
  { key: "error", label: "error", color: "#e05555" },
];

/** Returns the color for a task status. */
function taskStatusColor(status: Task["status"]): string {
  return TASK_STATUSES.find((s) => s.key === status)?.color ?? "#aaa";
}

/** Returns a unique id for new tasks. */
function createTaskId(): string {
  return `task-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

/** Collapses all tasks except the given one. */
function setExpandedTask(task: Task): void {
  appState.tasks.forEach((t) => {
    t.collapsed = t !== task;
  });
}

/** Moves a task by delta in list order and persists ord values (admin only). */
async function moveTaskBy(id: string, delta: number): Promise<void> {
  if (!appState.isAdmin) return;
  const idx = appState.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const next = idx + delta;
  if (next < 0 || next >= appState.tasks.length) return;

  const previousOrder = [...appState.tasks];
  const [moved] = appState.tasks.splice(idx, 1);
  appState.tasks.splice(next, 0, moved);
  render();

  const ok = await runTaskSave(
    async () => {
      for (const task of appState.tasks) {
        await persistTaskScalars(task);
      }
    },
    "Failed to persist task order.",
    "tasks: save order failed"
  );
  if (!ok) {
    appState.tasks = previousOrder;
    render();
  }
}

/** Removes a task by id, persists delete, and re-renders. */
async function removeTask(id: string): Promise<void> {
  const idx = appState.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [removed] = appState.tasks.splice(idx, 1);
  render();
  const ok = await runTaskSave(
    () => persistTaskDelete(id),
    "Failed to delete task.",
    "tasks: delete failed"
  );
  if (!ok) {
    appState.tasks.splice(idx, 0, removed);
    render();
  }
}

/** Appends a blank task, persists it, and re-renders. */
async function addTask(): Promise<void> {
  const task: Task = {
    id: createTaskId(),
    description: "",
    status: "new",
    tags: [],
    images: "",
    annotations: "",
    checkmark: false,
    comment: "",
    collapsed: false,
    labels: [],
    selectedLabelId: null,
  };
  setExpandedTask(task);
  appState.tasks.push(task);
  render();
  const ok = await runTaskSave(
    () => persistTaskScalars(task),
    "Failed to create task.",
    "tasks: create failed"
  );
  if (!ok) {
    appState.tasks = appState.tasks.filter((t) => t.id !== task.id);
    render();
  }
}

/** Produces the collapsed summary row for one task card. */
function renderTaskCardSummary(task: Task): string {
  const color = taskStatusColor(task.status);
  const firstLine = (task.description.split("\n")[0] ?? "").replace(/</g, "&lt;");
  const tagsHtml = task.tags
    .map((t) => `<span class="task-pin task-pin--preview">${t.replace(/</g, "&lt;")}</span>`)
    .join("");
  const reorderButtons = appState.isAdmin
    ? `
      <span class="task-reorder-controls">
        <button type="button" class="task-reorder-btn" data-action="move-task-up" data-task-id="${task.id}" aria-label="Move task up">↑</button>
        <button type="button" class="task-reorder-btn" data-action="move-task-down" data-task-id="${task.id}" aria-label="Move task down">↓</button>
      </span>
    `
    : "";
  return `
    <div class="task-summary" data-action="toggle-task" data-task-id="${task.id}">
      <span class="task-status-dot" style="background:${color}"></span>
      <span class="task-desc-preview">${firstLine || '<span class="muted">no description</span>'}</span>
      <span class="task-tags-preview">${tagsHtml}</span>
      ${reorderButtons}
      <span class="task-chevron">${task.collapsed ? "▶" : "▼"}</span>
    </div>
  `;
}

/** Generates a unique id for a new label node. */
function labelNodeId(): string {
  return `ln-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

/** Recursively renders a label tree as HTML. */
function renderLabelTree(
  nodes: LabelNode[],
  selectedId: string | null = null,
  editable = true,
  isRoot = true
): string {
  if (!nodes.length) return isRoot ? `<span class="label-tree__empty">no labels</span>` : "";
  const items = nodes
    .map((node) => {
      const selected = node.id === selectedId ? " is-selected" : "";
      const children = renderLabelTree(node.children, selectedId, editable, false);
      return `
      <li class="label-tree__item" data-node-id="${node.id}">
        <div class="label-tree__row${selected}" tabindex="${editable ? "0" : "-1"}" data-node-id="${node.id}">
          <span class="label-tree__text">${node.text.replace(/</g, "&lt;")}</span>
          ${editable ? `<button class="label-tree__delete" tabindex="-1" data-action="remove-label" data-node-id="${node.id}" aria-label="remove" title="remove">✕</button>` : ""}
        </div>
        ${children}
      </li>`;
    })
    .join("");
  return `<ul class="label-tree__list">${items}</ul>`;
}

/** Metadata returned by findLabelNodeMeta for tree manipulation. */
interface LabelNodeMeta {
  node: LabelNode;
  parentArr: LabelNode[];
  index: number;
  parentNode: LabelNode | null;
  grandParentArr: LabelNode[] | null;
}

/** Finds a label node by id and returns it with parent context. */
function findLabelNodeMeta(
  id: string,
  nodes: LabelNode[],
  parentArr: LabelNode[] = nodes,
  parentNode: LabelNode | null = null,
  grandParentArr: LabelNode[] | null = null
): LabelNodeMeta | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.id === id) return { node, parentArr, index: i, parentNode, grandParentArr };
    const found = findLabelNodeMeta(id, node.children, node.children, node, nodes);
    if (found) return found;
  }
  return null;
}

/** Recursively removes a label node by id. Returns true if removed. */
function removeLabelNode(id: string, nodes: LabelNode[]): boolean {
  const idx = nodes.findIndex((n) => n.id === id);
  if (idx !== -1) { nodes.splice(idx, 1); return true; }
  for (const node of nodes) {
    if (removeLabelNode(id, node.children)) return true;
  }
  return false;
}

/** Re-renders the label tree inside treeEl and re-binds handlers. */
function refreshLabelTree(treeEl: HTMLElement, task: Task, focusNodeId?: string): void {
  const editable = appState.isAdmin;
  treeEl.innerHTML =
    renderLabelTree(task.labels, task.selectedLabelId, editable) +
    (editable ? `<input class="label-tree__new" type="text" placeholder="new label" />` : "");
  bindLabelTree(treeEl, task);
  if (focusNodeId) {
    const row = treeEl.querySelector<HTMLElement>(`.label-tree__row[data-node-id="${focusNodeId}"]`);
    row?.focus();
  }
}

/** Binds all label tree interaction handlers. */
function bindLabelTree(treeEl: HTMLElement, task: Task): void {
  const selectNode = (nodeId: string) => {
    task.selectedLabelId = nodeId;
    treeEl.querySelectorAll(".label-tree__row").forEach((row) => {
      row.classList.toggle("is-selected", (row as HTMLElement).dataset["nodeId"] === nodeId);
    });
  };

  treeEl.querySelectorAll<HTMLElement>(".label-tree__row").forEach((row) => {
    if (row.dataset["boundLabelRow"] === "1") return;
    row.dataset["boundLabelRow"] = "1";
    row.addEventListener("click", () => selectNode(row.dataset["nodeId"]!));
    row.addEventListener("focus", () => selectNode(row.dataset["nodeId"]!));
  });

  treeEl.querySelectorAll<HTMLButtonElement>("[data-action='remove-label']").forEach((btn) => {
    if (btn.dataset["boundRemoveLabel"] === "1") return;
    btn.dataset["boundRemoveLabel"] = "1";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const removedId = btn.dataset["nodeId"]!;
      removeLabelNode(removedId, task.labels);
      if (task.selectedLabelId === removedId) task.selectedLabelId = null;
      refreshLabelTree(treeEl, task);
      void runTaskSave(
        () => persistTaskLabels(task),
        "Failed to save labels.",
        "tasks: save labels failed"
      );
    });
  });

}

/** Produces the expanded body for one task card. */
function renderTaskCardBody(task: Task): string {
  const admin = appState.isAdmin;
  const statusOptions = TASK_STATUSES.map((s) =>
    `<option value="${s.key}" ${task.status === s.key ? "selected" : ""}>${s.label}</option>`
  ).join("");
  const tagsHtml = task.tags
    .map(
      (t) =>
        `<span class="task-pin"><span>${t.replace(/</g, "&lt;")}</span>` +
        `<button type="button" class="task-pin__remove" data-action="remove-tag" data-task-id="${task.id}" data-tag="${t.replace(/"/g, "&quot;")}">✕</button></span>`
    )
    .join("");

  return `
    <div class="task-body">
      <div class="task-field-row">
        <span class="task-field-label">description</span>
        <textarea class="task-field-input" data-field="description" data-task-id="${task.id}"
          rows="3" ${admin ? "" : "readonly"}>${task.description.replace(/</g, "&lt;")}</textarea>
      </div>
      <div class="task-field-row">
        <span class="task-field-label">status</span>
        <div class="task-status-wrap">
          <span class="task-status-dot" style="background:${taskStatusColor(task.status)}"></span>
          <select class="task-status-select" data-action="set-status" data-task-id="${task.id}">
            ${statusOptions}
          </select>
          <button type="button" class="task-continue-btn"
                  data-action="continue-task" data-task-id="${task.id}">
            continue work
          </button>
        </div>
      </div>
      <div class="task-field-row">
        <span class="task-field-label">tags</span>
        <div class="task-tags-wrap" data-task-id="${task.id}">
          ${tagsHtml}
          <input class="task-tag-input" type="text" placeholder="add tag…"
                 data-action="add-tag" data-task-id="${task.id}">
        </div>
      </div>
      <div class="task-field-row">
        <span class="task-field-label">images</span>
        <div class="task-path-row">
          <input class="task-field-input" type="text" data-field="images" data-task-id="${task.id}"
            value="${task.images.replace(/"/g, "&quot;")}" placeholder="/path/to/folder"
            ${admin ? "" : "readonly"}>
          ${admin ? '<button type="button" class="task-browse-btn">browse</button>' : ""}
        </div>
      </div>
      <div class="task-field-row">
        <span class="task-field-label">annotations</span>
        <div class="task-path-row">
          <input class="task-field-input" type="text" data-field="annotations" data-task-id="${task.id}"
            value="${task.annotations.replace(/"/g, "&quot;")}" placeholder="/path/to/file"
            ${admin ? "" : "readonly"}>
          ${admin ? '<button type="button" class="task-browse-btn">browse</button>' : ""}
        </div>
      </div>
      <div class="task-field-row">
        <span class="task-field-label"></span>
        <div class="task-checkbox-row">
          <input type="checkbox" id="task-chk-${task.id}"
                 data-action="set-checkmark" data-task-id="${task.id}"
                 ${task.checkmark ? "checked" : ""} ${admin ? "" : "disabled"}>
          <label for="task-chk-${task.id}">single annotation file 'nemolab.json'</label>
        </div>
      </div>
      <div class="task-field-row">
        <span class="task-field-label">labels</span>
        <div class="label-tree" data-task-id="${task.id}"${admin ? ' data-shortcut-scope="taskLabelTree"' : ""}>
          ${renderLabelTree(task.labels, task.selectedLabelId, admin)}
          ${admin ? `<input class="label-tree__new" type="text" placeholder="new label" />` : ""}
        </div>
      </div>
      <div class="task-field-row">
        <span class="task-field-label">comment</span>
        <textarea class="task-field-input" data-field="comment" data-task-id="${task.id}"
          rows="2">${task.comment.replace(/</g, "&lt;")}</textarea>
      </div>
      ${admin ? `<button type="button" class="task-delete-btn" data-action="delete-task" data-task-id="${task.id}">delete task</button>` : ""}
    </div>
  `;
}

/** Produces one full task card element HTML string. */
function renderTaskCard(task: Task): string {
  return `
    <div class="task-card ${task.collapsed ? "task-card--collapsed" : ""}" data-task-id="${task.id}">
      ${renderTaskCardSummary(task)}
      ${task.collapsed ? "" : renderTaskCardBody(task)}
    </div>
  `;
}

/** Produces the full Tasks modal HTML. */
function renderTasksDialog(): string {
  if (!appState.tasksDialogOpen) return "";
  const admin = appState.isAdmin;
  const badge = admin
    ? '<span class="tasks-admin-badge tasks-admin-badge--admin">admin</span>'
    : '<span class="tasks-admin-badge tasks-admin-badge--user">user</span>';
  const statusText = appState.tasksLoading
    ? "Loading tasks..."
    : (appState.tasksSavingCount > 0 ? `Saving (${appState.tasksSavingCount})...` : "");
  const statusClass = appState.tasksLoading ? "is-loading" : "is-saving";
  const statusHtml = statusText
    ? `<span class="tasks-dialog__status ${statusClass}">${statusText}</span>`
    : "";
  const errorHtml = appState.tasksError
    ? `<div class="tasks-dialog__error" role="status">${appState.tasksError.replace(/</g, "&lt;")}</div>`
    : "";
  const cards = appState.tasks.map(renderTaskCard).join("");
  const addBtn = admin
    ? '<button type="button" class="task-add-btn" data-action="add-task">+ new task</button>'
    : "";
  return `
    <div class="tasks-backdrop" data-action="close-tasks-backdrop">
      <div class="tasks-dialog" role="dialog" aria-modal="true" aria-label="Tasks" data-shortcut-scope="taskDialog">
        <div class="tasks-dialog__header">
          <h2 class="tasks-dialog__title">Tasks</h2>
          ${badge}
          ${statusHtml}
          <button type="button" class="tasks-dialog__close" data-action="close-tasks">✕</button>
        </div>
        <div class="tasks-dialog__body">
          ${errorHtml}
          ${cards}
          ${addBtn}
        </div>
      </div>
    </div>
  `;
}

/** Commits one editable task field and persists it. */
function commitTaskFieldInput(input: HTMLInputElement | HTMLTextAreaElement): void {
  const id = input.getAttribute("data-task-id");
  const field = input.getAttribute("data-field") as keyof Pick<Task, "description" | "images" | "annotations" | "comment"> | null;
  const task = id ? (appState.tasks.find((t) => t.id === id) ?? null) : null;
  if (!task || !field) return;
  task[field] = input.value;
  input.classList.remove("task-field--dirty");
  input.classList.add("task-field--saved");
  setTimeout(() => input.classList.remove("task-field--saved"), 1000);
  if (field === "description") {
    const card = appRoot.querySelector<HTMLElement>(`.task-card[data-task-id="${id}"]`);
    if (card) updateTaskSummaryDesc(card, task);
  }
  void runTaskSave(
    () => persistTaskScalars(task),
    "Failed to save task field.",
    "tasks: save field failed"
  );
}

/** Wires all Tasks dialog handlers after render. */
function bindTasksDialogHandlers(): void {
  if ((bindTasksDialogHandlers as { _bound?: boolean })._bound) return;
  (bindTasksDialogHandlers as { _bound?: boolean })._bound = true;
  const getTask = (taskId: string | null): Task | null =>
    taskId ? (appState.tasks.find((t) => t.id === taskId) ?? null) : null;

  appRoot.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    if (target.closest('[data-action="close-tasks"]')) {
      closeTasksDialog();
      return;
    }
    const backdrop = target.closest<HTMLElement>('[data-action="close-tasks-backdrop"]');
    if (backdrop && target === backdrop) {
      closeTasksDialog();
      return;
    }
    const toggleTaskBtn = target.closest<HTMLElement>('[data-action="toggle-task"]');
    if (toggleTaskBtn) {
      const task = getTask(toggleTaskBtn.getAttribute("data-task-id"));
      if (!task) return;
      if (task.collapsed) setExpandedTask(task);
      else task.collapsed = true;
      render();
      return;
    }
    const moveUp = target.closest<HTMLButtonElement>('[data-action="move-task-up"]');
    if (moveUp) {
      event.stopPropagation();
      void moveTaskBy(moveUp.getAttribute("data-task-id")!, -1);
      return;
    }
    const moveDown = target.closest<HTMLButtonElement>('[data-action="move-task-down"]');
    if (moveDown) {
      event.stopPropagation();
      void moveTaskBy(moveDown.getAttribute("data-task-id")!, 1);
      return;
    }
    const removeTagBtn = target.closest<HTMLButtonElement>('[data-action="remove-tag"]');
    if (removeTagBtn) {
      const id = removeTagBtn.getAttribute("data-task-id");
      const tag = removeTagBtn.getAttribute("data-tag");
      const task = getTask(id);
      if (!task || !tag) return;
      task.tags = task.tags.filter((t) => t !== tag);
      removeTagBtn.closest(".task-pin")?.remove();
      const card = appRoot.querySelector<HTMLElement>(`.task-card[data-task-id="${id}"]`);
      if (card) updateTaskSummaryTags(card, task);
      void runTaskSave(() => persistTaskTags(task), "Failed to save task tags.", "tasks: save tags failed");
      return;
    }
    const deleteTaskBtn = target.closest<HTMLButtonElement>('[data-action="delete-task"]');
    if (deleteTaskBtn) {
      void removeTask(deleteTaskBtn.getAttribute("data-task-id")!);
      return;
    }
    if (target.closest('[data-action="add-task"]')) {
      void addTask();
      return;
    }
    const browseBtn = target.closest<HTMLButtonElement>(".task-browse-btn");
    if (browseBtn) {
      const input = browseBtn.closest(".task-path-row")?.querySelector<HTMLInputElement>(".task-field-input");
      if (!input) return;
      openDirBrowser(input.value || "/", (path) => {
        input.value = path;
        commitTaskField(input);
      });
      return;
    }
    const continueBtn = target.closest<HTMLButtonElement>('[data-action="continue-task"]');
    if (continueBtn) {
      const id = continueBtn.getAttribute("data-task-id");
      const task = getTask(id);
      if (!task) return;
      if (task.status !== "doing") {
        task.status = "doing";
        void runTaskSave(
          () => persistTaskScalars(task),
          "Failed to save task status.",
          "tasks: continue-work status save failed"
        );
      }
      logEvent("set_active_task", { task_id: id });
      appState.activeLabels = task.labels;
      appState.activeLabelSelectedId = firstLeafLabelId(task.labels);
      appState.recentLabels = [];
      appState.activeTaskImagesPath = task.images;
      appState.activeTaskAnnotationsPath = task.annotations;
      appState.activeTaskSingleFile = task.checkmark;
      appState.pendingActivationLogHash = null;
      appState.imageList = [];
      appState.currentImageIndex = 0;
      appState.currentImageHash = null;
      appState.masks = [];
      appState.draftBboxMask = null;
      appState.draftFreehandStroke = null;
      closeMaskContextMenu();
      appState.tasksDialogOpen = false;
      render();
      return;
    }
    const removeLabelBtn = target.closest<HTMLButtonElement>(".label-tree [data-action='remove-label']");
    if (removeLabelBtn) {
      event.stopPropagation();
      const tree = removeLabelBtn.closest<HTMLElement>(".label-tree[data-task-id]");
      const task = getTask(tree?.dataset["taskId"] ?? null);
      const removedId = removeLabelBtn.dataset["nodeId"];
      if (!task || !tree || !removedId) return;
      removeLabelNode(removedId, task.labels);
      if (task.selectedLabelId === removedId) task.selectedLabelId = null;
      refreshLabelTree(tree, task);
      void runTaskSave(() => persistTaskLabels(task), "Failed to save labels.", "tasks: save labels failed");
      return;
    }
    const labelRow = target.closest<HTMLElement>(".label-tree[data-task-id] .label-tree__row");
    if (labelRow) {
      const tree = labelRow.closest<HTMLElement>(".label-tree[data-task-id]");
      const task = getTask(tree?.dataset["taskId"] ?? null);
      const nodeId = labelRow.dataset["nodeId"];
      if (!task || !nodeId) return;
      task.selectedLabelId = nodeId;
      tree?.querySelectorAll(".label-tree__row").forEach((row) => {
        row.classList.toggle("is-selected", (row as HTMLElement).dataset["nodeId"] === nodeId);
      });
      return;
    }
  });

  appRoot.addEventListener("change", (event) => {
    const target = event.target as Element | null;
    const statusSel = target?.closest<HTMLSelectElement>('[data-action="set-status"]');
    if (statusSel) {
      const task = getTask(statusSel.getAttribute("data-task-id"));
      if (!task) return;
      task.status = statusSel.value as Task["status"];
      const card = appRoot.querySelector<HTMLElement>(`.task-card[data-task-id="${task.id}"]`);
      card?.querySelectorAll<HTMLElement>(".task-status-dot").forEach((dot) => {
        dot.style.background = taskStatusColor(task.status);
      });
      void runTaskSave(() => persistTaskScalars(task), "Failed to save task status.", "tasks: save status failed");
      return;
    }
    const chk = target?.closest<HTMLInputElement>('[data-action="set-checkmark"]');
    if (!chk) return;
    const task = getTask(chk.getAttribute("data-task-id"));
    if (!task) return;
    task.checkmark = chk.checked;
    void runTaskSave(() => persistTaskScalars(task), "Failed to save task checkmark.", "tasks: save checkmark failed");
  });

  appRoot.addEventListener("input", (event) => {
    const target = event.target as Element | null;
    const input = target?.closest<HTMLInputElement | HTMLTextAreaElement>(".task-field-input[data-field]");
    if (!input || (input as HTMLInputElement).readOnly) return;
    input.classList.add("task-field--dirty");
    input.classList.remove("task-field--saved");
  });

  appRoot.addEventListener("focusout", (event) => {
    const target = event.target as Element | null;
    const input = target?.closest<HTMLInputElement | HTMLTextAreaElement>(".task-field-input[data-field]");
    if (!input || (input as HTMLInputElement).readOnly) return;
    commitTaskFieldInput(input);
  });
}

/** Builds the tags-wrap innerHTML for a task (used in incremental updates). */
function buildTagsWrapHtml(task: Task): string {
  const tagsHtml = task.tags
    .map(
      (t) =>
        `<span class="task-pin"><span>${t.replace(/</g, "&lt;")}</span>` +
        `<button type="button" class="task-pin__remove" data-action="remove-tag" data-task-id="${task.id}" data-tag="${t.replace(/"/g, "&quot;")}">✕</button></span>`
    )
    .join("");
  return `<div class="task-tags-wrap" data-task-id="${task.id}">
    ${tagsHtml}
    <input class="task-tag-input" type="text" placeholder="add tag…"
           data-action="add-tag" data-task-id="${task.id}">
  </div>`;
}

/** Re-binds tag handlers inside a card after incremental tag-wrap update. */
function rebindTagsWrap(card: HTMLElement, task: Task): void {
  card.querySelectorAll<HTMLButtonElement>('[data-action="remove-tag"]').forEach((btn) => {
    if (btn.dataset["boundRemoveTag"] === "1") return;
    btn.dataset["boundRemoveTag"] = "1";
    btn.addEventListener("click", () => {
      const tag = btn.getAttribute("data-tag")!;
      task.tags = task.tags.filter((t) => t !== tag);
      btn.closest(".task-pin")?.remove();
      updateTaskSummaryTags(card, task);
      void runTaskSave(
        () => persistTaskTags(task),
        "Failed to save task tags.",
        "tasks: save tags failed"
      );
    });
  });
}

/** Updates the tags preview in the collapsed summary row. */
function updateTaskSummaryTags(card: HTMLElement, task: Task): void {
  const preview = card.querySelector<HTMLElement>(".task-tags-preview");
  if (preview) {
    preview.innerHTML = task.tags
      .map((t) => `<span class="task-pin task-pin--preview">${t.replace(/</g, "&lt;")}</span>`)
      .join("");
  }
}

/** Updates the description preview in the collapsed summary row. */
function updateTaskSummaryDesc(card: HTMLElement, task: Task): void {
  const preview = card.querySelector<HTMLElement>(".task-desc-preview");
  if (preview) preview.textContent = task.description.split("\n")[0] ?? "";
}

interface FocusSnapshot {
  selector: string;
  index: number;
}

/** Captures enough identity for the currently focused element to restore focus after render(). */
function captureFocusSnapshot(): FocusSnapshot | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (active === document.body) return null;
  if (active.id) {
    return { selector: `#${CSS.escape(active.id)}`, index: 0 };
  }

  const tag = active.tagName.toLowerCase();
  const attrNames = ["data-action", "name", "type", "aria-label", "placeholder"];
  const selectorParts = [tag];
  for (const attr of attrNames) {
    const value = active.getAttribute(attr);
    if (!value) continue;
    selectorParts.push(`[${attr}="${CSS.escape(value)}"]`);
  }
  const selector = selectorParts.join("");
  const matches = Array.from(document.querySelectorAll<HTMLElement>(selector));
  const index = Math.max(0, matches.indexOf(active));
  return { selector, index };
}

/** Restores focus to a matching element after render(), if one still exists. */
function restoreFocusFromSnapshot(snapshot: FocusSnapshot | null): void {
  if (!snapshot) return;
  const matches = Array.from(document.querySelectorAll<HTMLElement>(snapshot.selector));
  if (matches.length === 0) return;
  const target = matches[Math.min(snapshot.index, matches.length - 1)];
  if (!target || target === document.activeElement) return;
  target.focus();
}

/** Renders the prototype UI. */
function render(): void {
  const focusSnapshot = captureFocusSnapshot();
  const hasActiveImage = getCurrentImageEntry() !== null;
  appRoot.innerHTML = `
    <div class="layout ${appState.leftCollapsed ? "left-collapsed" : ""} ${
      appState.rightCollapsed ? "right-collapsed" : ""
    }" style="--sidebar-right-width: ${appState.rightSidebarWidth}px;">
      <aside class="sidebar sidebar--left">
        <div class="sidebar__content" data-shortcut-scope="navigation">
          <input
            type="number"
            class="left-sidebar__index"
            data-action="jump-image-index"
            aria-label="Image index"
            title="Jump to image index"
            value="${appState.imageList.length > 0 ? appState.currentImageIndex + 1 : 0}"
            min="${appState.imageList.length > 0 ? 1 : 0}"
            max="${appState.imageList.length > 0 ? appState.imageList.length : 0}"
            ${appState.imageList.length > 0 ? "" : "disabled"}
          />
          <div class="left-sidebar__image-name meta" data-role="image-label">${getCurrentImageLabel()}</div>
          <div class="left-sidebar__button-row left-sidebar__button-row--nav">
            <button type="button" class="left-sidebar__icon-btn" data-action="previous"
                    aria-label="Previous image" title="Previous image">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="5" x2="5" y2="19"/><polyline points="19,5 9,12 19,19"/></svg>
            </button>
            <button type="button" class="left-sidebar__icon-btn" data-action="next"
                    aria-label="Next image" title="Next image">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,5 15,12 5,19"/><line x1="19" y1="5" x2="19" y2="19"/></svg>
            </button>
            <button type="button" class="left-sidebar__icon-btn" data-action="fast-forward"
                    aria-label="Jump to first unannotated image" title="Jump to first unannotated image">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,5 11,12 4,19"/><polyline points="11,5 18,12 11,19"/><line x1="21" y1="5" x2="21" y2="19"/></svg>
            </button>
          </div>
          <div class="left-sidebar__button-row left-sidebar__button-row--download">
            <button type="button" class="left-sidebar__icon-btn" data-action="download-image"
                    aria-label="Download image file" title="Download image file" ${hasActiveImage ? "" : "disabled"}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2,11 C5,6 10,5 14,8 C16,9 17,10 18,11 C17,12 16,13 14,14 C10,17 5,16 2,11 Z"/><path d="M18,11 L22,7 L22,15 Z"/><circle cx="8" cy="10" r="1" fill="currentColor" stroke="none"/><line x1="11" y1="22" x2="11" y2="19"/><polyline points="8,21 11,24 14,21"/></svg>
            </button>
            <button type="button" class="left-sidebar__icon-btn" data-action="download-annotation"
                    aria-label="Download annotation file" title="Download annotation file" ${hasActiveImage ? "" : "disabled"}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14,2 L20,8 L20,22 L4,22 L4,2 Z"/><polyline points="14,2 14,8 20,8"/><polyline points="8,12 11,10 15,13 13,17 8,16 8,12"/><line x1="12" y1="21" x2="12" y2="18"/></svg>
            </button>
          </div>
        </div>
      </aside>

      <main class="image-view" tabindex="0" data-shortcut-scope="canvas">
        <div class="image-view__alerts">${renderImageHashWarnings()}</div>
        <div class="image-view__canvas-wrap">
          <canvas class="image-view__canvas" aria-label="Tile image viewer"></canvas>
        </div>
      </main>

      <aside class="sidebar sidebar--right">
        <div class="sidebar__resize-handle" role="separator" aria-orientation="vertical" aria-label="Resize right sidebar" title="Drag to resize right sidebar"></div>
        <div class="sidebar__content panels">
          ${renderPanel("optics", "optics", renderOpticsBody())}
          ${renderPanel("labels", "labels", renderLabelTree(appState.activeLabels, appState.activeLabelSelectedId, false))}
          ${renderPanel("maskMode", "mask mode", renderMaskModeBody())}
          ${renderPanel(
            "annotations",
            "annotations",
            renderAnnotationList()
          )}
          ${renderPanel(
            "commentAnnotation",
            "comment/annotation",
            renderAnnotationCommentBody()
          )}
          ${renderPanel(
            "commentPicture",
            "comment/picture",
            renderPictureCommentBody()
          )}
        </div>
      </aside>
    </div>
    <button type="button" class="sidebar-toggle sidebar-toggle--left" data-action="toggle-left" aria-label="Toggle left sidebar" title="Show or hide left sidebar">
      ${appState.leftCollapsed ? ">" : "<"}
    </button>
    ${renderMenuBar()}
    <button type="button" class="sidebar-toggle sidebar-toggle--right" data-action="toggle-right" aria-label="Toggle right sidebar" title="Show or hide right sidebar">
      ${appState.rightCollapsed ? "<" : ">"}
    </button>
    ${renderMaskContextMenu()}
    ${renderHelpDialog()}
    ${renderTasksDialog()}
    ${renderDirBrowserOverlay()}
  `;

  bindRightSidebarResizeHandle();
  mountViewer();
  updateCommentPanelsUI();
  restoreFocusFromSnapshot(focusSnapshot);
}

void (async () => {
  await loadSettingsOnStartup();
  bindAnnotationPanelHandlers();
  bindOpticsPanelHandlers();
  bindMenuHandlers();
  bindHelpDialogHandlers();
  bindGlobalNavHandlers();
  bindActiveLabelPanelHandlers();
  bindMaskModePanelHandlers();
  bindMaskContextMenuHandlers();
  bindTasksDialogHandlers();
  bindDirBrowserHandlers();
  render();
})();
