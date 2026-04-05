/** Tunable viewer constants. */
const config = {
  /** Maximum pointer travel (CSS px) between down and up to count as a click/annotation. */
  clickMaxDragPx: 10,
};

/** WebSocket endpoint for backend events. */
const ws = new WebSocket(`ws://${location.host}/ws`);

ws.addEventListener("open", () => console.log("ws: connected"));
ws.addEventListener("close", () => console.log("ws: disconnected"));
ws.addEventListener("error", (e) => console.error("ws: error", e));

/** Sends a log entry to the backend over the shared WebSocket. */
function logEvent(type: string, data: Record<string, unknown> = {}): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify({ type: "log", entry: { type, ts: new Date().toISOString(), ...data } }));
}


document.addEventListener("focusin", (e) =>
  logEvent("focus", { action: "in", target: (e.target as Element | null)?.tagName ?? "unknown" })
);
document.addEventListener("focusout", (e) =>
  logEvent("focus", { action: "out", target: (e.target as Element | null)?.tagName ?? "unknown" })
);

/** Supported image names for prototype navigation. */
const imageNames: string[] = ["r00000000f0.png", "00001140.png"];

/** Mutable prototype application state. */
const appState = {
  currentImageIndex: 0,
  leftCollapsed: false,
  rightCollapsed: false,
  panelCollapsed: {
    optics: false,
    masks: false,
    labels: false,
    annotations: false,
    commentAnnotation: false,
    commentPicture: false,
  },
  annotations: [] as AnnotationPoint[],
  /** Whether the top menu bar is visible. */
  menuOpen: false,
  /** Whether the Tasks modal is open. */
  tasksDialogOpen: false,
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
  },
};

/** Current path shown in the directory browser modal. */
let dirBrowserPath = "/";
/** Callback invoked when the user confirms a directory selection. */
let dirBrowserCallback: ((path: string) => void) | null = null;

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

/** Minimal point annotation model for this prototype. */
interface AnnotationPoint {
  /** Stable annotation identifier. */
  id: string;
  /** X coordinate in normalized image space (0..1). */
  x: number;
  /** Y coordinate in normalized image space (0..1). */
  y: number;
}

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

/** Main app container. */
// Non-null assertion is safe: the throw below ensures the app never proceeds without #app.
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const appRoot = document.querySelector<HTMLDivElement>("#app")!;
if (!appRoot) {
  throw new Error("#app root not found");
}

/** Shared WebGL viewer instance bound to current canvas. */
let viewer: WebGLTileViewer | null = null;

/** Returns the active image file name. */
function getCurrentImageName(): string {
  return imageNames[appState.currentImageIndex];
}

/** Converts a file name to its tiled folder name. */
function toImageStem(imageName: string): string {
  const lastDot = imageName.lastIndexOf(".");
  return lastDot > 0 ? imageName.slice(0, lastDot) : imageName;
}

/** Moves to previous image and resets annotation list. */
function goPreviousImage(): void {
  appState.currentImageIndex =
    (appState.currentImageIndex - 1 + imageNames.length) % imageNames.length;
  appState.annotations = [];
  logEvent("image_change", { image: getCurrentImageName() });
  render();
}

/** Moves to next image and resets annotation list. */
function goNextImage(): void {
  appState.currentImageIndex = (appState.currentImageIndex + 1) % imageNames.length;
  appState.annotations = [];
  logEvent("image_change", { image: getCurrentImageName() });
  render();
}

/** Toggles left sidebar visibility state. */
function toggleLeftSidebar(): void {
  appState.leftCollapsed = !appState.leftCollapsed;
  render();
}

/** Toggles right sidebar visibility state. */
function toggleRightSidebar(): void {
  appState.rightCollapsed = !appState.rightCollapsed;
  render();
}

/** Toggles a single right-side panel open/closed state. */
function togglePanel(panelName: keyof typeof appState.panelCollapsed): void {
  appState.panelCollapsed[panelName] = !appState.panelCollapsed[panelName];
  render();
}

/** Creates a compact unique ID for a new annotation. */
function createAnnotationId(): string {
  return `a-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

/** Adds a point annotation and refreshes dependent UI elements only. */
function addAnnotation(x: number, y: number): void {
  appState.annotations.push({ id: createAnnotationId(), x, y });
  updateAnnotationUI();
}

/** Removes a single point annotation by identifier. */
function removeAnnotation(annotationId: string): void {
  const next = appState.annotations.filter((a) => a.id !== annotationId);
  if (next.length === appState.annotations.length) {
    return;
  }
  appState.annotations = next;
  updateAnnotationUI();
}

/** Clears all point annotations for current image. */
function clearAnnotations(): void {
  appState.annotations = [];
  updateAnnotationUI();
}

/** Produces markup for a collapsible panel in right sidebar. */
function renderPanel(
  panelName: keyof typeof appState.panelCollapsed,
  title: string,
  contentHtml: string
): string {
  const collapsed = appState.panelCollapsed[panelName];

  return `
    <section class="panel ${collapsed ? "is-collapsed" : ""}" data-panel="${panelName}">
      <button class="panel__header" type="button" data-action="toggle-panel" data-panel="${panelName}">
        <span>${title}</span>
        <span>${collapsed ? "+" : "-"}</span>
      </button>
      <div class="panel__body">${contentHtml}</div>
    </section>
  `;
}

/** Produces list markup for current annotation points. */
function renderAnnotationList(): string {
  if (appState.annotations.length === 0) {
    return '<div class="muted">No annotations yet. Click on image to add.</div>';
  }

  const items = appState.annotations
    .map(
      (a, idx) =>
        `<li>#${idx + 1} (${Math.round(a.x * 100)}%, ${Math.round(a.y * 100)}%) <button type="button" data-action="remove-annotation" data-id="${a.id}">remove</button></li>`
    )
    .join("");
  return `<ol class="annotation-list">${items}</ol>`;
}

