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

/** Last-seen state per item key; used by traceState to suppress duplicate log entries. */
const _traceStateCache = new Map<string, string>();

/**
 * Logs {type:"trace_state", item, state} only when the state value differs
 * from the previously recorded value for that item.
 */
function traceState(item: string, state: string): void {
  if (_traceStateCache.get(item) === state) {
    return;
  }
  _traceStateCache.set(item, state);
  logEvent("trace_state", { item, state });
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
};

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
const appRoot = document.querySelector<HTMLDivElement>("#app");
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
  /** Pointer X at drag start, used to detect the first move event. */
  private dragStartX = 0;
  /** Pointer Y at drag start, used to detect the first move event. */
  private dragStartY = 0;
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
      void main() {
        gl_FragColor = texture2D(u_tex, v_uv);
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
    if (!tileSampler) {
      throw new Error("Tile sampler uniform missing");
    }
    this.tileSamplerUniform = tileSampler;

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
      const dims = getLevelDimensions(this.manifest, 0);
      this.logTilePlaced(0, this.level0Tile, dims.width, dims.height);
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

    for (let ty = 0; ty < rows; ty += 1) {
      for (let tx = 0; tx < cols; tx += 1) {
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
            this.logTilePlaced(level, tile, dims.width, dims.height);
            this.draw();
          })
          .catch((error) => {
            console.error("tile viewer: fit tile load failed", { level, tx, ty, error });
          });
      }
    }
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
    traceState("pan_zoom", `${this.zoom},${this.offsetX},${this.offsetY}`);
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

  /** Logs tile upload+placement coordinates for jump/flicker diagnostics. */
  private logTilePlaced(
    level: number,
    tile: Pick<LoadedTile, "tx" | "ty" | "width" | "height">,
    levelWidth: number,
    levelHeight: number
  ): void {
    this.computeTransform();
    const placement = this.getTilePlacementRect(tile, levelWidth, levelHeight);
    logEvent("tile_placed", {
      level,
      tx: tile.tx,
      ty: tile.ty,
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
    });
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
    logEvent("wheel", {
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
    });
    this.draw();
    this.maybeChangeFitLevel();
  };

  /** Starts drag-pan tracking on primary-pointer down. */
  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.animationId !== null) {
      return;
    }
    logEvent("pointer", { action: "down", button: event.button, x: event.clientX, y: event.clientY });
    this.isDragging = true;
    this.dragLastX = event.clientX;
    this.dragLastY = event.clientY;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
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
    if (this.dragLastX === this.dragStartX && this.dragLastY === this.dragStartY) {
      logEvent("pointer", { action: "move_first", x: event.clientX, y: event.clientY });
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
  };

  /** Ends drag-pan and refreshes level selection if needed. */
  private readonly handlePointerUp = (event: PointerEvent): void => {
    logEvent("pointer", { action: "up", button: event.button, x: event.clientX, y: event.clientY });
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

  void viewer.setImage(toImageStem(getCurrentImageName()));
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
          ${renderPanel("optics", "optics", '<div class="muted">Prototype placeholder</div>')}
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
  mountViewer();
}

render();
