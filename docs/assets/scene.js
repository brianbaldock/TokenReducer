const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js";

function sceneError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export async function createScene({ mount, signal, onFailure, onPhaseChange = () => {} }) {
  if (signal?.aborted) throw sceneError("aborted", "Scene creation was canceled.");
  if (!("WebGL2RenderingContext" in window)) {
    throw sceneError("webgl", "WebGL 2 is unavailable.");
  }
  let THREE;
  try {
    THREE = await import(THREE_URL);
  } catch (cause) {
    throw sceneError("cdn", "The pinned Three.js module could not load.", cause);
  }
  if (signal?.aborted) throw sceneError("aborted", "Scene creation was canceled.");

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: false, antialias: true, powerPreference: "low-power" });
  } catch (cause) {
    throw sceneError("webgl", "A WebGL 2 renderer could not be created.", cause);
  }

  const world = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-12, 12, 6, -6, 0.1, 90);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let disposed = false;
  let frame = null;
  let moving = false;
  let inViewport = true;
  let elapsed = 10.6;
  let previousTime = 0;
  let lastPhase = -1;
  let viewStep = 0;
  let resizeObserver;
  let intersectionObserver;
  let draw;

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    document.removeEventListener("visibilitychange", schedule);
    reducedMotion.removeEventListener("change", preferenceChanged);
    window.removeEventListener("resize", resize);
    renderer.domElement.removeEventListener("webglcontextlost", contextLost);
    const geometries = new Set();
    const materials = new Set();
    world.traverse((object) => {
      if (object.isInstancedMesh) object.dispose();
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    renderer.forceContextLoss();
  }

  function fail(error) {
    if (disposed) return;
    dispose();
    onFailure(error);
  }

  function contextLost(event) {
    event.preventDefault();
    fail(sceneError("context-lost", "The WebGL context was lost."));
  }

  function mayAnimate() {
    return moving && inViewport && !document.hidden && !reducedMotion.matches && !disposed;
  }

  function schedule() {
    if (disposed) return;
    if (!mayAnimate() && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    } else if (mayAnimate() && frame === null) {
      previousTime = performance.now();
      frame = requestAnimationFrame(tick);
    }
  }

  function preferenceChanged() {
    if (reducedMotion.matches) moving = false;
    schedule();
  }

  function renderFrame() {
    if (disposed) return false;
    try {
      draw();
      return true;
    } catch (cause) {
      fail(sceneError("render", "The WebGL render failed.", cause));
      return false;
    }
  }

  function tick(now) {
    frame = null;
    if (!mayAnimate()) return;
    elapsed += Math.min((now - previousTime) / 1000, 0.05);
    previousTime = now;
    if (!renderFrame()) return;
    if (mayAnimate()) frame = requestAnimationFrame(tick);
  }

  function updateCameraPosition() {
    const yaw = -0.16 + viewStep * 0.16;
    camera.position.set(24 * Math.sin(yaw), 6.1, 24 * Math.cos(yaw));
    camera.lookAt(0, 0.7, 0);
  }

  function resize() {
    if (disposed) return;
    const width = Math.max(mount.clientWidth, 1);
    const height = Math.max(mount.clientHeight, 1);
    const aspect = width / height;
    const halfHeight = Math.max(6.6, 10.6 / aspect);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
    updateCameraPosition();
    renderer.setSize(width, height, false);
    renderFrame();
  }

  try {
    world.background = new THREE.Color(0x080a10);
    world.fog = new THREE.FogExp2(0x080a10, 0.009);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.domElement.setAttribute("aria-hidden", "true");
    const ambient = new THREE.AmbientLight(0xbad9f2, 1.7);
    const cyanLight = new THREE.DirectionalLight(0xc9f6ff, 2.8);
    cyanLight.position.set(-8, 12, 11);
    const amberLight = new THREE.DirectionalLight(0xffc27f, 1.4);
    amberLight.position.set(10, 5, -8);
    world.add(ambient, cyanLight, amberLight);
    const grid = new THREE.GridHelper(40, 36, 0x2b4366, 0x152138);
    grid.position.y = -3.7;
    grid.material.transparent = true;
    grid.material.opacity = 0.65;
    world.add(grid);

    function ring(radius, color, opacity) {
      return new THREE.Mesh(
        new THREE.TorusGeometry(radius, 0.022, 6, 64),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity }),
      );
    }

    const parentNode = new THREE.Group();
    parentNode.name = "parent-context";
    parentNode.position.set(-6.3, 0, 0);
    world.add(parentNode);
    const parentCore = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.55, 1),
      new THREE.MeshStandardMaterial({
        color: 0x00d8f4,
        emissive: 0x00495f,
        roughness: 0.34,
        metalness: 0.55,
      }),
    );
    const parentShell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.02, 1),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, wireframe: true, transparent: true, opacity: 0.3 }),
    );
    parentNode.add(parentCore, parentShell);
    const parentRings = [];
    for (let index = 0; index < 3; index += 1) {
      const orbit = ring(2.45 + index * 0.34, index === 0 ? 0x00e5ff : 0x35849a, 0.65 - index * 0.12);
      orbit.rotation.x = Math.PI / (2 + index);
      orbit.rotation.y = index * Math.PI / 4;
      parentNode.add(orbit);
      parentRings.push(orbit);
    }

    const gate = new THREE.Group();
    gate.name = "read-gate";
    gate.position.set(-1.65, -0.1, 0);
    const gatePlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1.2, 6.6, 3, 14),
      new THREE.MeshBasicMaterial({
        color: 0xf59e0b,
        wireframe: true,
        transparent: true,
        opacity: 0.38,
        side: THREE.DoubleSide,
      }),
    );
    gate.add(gatePlane);
    for (const x of [-0.65, 0.65]) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 6.8, 6),
        new THREE.MeshBasicMaterial({ color: 0xa46b20 }),
      );
      post.position.x = x;
      gate.add(post);
    }
    world.add(gate);

    const workerNode = new THREE.Group();
    workerNode.name = "worker-context";
    workerNode.position.set(5.15, -0.55, 0);
    world.add(workerNode);
    const chassis = new THREE.Mesh(
      new THREE.BoxGeometry(3.85, 3.85, 3.85),
      new THREE.MeshBasicMaterial({ color: 0x538f7b, wireframe: true, transparent: true, opacity: 0.5 }),
    );
    const workerCore = new THREE.Mesh(
      new THREE.OctahedronGeometry(1.23, 0),
      new THREE.MeshStandardMaterial({ color: 0x10b981, emissive: 0x03442c, metalness: 0.5, roughness: 0.28 }),
    );
    workerNode.add(chassis, workerCore);
    const workerRings = [];
    for (let index = 0; index < 2; index += 1) {
      const orbit = ring(2.3 + index * 0.35, 0x40d6a0, 0.5);
      orbit.rotation.x = Math.PI / 3 * (index + 1);
      workerNode.add(orbit);
      workerRings.push(orbit);
    }

    const sourceNode = new THREE.Group();
    sourceNode.name = "source-corpus";
    sourceNode.position.set(6.7, 4.25, -0.2);
    sourceNode.rotation.y = -0.15;
    world.add(sourceNode);
    const sourceMaterial = new THREE.MeshStandardMaterial({
      color: 0xf5ac32,
      emissive: 0x4a2700,
      roughness: 0.5,
      metalness: 0.12,
    });
    for (let index = 0; index < 5; index += 1) {
      const sheet = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.11, 1.2), sourceMaterial);
      sheet.position.y = index * 0.2;
      sheet.rotation.y = index * 0.055;
      sourceNode.add(sheet);
    }

    // Both source endpoints and control points stay on the worker side of the gate.
    const sourcePath = new THREE.CubicBezierCurve3(
      new THREE.Vector3(6.7, 4.1, -0.15),
      new THREE.Vector3(2.3, 3.4, 0.5),
      new THREE.Vector3(2.25, 0.9, 0.8),
      new THREE.Vector3(5.15, -0.55, 0),
    );
    const returnPath = new THREE.CubicBezierCurve3(
      new THREE.Vector3(5.15, -0.35, 0),
      new THREE.Vector3(1.9, 4.8, -1.0),
      new THREE.Vector3(-3.1, 4.2, -0.8),
      new THREE.Vector3(-6.3, 0.25, 0),
    );
    for (const [curve, color] of [[sourcePath, 0xf59e0b], [returnPath, 0xc084fc]]) {
      const track = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(curve.getPoints(60)),
        new THREE.LineDashedMaterial({ color, dashSize: 0.17, gapSize: 0.15, transparent: true, opacity: 0.6 }),
      );
      track.computeLineDistances();
      world.add(track);
    }

    const inputCount = 42;
    const corpusParticles = new THREE.InstancedMesh(new THREE.BoxGeometry(0.13, 0.13, 0.13), sourceMaterial, inputCount);
    corpusParticles.name = "source-stream";
    corpusParticles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    corpusParticles.frustumCulled = false;
    world.add(corpusParticles);
    const swirlCount = 16;
    const workerSwirl = new THREE.InstancedMesh(
      new THREE.TetrahedronGeometry(0.105, 0),
      new THREE.MeshBasicMaterial({ color: 0x74eac0, transparent: true, opacity: 0.6 }),
      swirlCount,
    );
    workerSwirl.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    workerSwirl.frustumCulled = false;
    workerNode.add(workerSwirl);
    const compactAnswer = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.23, 0),
      new THREE.MeshStandardMaterial({ color: 0xcda0ff, emissive: 0x5a217a, metalness: 0.4, roughness: 0.3 }),
    );
    compactAnswer.name = "compact-return";
    world.add(compactAnswer);
    const transform = new THREE.Object3D();
    const point = new THREE.Vector3();

    draw = () => {
      if (disposed) return;
      const phase = (elapsed % 12) / 12;
      const stage = phase < 0.38 ? 0 : phase < 0.68 ? 1 : 2;
      parentCore.rotation.set(elapsed * 0.025, elapsed * 0.055, 0);
      parentShell.rotation.y = -elapsed * 0.025;
      parentRings.forEach((orbit, index) => {
        orbit.rotation.z = elapsed * 0.045 * (index % 2 ? -1 : 1);
      });
      workerCore.rotation.set(elapsed * 0.14, elapsed * 0.25, 0);
      chassis.rotation.y = Math.sin(elapsed * 0.17) * 0.15;
      workerRings.forEach((orbit, index) => {
        orbit.rotation.z = elapsed * 0.1 * (index ? -1 : 1);
      });
      gatePlane.material.opacity = stage === 0 ? 0.5 : 0.3;
      workerCore.material.emissiveIntensity = stage === 1 ? 1.7 : 0.8;
      parentCore.material.emissiveIntensity = stage === 2 ? 1.7 : 0.8;
      corpusParticles.visible = phase < 0.46;
      if (corpusParticles.visible) {
        for (let index = 0; index < inputCount; index += 1) {
          sourcePath.getPointAt((index / inputCount + elapsed * 0.18) % 1, point);
          transform.position.copy(point);
          transform.position.y += (index % 5 - 2) * 0.065;
          transform.position.z += (index % 7 - 3) * 0.055;
          transform.rotation.set(elapsed * 0.4 + index, elapsed * 0.25, 0);
          transform.updateMatrix();
          corpusParticles.setMatrixAt(index, transform.matrix);
        }
        corpusParticles.instanceMatrix.needsUpdate = true;
      }
      for (let index = 0; index < swirlCount; index += 1) {
        const angle = elapsed * (0.65 + index * 0.012) + index * 0.65;
        const radius = 1.35 + index % 3 * 0.08;
        transform.position.set(Math.cos(angle) * radius, (index % 5 - 2) * 0.42, Math.sin(angle) * radius);
        transform.rotation.set(0, angle, angle * 0.2);
        transform.updateMatrix();
        workerSwirl.setMatrixAt(index, transform.matrix);
      }
      workerSwirl.instanceMatrix.needsUpdate = true;
      const returnProgress = (phase - 0.68) / 0.3;
      compactAnswer.visible = returnProgress >= 0 && returnProgress <= 1;
      if (compactAnswer.visible) {
        returnPath.getPointAt(returnProgress, compactAnswer.position);
        compactAnswer.rotation.set(elapsed * 0.3, elapsed * 0.4, 0.2);
      }
      renderer.render(world, camera);
      if (!disposed && lastPhase !== stage) {
        lastPhase = stage;
        onPhaseChange(stage);
      }
    };

    renderer.domElement.addEventListener("webglcontextlost", contextLost, false);
    mount.append(renderer.domElement);
    resize();
    if (disposed) throw sceneError("render", "Scene creation stopped before the initial render.");
    const gl = renderer.getContext();
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) {
      throw sceneError("render", "The first WebGL frame failed its render check.");
    }
    if ("ResizeObserver" in window) {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(mount);
    } else {
      window.addEventListener("resize", resize);
    }
    if ("IntersectionObserver" in window) {
      intersectionObserver = new IntersectionObserver(([entry]) => {
        inViewport = entry.isIntersecting;
        schedule();
      }, { rootMargin: "40px" });
      intersectionObserver.observe(mount);
    }
    document.addEventListener("visibilitychange", schedule);
    reducedMotion.addEventListener("change", preferenceChanged);
  } catch (cause) {
    dispose();
    if (cause?.code) throw cause;
    throw sceneError("render", "The scene could not be initialized.", cause);
  }

  return {
    setMotion(enabled) {
      if (disposed) return;
      moving = Boolean(enabled) && !reducedMotion.matches;
      schedule();
    },
    inspect(stage) {
      if (disposed || !Number.isInteger(stage) || stage < 0 || stage > 2) return;
      moving = false;
      elapsed = [2.4, 6.1, 10.6][stage];
      schedule();
      renderFrame();
    },
    changeView(direction) {
      if (disposed || ![-1, 0, 1].includes(direction)) return;
      viewStep = direction === 0 ? 0 : Math.max(-2, Math.min(2, viewStep + direction));
      updateCameraPosition();
      renderFrame();
    },
    dispose,
  };
}