/** Re-renders annotation panel body and redraws WebGL annotations only. */
function updateAnnotationUI(): void {
  const annotationsPanelBody = appRoot.querySelector<HTMLElement>(
    '[data-panel="annotations"] .panel__body'
  );
  if (annotationsPanelBody) {
    annotationsPanelBody.innerHTML = `${renderAnnotationList()}<button type="button" data-action="clear-annotations">clear annotations</button>`;
    bindAnnotationPanelHandlers();
  }
  viewer?.draw();
}

/** Wires annotation list action buttons after panel-body updates. */
function bindAnnotationPanelHandlers(): void {
  const clearBtn = appRoot.querySelector<HTMLButtonElement>('button[data-action="clear-annotations"]');
  clearBtn?.addEventListener("click", clearAnnotations);

  const removeButtons = appRoot.querySelectorAll<HTMLButtonElement>('button[data-action="remove-annotation"]');
  removeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      if (id) {
        removeAnnotation(id);
      }
    });
  });
}

/** Produces the optics panel body HTML with three labeled sliders. */
function renderOpticsBody(): string {
  const { gamma, multiply, add } = appState.optics;
  return `
    <label class="optics-row">
      <span>gamma</span>
      <input type="range" data-optics="gamma"
        min="1.0" max="2.2" step="0.01" value="${gamma}">
      <span class="optics-val">${gamma.toFixed(2)}</span>
    </label>
    <label class="optics-row">
      <span>multiply</span>
      <input type="range" data-optics="multiply"
        min="0.5" max="2.5" step="0.01" value="${multiply}">
      <span class="optics-val">${multiply.toFixed(2)}</span>
    </label>
    <label class="optics-row">
      <span>add</span>
      <input type="range" data-optics="add"
        min="-100" max="100" step="1" value="${add}">
      <span class="optics-val">${add.toFixed(0)}</span>
    </label>
  `;
}

/** Wires optics slider input events after panel render. */
function bindOpticsPanelHandlers(): void {
  const panel = appRoot.querySelector('[data-panel="optics"]');
  if (!panel) {
    return;
  }

  panel.querySelectorAll<HTMLInputElement>("input[data-optics]").forEach((slider) => {
    slider.addEventListener("input", () => {
      const key = slider.getAttribute("data-optics") as keyof typeof appState.optics;
      const val = parseFloat(slider.value);
      appState.optics[key] = val;

      // Update displayed value next to slider without full re-render
      const valSpan = slider.nextElementSibling as HTMLElement | null;
      if (valSpan) {
        valSpan.textContent = key === "add" ? val.toFixed(0) : val.toFixed(2);
      }

      viewer?.setOptics(appState.optics.gamma, appState.optics.multiply, appState.optics.add);
    });
  });

  // Clicking the panel header title span resets all optics to defaults.
  // The header is a <button> (toggle); we detect clicks on its first <span> (title text).
  const header = panel.querySelector<HTMLButtonElement>(".panel__header");
  if (header) {
    header.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      // The toggle icon is the second <span>; the title is the first.
      // Only reset when the title span itself was clicked.
      if (target.tagName === "SPAN" && target === header.querySelector("span:first-child")) {
        appState.optics = { gamma: 1.0, multiply: 1.0, add: 0.0 };
        viewer?.setOptics(1.0, 1.0, 0.0);
        // Re-render to update slider positions to reset values
        render();
      }
    });
  }
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

/** WebGL tile viewer that renders tiles and annotation points into one canvas. */
class WebGLTileViewer {
  /** Drawing canvas. */
  private readonly canvas: HTMLCanvasElement;
  /** Current WebGL context. */
  private readonly gl: WebGLRenderingContext;
  /** Access to current annotation array. */
  private readonly getAnnotations: () => AnnotationPoint[];
  /** Callback for click-to-annotation creation. */
  private readonly onAddAnnotation: (x: number, y: number) => void;

  /** Manifest for current image. */
  private manifest: TileManifest | null = null;
  /** Active image stem. */
  private imageStem = "";
  /** Fit transform for current draw pass. */
  private transform: ViewTransform = { x: 0, y: 0, width: 0, height: 0 };
  /** Selected fit-level index. */
  private fitLevel = 0;
  /** Last level for which tiles are being loaded. */
  private loadingLevel = -1;
  /** Monotonic id for fit-level tile load batches; rejects stale async callbacks. */
  private loadingGeneration = 0;

  /** Current async request generation token. */
  private generation = 0;
  /** Ongoing entrance animation request id. */
  private animationId: number | null = null;

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

  /** Current optics: gamma exponent. */
  private opticsGamma = 1.0;
  /** Current optics: multiplicative brightness. */
  private opticsMultiply = 1.0;
  /** Current optics: additive brightness offset (normalized). */
  private opticsAdd = 0.0;

  /** Point shader program. */
  private readonly pointProgram: WebGLProgram;
  /** Point program position attribute location. */
  private readonly pointPosAttrib: number;
  /** Point program color uniform location. */
  private readonly pointColorUniform: WebGLUniformLocation;
  /** Point program size uniform location. */
  private readonly pointSizeUniform: WebGLUniformLocation;

  /** Shared buffer for quad positions and point positions. */
  private readonly positionBuffer: WebGLBuffer;
  /** Shared buffer for quad UV coordinates. */
  private readonly uvBuffer: WebGLBuffer;

  /** Canvas resize observer. */
  private resizeObserver: ResizeObserver | null = null;
  /** Fallback window resize listener for environments without ResizeObserver. */
  private windowResizeHandler: (() => void) | null = null;

  /** Current animation multiplier between natural and fit scale. */
  private animationScale = 1;
  /** Current zoom in CSS pixels per source pixel. */
  private zoom = 1;
  /** Current left offset of image in canvas CSS pixels. */
  private offsetX = 0;
  /** Current top offset of image in canvas CSS pixels. */
  private offsetY = 0;
  /** True while primary-pointer drag pan is active. */
  private isDragging = false;
  /** Previous pointer X used for drag delta integration. */
  private dragLastX = 0;
  /** Previous pointer Y used for drag delta integration. */
  private dragLastY = 0;
/** Accumulated pointer travel in CSS px since last pointerdown. */
  private dragTotalDistance = 0;

  constructor(
    canvas: HTMLCanvasElement,
    getAnnotations: () => AnnotationPoint[],
    onAddAnnotation: (x: number, y: number) => void
  ) {
    this.canvas = canvas;
    this.getAnnotations = getAnnotations;
    this.onAddAnnotation = onAddAnnotation;

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
      void main() {
        v_uv = a_uv;
        gl_Position = vec4(a_pos, 0.0, 1.0);
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
      void main() {
        gl_Position = vec4(a_pos, 0.0, 1.0);
        gl_PointSize = u_size;
      }
      `,
      `
      precision mediump float;
      uniform vec4 u_color;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        if (dot(c, c) > 0.25) {
          discard;
        }
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
    if (!tileSampler || !tileGamma || !tileMultiply || !tileAdd) {
      throw new Error("Tile uniforms missing");
    }
    this.tileSamplerUniform = tileSampler;
    this.tileGammaUniform = tileGamma;
    this.tileMultiplyUniform = tileMultiply;
    this.tileAddUniform = tileAdd;

    this.pointPosAttrib = gl.getAttribLocation(this.pointProgram, "a_pos");
    const pointColor = gl.getUniformLocation(this.pointProgram, "u_color");
    const pointSize = gl.getUniformLocation(this.pointProgram, "u_size");
    if (!pointColor || !pointSize) {
      throw new Error("Point uniforms missing");
    }
    this.pointColorUniform = pointColor;
    this.pointSizeUniform = pointSize;

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
  setOptics(gamma: number, multiply: number, add: number): void {
    this.opticsGamma = gamma;
    this.opticsMultiply = multiply;
    /** Add value is stored as a normalized offset (divide by 255 so the shader
     *  operates in [0,1] color space regardless of the slider's -100..100 range). */
    this.opticsAdd = add / 255;
    this.draw();
  }

  /** Releases listeners and GPU resources. */
  destroy(): void {
    const gl = this.gl;

    this.generation += 1;
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.windowResizeHandler) {
      window.removeEventListener("resize", this.windowResizeHandler);
      this.windowResizeHandler = null;
    }
    this.canvas.removeEventListener("click", this.handleCanvasClick);
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
  }

  /** Loads a new tiled image by stem name. */
  async setImage(imageStem: string): Promise<void> {
    this.imageStem = imageStem;
    this.manifest = null;
    this.level0Tile = null;
    this.fitTiles.clear();
    this.loadingLevel = -1;
    this.loadingGeneration = 0;
    this.animationScale = 1;

    this.clearTextures();
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
    const fitScale = this.fitScaleForDimensions(manifest.width, manifest.height);
    this.zoom = fitScale;
    this.offsetX = (this.canvas.clientWidth - fitScale * manifest.width) / 2;
    this.offsetY = (this.canvas.clientHeight - fitScale * manifest.height) / 2;
    this.fitLevel = this.pickFitLevel();
    this.updateCanvasZoomLevelClass();

    await this.loadLevel0(requestId);
    this.startFitAnimation();
    this.loadFitLevelTiles(requestId);
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
      this.level0Tile = this.uploadTileTexture(0, 0, image);
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

    const level = this.pickFitLevel();
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
            const tile = this.uploadTileTexture(tx, ty, image);
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

    const vpImageX0 = (0 - this.offsetX) / this.zoom;
    const vpImageY0 = (0 - this.offsetY) / this.zoom;
    const vpImageX1 = (this.canvas.clientWidth - this.offsetX) / this.zoom;
    const vpImageY1 = (this.canvas.clientHeight - this.offsetY) / this.zoom;

    const scaleX = levelWidth / this.manifest.width;
    const scaleY = levelHeight / this.manifest.height;
    const vpX0 = vpImageX0 * scaleX;
    const vpY0 = vpImageY0 * scaleY;
    const vpX1 = vpImageX1 * scaleX;
    const vpY1 = vpImageY1 * scaleY;

    const tileX0 = tx * tileSize;
    const tileY0 = ty * tileSize;
    const tileX1 = Math.min((tx + 1) * tileSize, levelWidth);
    const tileY1 = Math.min((ty + 1) * tileSize, levelHeight);

    return tileX0 < vpX1 && tileX1 > vpX0 && tileY0 < vpY1 && tileY1 > vpY0;
  }

  /** Runs the 0.5 second level-0 grow animation to fit scale. */
  private startFitAnimation(): void {
    if (!this.manifest) {
      return;
    }

    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    const durationMs = 200;
    const start = performance.now();

    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / durationMs);
      this.animationScale = 1 + (this.fitScaleForLevel(0) - 1) * t;
      this.draw();

      if (t < 1) {
        this.animationId = requestAnimationFrame(step);
      } else {
        this.animationId = null;
      }
    };

    this.animationScale = 1;
    this.animationId = requestAnimationFrame(step);
  }

  /** Picks the first level whose resolution exceeds canvas pixels*dpr target. */
  private pickFitLevel(): number {
    if (!this.manifest) {
      return 0;
    }

    const dpr = window.devicePixelRatio || 1;
    const targetW = this.zoom * this.manifest.width * dpr;
    const targetH = this.zoom * this.manifest.height * dpr;

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

    if (this.animationId !== null) {
      const dims = getLevelDimensions(this.manifest, 0);
      const drawW = dims.width * this.animationScale;
      const drawH = dims.height * this.animationScale;
      this.transform = {
        x: (this.canvas.clientWidth - drawW) / 2,
        y: (this.canvas.clientHeight - drawH) / 2,
        width: drawW,
        height: drawH,
      };
    } else {
      this.transform = {
        x: this.offsetX,
        y: this.offsetY,
        width: this.zoom * this.manifest.width,
        height: this.zoom * this.manifest.height,
      };
    }
  }

  /** Returns fit scale for a specific level. */
  private fitScaleForLevel(level: number): number {
    if (!this.manifest) {
      return 1;
    }
    const dims = getLevelDimensions(this.manifest, level);
    return this.fitScaleForDimensions(dims.width, dims.height);
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

    const minZoom = Math.max(
      Math.min(
        (cw - 2 * pad) / this.manifest.width,
        (ch - 2 * pad) / this.manifest.height
      ),
      1e-6
    );
    this.zoom = Math.max(minZoom, Math.min(2, this.zoom));

    const imgW = this.zoom * this.manifest.width;
    const imgH = this.zoom * this.manifest.height;

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
      return;
    }
    const atMax = this.fitLevel === this.manifest.levels - 1;
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

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Returns CSS-pixel placement for one tile in the current view transform. */
  private getTilePlacementRect(
    tile: Pick<LoadedTile, "tx" | "ty" | "width" | "height">,
    levelWidth: number,
    levelHeight: number
  ): TilePlacementRect {
    const tileSize = this.manifest?.tile_size ?? 256;
    const x = this.transform.x + ((tile.tx * tileSize) / levelWidth) * this.transform.width;
    const y = this.transform.y + ((tile.ty * tileSize) / levelHeight) * this.transform.height;
    const width = (tile.width / levelWidth) * this.transform.width;
    const height = (tile.height / levelHeight) * this.transform.height;
    return { x, y, width, height };
  }

/** Draws normalized annotation points over image content. */
  private drawAnnotations(): void {
    const annotations = this.getAnnotations();
    if (annotations.length === 0) {
      return;
    }

    const gl = this.gl;
    const points = new Float32Array(annotations.length * 2);

    annotations.forEach((annotation, index) => {
      const x = this.transform.x + annotation.x * this.transform.width;
      const y = this.transform.y + annotation.y * this.transform.height;
      points[index * 2] = (x / this.canvas.clientWidth) * 2 - 1;
      points[index * 2 + 1] = 1 - (y / this.canvas.clientHeight) * 2;
    });

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.pointProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, points, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.pointPosAttrib);
    gl.vertexAttribPointer(this.pointPosAttrib, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(this.pointColorUniform, 1, 0.44, 0.38, 1);
    gl.uniform1f(this.pointSizeUniform, 10);

    gl.drawArrays(gl.POINTS, 0, annotations.length);

    gl.disable(gl.BLEND);
  }

  /** Uploads one image tile as a WebGL texture. */
  private uploadTileTexture(tx: number, ty: number, image: HTMLImageElement): LoadedTile {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) {
      throw new Error("Failed to create texture");
    }

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

  /** Handles canvas click by mapping into normalized image coordinates. */
  private readonly handleCanvasClick = (event: MouseEvent): void => {
    if (this.dragTotalDistance > config.clickMaxDragPx) {
      return;
    }
    const bounds = this.canvas.getBoundingClientRect();
    const px = event.clientX - bounds.left;
    const py = event.clientY - bounds.top;

    if (
      px < this.transform.x ||
      py < this.transform.y ||
      px > this.transform.x + this.transform.width ||
      py > this.transform.y + this.transform.height
    ) {
      return;
    }

    const x = (px - this.transform.x) / this.transform.width;
    const y = (py - this.transform.y) / this.transform.height;
    this.onAddAnnotation(x, y);
  };

  /** Handles wheel-based pan/zoom gestures centered at cursor. */
  private readonly handleWheel = (event: WheelEvent): void => {
    if (!this.manifest || this.animationId !== null) {
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
  };

  /** Starts drag-pan tracking on primary-pointer down. */
  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.animationId !== null) {
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
  private readonly handlePointerUp = (_event: PointerEvent): void => {
    if (!this.isDragging) {
      return;
    }
    this.isDragging = false;
    this.maybeChangeFitLevel();
  };

  /** Sets up listeners for click and resize-driven level refit. */
  private setupCanvasListeners(): void {
    this.canvas.addEventListener("click", this.handleCanvasClick);
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
  viewer = new WebGLTileViewer(
    canvas,
    () => appState.annotations,
    (x, y) => addAnnotation(x, y)
  );

  const { gamma, multiply, add } = appState.optics;
  viewer.setOptics(gamma, multiply, add);
  void viewer.setImage(toImageStem(getCurrentImageName()));
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
  document.getElementById("dir-browser-close")?.addEventListener("click", closeDirBrowser);
  document.getElementById("dir-browser-cancel")?.addEventListener("click", closeDirBrowser);
  const overlay = document.getElementById("dir-browser-overlay");
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) {
      closeDirBrowser();
    }
  });
  document.getElementById("dir-browser-select")?.addEventListener("click", () => {
    dirBrowserCallback?.(dirBrowserPath);
    closeDirBrowser();
  });
}

/** Produces the hamburger button + menu bar HTML. */
function renderMenuBar(): string {
  const open = appState.menuOpen;
  return `
    <button class="hamburger" type="button" aria-label="Toggle menu" aria-expanded="${open}"
            data-action="toggle-menu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <line x1="3" y1="6"  x2="21" y2="6"/>
        <line x1="3" y1="12" x2="21" y2="12"/>
        <line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    </button>
    <nav class="menu-bar ${open ? "menu-bar--open" : ""}" aria-hidden="${!open}">
      <div class="menu-bar__item" data-menu="tasks">
        <button type="button" class="menu-bar__btn" data-action="open-tasks">Tasks</button>
      </div>
      <div class="menu-bar__item" data-menu="views">
        <button type="button" class="menu-bar__btn" data-action="toggle-menu-dropdown">Views</button>
        <div class="menu-bar__dropdown">
          <button type="button" class="menu-bar__dropdown-btn" data-action="toggle-left-sidebar"
                  aria-checked="${!appState.leftCollapsed}">
            <span class="menu-bar__check">✓</span><span>Left sidebar</span>
          </button>
          <button type="button" class="menu-bar__dropdown-btn" data-action="toggle-right-sidebar"
                  aria-checked="${!appState.rightCollapsed}">
            <span class="menu-bar__check">✓</span><span>Right sidebar</span>
          </button>
          <hr class="menu-bar__separator">
          <button type="button" class="menu-bar__dropdown-btn" aria-checked="false" data-action="set-theme" data-theme="light">
            <span class="menu-bar__check">✓</span><span>Light theme</span>
          </button>
          <button type="button" class="menu-bar__dropdown-btn" aria-checked="true" data-action="set-theme" data-theme="dark">
            <span class="menu-bar__check">✓</span><span>Dark theme</span>
          </button>
        </div>
      </div>
      <div class="menu-bar__item menu-bar__item--right" data-menu="help">
        <button type="button" class="menu-bar__btn">Help</button>
      </div>
    </nav>
  `;
}

/** Wires menu bar and hamburger handlers after render. */
function bindMenuHandlers(): void {
  const root = appRoot!;

  root.querySelector<HTMLButtonElement>('[data-action="toggle-menu"]')
    ?.addEventListener("click", toggleMenu);

  root.querySelector<HTMLButtonElement>('[data-action="open-tasks"]')
    ?.addEventListener("click", () => {
      appState.menuOpen = false;
      openTasksDialog();
    });

  root.querySelector<HTMLButtonElement>('[data-action="toggle-left-sidebar"]')
    ?.addEventListener("click", () => { toggleLeftSidebar(); });

  root.querySelector<HTMLButtonElement>('[data-action="toggle-right-sidebar"]')
    ?.addEventListener("click", () => { toggleRightSidebar(); });

  // Views dropdown toggle
  root.querySelector<HTMLButtonElement>('[data-action="toggle-menu-dropdown"]')
    ?.addEventListener("click", (e) => {
      e.stopPropagation();
      (e.currentTarget as HTMLElement).closest<HTMLElement>(".menu-bar__item")
        ?.classList.toggle("menu-bar__item--active");
    });

  // Theme buttons (visual only in prototype)
  root.querySelectorAll<HTMLButtonElement>('[data-action="set-theme"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      root.querySelectorAll<HTMLButtonElement>('[data-action="set-theme"]').forEach((b) =>
        b.setAttribute("aria-checked", String(b === btn))
      );
      btn.closest<HTMLElement>(".menu-bar__item")?.classList.remove("menu-bar__item--active");
    });
  });

  // Close dropdowns on outside click
  document.addEventListener("click", closeMenuDropdowns, { once: true });
}

/** Closes all open menu dropdowns. */
function closeMenuDropdowns(): void {
  appRoot.querySelectorAll(".menu-bar__item--active").forEach((el) =>
    el.classList.remove("menu-bar__item--active")
  );
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
  const editable = appState.isAdmin;
  const persistLabels = () => {
    void runTaskSave(
      () => persistTaskLabels(task),
      "Failed to save labels.",
      "tasks: save labels failed"
    );
  };

  const selectNode = (nodeId: string) => {
    task.selectedLabelId = nodeId;
    treeEl.querySelectorAll(".label-tree__row").forEach((row) => {
      row.classList.toggle("is-selected", (row as HTMLElement).dataset["nodeId"] === nodeId);
    });
  };

  const moveSelectedWithinParent = (delta: number) => {
    if (!task.selectedLabelId) return;
    const meta = findLabelNodeMeta(task.selectedLabelId, task.labels);
    if (!meta) return;
    const nextIdx = meta.index + delta;
    if (nextIdx < 0 || nextIdx >= meta.parentArr.length) return;
    meta.parentArr.splice(meta.index, 1);
    meta.parentArr.splice(nextIdx, 0, meta.node);
    refreshLabelTree(treeEl, task, task.selectedLabelId);
    persistLabels();
  };

  const promoteSelected = () => {
    if (!task.selectedLabelId) return;
    const meta = findLabelNodeMeta(task.selectedLabelId, task.labels);
    if (!meta || !meta.parentNode || !meta.grandParentArr) return;
    meta.parentArr.splice(meta.index, 1);
    const parentIdx = meta.grandParentArr.findIndex((n) => n.id === meta.parentNode!.id);
    meta.grandParentArr.splice(parentIdx + 1, 0, meta.node);
    refreshLabelTree(treeEl, task, task.selectedLabelId);
    persistLabels();
  };

  const demoteSelected = () => {
    if (!task.selectedLabelId) return;
    const meta = findLabelNodeMeta(task.selectedLabelId, task.labels);
    if (!meta || meta.index === 0) return;
    const prevSibling = meta.parentArr[meta.index - 1];
    meta.parentArr.splice(meta.index, 1);
    prevSibling.children.push(meta.node);
    refreshLabelTree(treeEl, task, task.selectedLabelId);
    persistLabels();
  };

  treeEl.querySelectorAll<HTMLElement>(".label-tree__row").forEach((row) => {
    row.addEventListener("click", () => selectNode(row.dataset["nodeId"]!));
    row.addEventListener("focus", () => selectNode(row.dataset["nodeId"]!));
    if (!editable) return;
    row.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Tab") {
        const rows = Array.from(treeEl.querySelectorAll<HTMLElement>(".label-tree__row"));
        if (!rows.length) return;
        ke.preventDefault();
        const idx = rows.indexOf(row);
        const step = ke.shiftKey ? -1 : 1;
        rows[(idx + step + rows.length) % rows.length].focus();
        return;
      }
      if (ke.key === "ArrowUp")   { ke.preventDefault(); moveSelectedWithinParent(-1); return; }
      if (ke.key === "ArrowDown") { ke.preventDefault(); moveSelectedWithinParent(1);  return; }
      if (ke.key === "ArrowLeft") { ke.preventDefault(); promoteSelected();            return; }
      if (ke.key === "ArrowRight"){ ke.preventDefault(); demoteSelected();             }
    });
  });

  treeEl.querySelectorAll<HTMLButtonElement>("[data-action='remove-label']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const removedId = btn.dataset["nodeId"]!;
      removeLabelNode(removedId, task.labels);
      if (task.selectedLabelId === removedId) task.selectedLabelId = null;
      refreshLabelTree(treeEl, task);
      persistLabels();
    });
  });

  const addInput = treeEl.querySelector<HTMLInputElement>(".label-tree__new");
  if (addInput) {
    addInput.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Enter") return;
      e.preventDefault();
      const val = addInput.value.trim();
      if (!val) return;
      const newId = labelNodeId();
      task.labels.push({ id: newId, text: val, children: [] });
      task.selectedLabelId = newId;
      refreshLabelTree(treeEl, task, newId);
      persistLabels();
    });
  }
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
        <div class="label-tree" data-task-id="${task.id}">
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
      <div class="tasks-dialog" role="dialog" aria-modal="true" aria-label="Tasks">
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

/** Wires all Tasks dialog handlers after render. */
function bindTasksDialogHandlers(): void {
  if (!appState.tasksDialogOpen) return;
  const root = appRoot!;

  // Close on backdrop click
  root.querySelector<HTMLElement>('[data-action="close-tasks-backdrop"]')
    ?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("tasks-backdrop")) closeTasksDialog();
    });
  root.querySelector<HTMLButtonElement>('[data-action="close-tasks"]')
    ?.addEventListener("click", closeTasksDialog);

  // Accordion toggle
  root.querySelectorAll<HTMLElement>('[data-action="toggle-task"]').forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-task-id")!;
      const task = appState.tasks.find((t) => t.id === id);
      if (!task) return;
      if (task.collapsed) {
        setExpandedTask(task);
      } else {
        task.collapsed = true;
      }
      render();
    });
  });

  // Task reorder
  root.querySelectorAll<HTMLButtonElement>('[data-action="move-task-up"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void moveTaskBy(btn.getAttribute("data-task-id")!, -1);
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-action="move-task-down"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void moveTaskBy(btn.getAttribute("data-task-id")!, 1);
    });
  });

  // Status dropdown
  root.querySelectorAll<HTMLSelectElement>('[data-action="set-status"]').forEach((sel) => {
    sel.addEventListener("change", () => {
      const id = sel.getAttribute("data-task-id")!;
      const task = appState.tasks.find((t) => t.id === id);
      if (!task) return;
      task.status = sel.value as Task["status"];
      const card = root.querySelector<HTMLElement>(`.task-card[data-task-id="${id}"]`);
      card?.querySelectorAll<HTMLElement>(".task-status-dot").forEach((dot) => {
        dot.style.background = taskStatusColor(task.status);
      });
      void runTaskSave(
        () => persistTaskScalars(task),
        "Failed to save task status.",
        "tasks: save status failed"
      );
    });
  });

  // Tag add on Enter
  root.querySelectorAll<HTMLInputElement>('[data-action="add-tag"]').forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Enter") return;
      const val = input.value.trim();
      if (!val) return;
      const id = input.getAttribute("data-task-id")!;
      const task = appState.tasks.find((t) => t.id === id);
      if (!task) return;
      task.tags.push(val);
      input.value = "";
      const card = root.querySelector<HTMLElement>(`.task-card[data-task-id="${id}"]`);
      if (card) {
        const wrap = card.querySelector<HTMLElement>(".task-tags-wrap");
        if (wrap) wrap.outerHTML = buildTagsWrapHtml(task);
        rebindTagsWrap(card, task);
        updateTaskSummaryTags(card, task);
      }
      void runTaskSave(
        () => persistTaskTags(task),
        "Failed to save task tags.",
        "tasks: save tags failed"
      );
    });
  });

  // Tag remove
  root.querySelectorAll<HTMLButtonElement>('[data-action="remove-tag"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-task-id")!;
      const tag = btn.getAttribute("data-tag")!;
      const task = appState.tasks.find((t) => t.id === id);
      if (!task) return;
      task.tags = task.tags.filter((t) => t !== tag);
      btn.closest(".task-pin")?.remove();
      const card = root.querySelector<HTMLElement>(`.task-card[data-task-id="${id}"]`);
      if (card) updateTaskSummaryTags(card, task);
      void runTaskSave(
        () => persistTaskTags(task),
        "Failed to save task tags.",
        "tasks: save tags failed"
      );
    });
  });

  // Text field dirty/saved feedback
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".task-field-input[data-field]").forEach((input) => {
    if ((input as HTMLInputElement).readOnly) return;
    input.addEventListener("input", () => {
      input.classList.add("task-field--dirty");
      input.classList.remove("task-field--saved");
    });
    const commit = (): void => {
      const id = input.getAttribute("data-task-id")!;
      const field = input.getAttribute("data-field") as keyof Pick<Task, "description" | "images" | "annotations" | "comment">;
      const task = appState.tasks.find((t) => t.id === id);
      if (task) task[field] = input.value;
      input.classList.remove("task-field--dirty");
      input.classList.add("task-field--saved");
      setTimeout(() => input.classList.remove("task-field--saved"), 1000);
      if (field === "description") {
        const card = root.querySelector<HTMLElement>(`.task-card[data-task-id="${id}"]`);
        if (card && task) updateTaskSummaryDesc(card, task);
      }
      if (task) {
        void runTaskSave(
          () => persistTaskScalars(task),
          "Failed to save task field.",
          "tasks: save field failed"
        );
      }
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter" && (input as HTMLElement).tagName !== "TEXTAREA") commit();
    });
  });

  // Checkmark
  root.querySelectorAll<HTMLInputElement>('[data-action="set-checkmark"]').forEach((chk) => {
    chk.addEventListener("change", () => {
      const id = chk.getAttribute("data-task-id")!;
      const task = appState.tasks.find((t) => t.id === id);
      if (!task) return;
      task.checkmark = chk.checked;
      void runTaskSave(
        () => persistTaskScalars(task),
        "Failed to save task checkmark.",
        "tasks: save checkmark failed"
      );
    });
  });

  // Delete task
  root.querySelectorAll<HTMLButtonElement>('[data-action="delete-task"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      void removeTask(btn.getAttribute("data-task-id")!);
    });
  });

  // Add task
  root.querySelector<HTMLButtonElement>('[data-action="add-task"]')
    ?.addEventListener("click", () => {
      void addTask();
    });

  // Browse directory buttons for images/annotations path fields.
  root.querySelectorAll<HTMLButtonElement>(".task-browse-btn").forEach((btn) => {
    const input = btn.closest(".task-path-row")?.querySelector<HTMLInputElement>(".task-field-input");
    if (!input) return;
    btn.addEventListener("click", () => {
      openDirBrowser(input.value || "/", (path) => {
        input.value = path;
        input.dispatchEvent(new Event("blur"));
      });
    });
  });

  // Label trees
  root.querySelectorAll<HTMLElement>(".label-tree[data-task-id]").forEach((treeEl) => {
    const taskId = treeEl.dataset["taskId"]!;
    const task = appState.tasks.find((t) => t.id === taskId);
    if (task) bindLabelTree(treeEl, task);
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
  card.querySelector<HTMLInputElement>('[data-action="add-tag"]')
    ?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const input = e.currentTarget as HTMLInputElement;
      const val = input.value.trim();
      if (!val) return;
      task.tags.push(val);
      input.value = "";
      const wrap = card.querySelector<HTMLElement>(".task-tags-wrap");
      if (wrap) wrap.outerHTML = buildTagsWrapHtml(task);
      rebindTagsWrap(card, task);
      updateTaskSummaryTags(card, task);
      void runTaskSave(
        () => persistTaskTags(task),
        "Failed to save task tags.",
        "tasks: save tags failed"
      );
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

/** Renders the prototype UI and rebinds event handlers. */
function render(): void {
  appRoot.innerHTML = `
    <div class="layout ${appState.leftCollapsed ? "left-collapsed" : ""} ${
      appState.rightCollapsed ? "right-collapsed" : ""
    }">
      <aside class="sidebar sidebar--left">
        <div class="sidebar__header">
          <strong>Navigator</strong>
          <button type="button" class="ghost" data-action="toggle-left">${
            appState.leftCollapsed ? ">" : "<"
          }</button>
        </div>
        <div class="sidebar__content">
          <button type="button" data-action="previous">previous</button>
          <button type="button" data-action="next">next</button>
          <div class="meta">Image: ${getCurrentImageName()}</div>
        </div>
      </aside>

      <main class="image-view">
        <div class="image-view__toolbar">
          <strong>Image View</strong>
          <span>Click canvas to add point annotation</span>
        </div>
        <div class="image-view__canvas-wrap">
          <canvas class="image-view__canvas" aria-label="Tile image viewer"></canvas>
        </div>
      </main>

      <aside class="sidebar sidebar--right">
        <div class="sidebar__header">
          <button type="button" class="ghost" data-action="toggle-right">${
            appState.rightCollapsed ? "<" : ">"
          }</button>
          <strong>Controls</strong>
        </div>
        <div class="sidebar__content panels">
          ${renderPanel("optics", "optics", renderOpticsBody())}
          ${renderPanel("masks", "masks", '<div class="muted">Prototype placeholder</div>')}
          ${renderPanel("labels", "labels", '<div class="muted">Prototype placeholder</div>')}
          ${renderPanel(
            "annotations",
            "annotations",
            `${renderAnnotationList()}<button type="button" data-action="clear-annotations">clear annotations</button>`
          )}
          ${renderPanel(
            "commentAnnotation",
            "comment/annotation",
            '<textarea rows="3" placeholder="Annotation comment"></textarea>'
          )}
          ${renderPanel(
            "commentPicture",
            "comment/picture",
            '<textarea rows="3" placeholder="Image comment"></textarea>'
          )}
        </div>
      </aside>
    </div>
    ${renderMenuBar()}
    ${renderTasksDialog()}
    ${renderDirBrowserOverlay()}
  `;

  const previousBtn = appRoot.querySelector<HTMLButtonElement>('button[data-action="previous"]');
  const nextBtn = appRoot.querySelector<HTMLButtonElement>('button[data-action="next"]');
  const toggleLeftBtn = appRoot.querySelector<HTMLButtonElement>('button[data-action="toggle-left"]');
  const toggleRightBtn = appRoot.querySelector<HTMLButtonElement>('button[data-action="toggle-right"]');
  const panelToggles = appRoot.querySelectorAll<HTMLButtonElement>('button[data-action="toggle-panel"]');

  previousBtn?.addEventListener("click", goPreviousImage);
  nextBtn?.addEventListener("click", goNextImage);
  toggleLeftBtn?.addEventListener("click", toggleLeftSidebar);
  toggleRightBtn?.addEventListener("click", toggleRightSidebar);

  panelToggles.forEach((btn) => {
    btn.addEventListener("click", () => {
      const panelName = btn.getAttribute("data-panel") as keyof typeof appState.panelCollapsed;
      togglePanel(panelName);
    });
  });

  bindAnnotationPanelHandlers();
  bindOpticsPanelHandlers();
  bindMenuHandlers();
  bindTasksDialogHandlers();
  bindDirBrowserHandlers();
  mountViewer();
}

render();
