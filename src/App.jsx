import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const PAPERS_URL = 'http://localhost:3000/papers';
const FIELD_OPTIONS = [
  'physics',
  'mathematics',
  'computer science',
  'neuroscience',
  'economics',
  'philosophy'
];
const FIELD_STAR_COLORS = Object.freeze({
  physics: 0x5da9e9,
  mathematics: 0x72d6c9,
  'computer science': 0x6bcb77,
  neuroscience: 0xf4a261,
  economics: 0x2a9d8f,
  philosophy: 0x9d4edd
});
const MIN_STAR_SIZE = 0.5;
const MAX_STAR_SIZE = 6;
const DEPTH_STEP = 200;
const CAMERA_TRANSITION_MS = 800;
const CAMERA_LAYER_OFFSET = 120;
const REFERENCE_LIMIT = 35;
const BLOOM_STRENGTH = 0.36;
const BLOOM_RADIUS = 0.28;
const BLOOM_THRESHOLD = 0.2;
const LAYER_FADE_MS = 420;
const PRE_ZOOM_MS = 220;

function getFieldStarColor(field) {
  return new THREE.Color(FIELD_STAR_COLORS[field] ?? FIELD_STAR_COLORS.physics);
}

function easeInOutCubic(value) {
  if (value < 0.5) {
    return 4 * value * value * value;
  }

  return 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function normalizeWorkToPaper(work) {
  const citedByCount = Number.isFinite(work?.cited_by_count) ? work.cited_by_count : 0;
  const doi = typeof work?.doi === 'string'
    ? work.doi.replace(/^https?:\/\/doi\.org\//i, '').trim() || null
    : null;

  return {
    title: work?.display_name || 'Untitled',
    authors: Array.isArray(work?.authorships)
      ? work.authorships
        .map((authorship) => authorship?.author?.display_name)
        .filter(Boolean)
        .slice(0, 3)
      : [],
    publication_year: work?.publication_year || null,
    cited_by_count: citedByCount,
    doi,
    primary_topic: work?.primary_topic?.display_name
      || (Array.isArray(work?.concepts) ? work.concepts[0]?.display_name || null : null),
    size: Number(Math.log10(citedByCount + 1).toFixed(4))
  };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getPaperExternalUrl(paper) {
  if (paper?.doi) {
    return `https://doi.org/${paper.doi}`;
  }

  if (typeof paper?.url === 'string' && paper.url.trim().length > 0) {
    return paper.url.trim();
  }

  return null;
}

export default function App() {
  const mountRef = useRef(null);
  const [selectedField, setSelectedField] = useState('physics');
  const [currentDepth, setCurrentDepth] = useState(0);
  const [navigationStackSize, setNavigationStackSize] = useState(0);
  const [status, setStatus] = useState({ loading: true, error: null });
  const [selectedPaper, setSelectedPaper] = useState(null);
  const currentDepthRef = useRef(0);
  const navigationStackRef = useRef([]);
  const backActionRef = useRef(() => {});
  const exploreActionRef = useRef(() => {});
  const [tooltip, setTooltip] = useState({
    visible: false,
    x: 0,
    y: 0,
    title: '',
    year: null,
    citations: 0
  });

  useEffect(() => {
    let mounted = true;
    let animationFrameId = null;
    const mountEl = mountRef.current;

    if (!mountEl) {
      return undefined;
    }

    setStatus({ loading: true, error: null });
    setCurrentDepth(0);
    currentDepthRef.current = 0;
    navigationStackRef.current = [];
    setNavigationStackSize(0);
    setSelectedPaper(null);
    setTooltip((current) => (current.visible ? { ...current, visible: false } : current));

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    const camera = new THREE.PerspectiveCamera(
      60,
      mountEl.clientWidth / mountEl.clientHeight,
      0.1,
      2000
    );
    camera.position.set(0, 0, 170);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mountEl.clientWidth, mountEl.clientHeight);
    mountEl.appendChild(renderer.domElement);

    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(mountEl.clientWidth, mountEl.clientHeight),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD
    );
    composer.addPass(renderPass);
    composer.addPass(bloomPass);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 40;
    controls.maxDistance = 500;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    const directionalLight = new THREE.DirectionalLight(0x9fc7ff, 0.9);
    directionalLight.position.set(30, 40, 60);
    scene.add(ambientLight, directionalLight);

    const stars = [];
    const galaxyLayers = [];
    const opacityTransitions = [];
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let selectedStar = null;
    let isDrilling = false;
    let isTransitioning = false;
    const cameraTransition = {
      active: false,
      startMs: 0,
      durationMs: CAMERA_TRANSITION_MS,
      fromCameraZ: camera.position.z,
      toCameraZ: camera.position.z,
      fromTargetZ: controls.target.z,
      toTargetZ: controls.target.z
    };

    const startCameraTransition = (toCameraZ, toTargetZ, durationMs = CAMERA_TRANSITION_MS) => {
      cameraTransition.active = true;
      cameraTransition.startMs = performance.now();
      cameraTransition.durationMs = durationMs;
      cameraTransition.fromCameraZ = camera.position.z;
      cameraTransition.toCameraZ = toCameraZ;
      cameraTransition.fromTargetZ = controls.target.z;
      cameraTransition.toTargetZ = toTargetZ;
    };

    const updateCameraTransition = (nowMs) => {
      if (!cameraTransition.active) {
        return;
      }

      const elapsed = nowMs - cameraTransition.startMs;
      const progress = THREE.MathUtils.clamp(elapsed / cameraTransition.durationMs, 0, 1);
      const eased = easeInOutCubic(progress);

      camera.position.z = THREE.MathUtils.lerp(
        cameraTransition.fromCameraZ,
        cameraTransition.toCameraZ,
        eased
      );
      controls.target.z = THREE.MathUtils.lerp(
        cameraTransition.fromTargetZ,
        cameraTransition.toTargetZ,
        eased
      );

      if (progress >= 1) {
        cameraTransition.active = false;
      }
    };

    const queueLayerOpacityTransition = (layer, toOpacity, durationMs = LAYER_FADE_MS) => {
      if (!layer || !Array.isArray(layer.stars) || layer.stars.length === 0) {
        return;
      }

      opacityTransitions.push({
        stars: layer.stars,
        fromOpacities: layer.stars.map((star) => star.material.opacity),
        toOpacity: THREE.MathUtils.clamp(toOpacity, 0, 1),
        startMs: performance.now(),
        durationMs
      });
    };

    const updateOpacityTransitions = (nowMs) => {
      for (let index = opacityTransitions.length - 1; index >= 0; index -= 1) {
        const transition = opacityTransitions[index];
        const progress = THREE.MathUtils.clamp(
          (nowMs - transition.startMs) / transition.durationMs,
          0,
          1
        );
        const eased = easeInOutCubic(progress);

        transition.stars.forEach((star, starIndex) => {
          const fromOpacity = transition.fromOpacities[starIndex];
          star.material.opacity = THREE.MathUtils.lerp(fromOpacity, transition.toOpacity, eased);
        });

        if (progress >= 1) {
          opacityTransitions.splice(index, 1);
        }
      }
    };

    const resetStarAppearance = (star) => {
      if (!star) {
        return;
      }

      const material = star.material;
      material.color.copy(star.userData.baseColor);
      material.emissive.copy(star.userData.baseColor);
      material.emissiveIntensity = star.userData.baseEmissiveIntensity;
    };

    const applyStarSelection = (star) => {
      if (selectedStar === star) {
        if (mounted) {
          setSelectedPaper(star.userData.paper);
        }
        return;
      }

      resetStarAppearance(selectedStar);
      selectedStar = star;

      const material = star.material;
      material.emissive.set(0xb8d9ff);
      material.emissiveIntensity = star.userData.baseEmissiveIntensity + 0.6;

      if (mounted) {
        setSelectedPaper(star.userData.paper);
      }
    };

    const clearSelection = () => {
      resetStarAppearance(selectedStar);
      selectedStar = null;
      if (mounted) {
        setSelectedPaper(null);
      }
    };

    const getIntersections = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(stars, false);
    };

    const onPointerMove = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointer, camera);
      const intersections = raycaster.intersectObjects(stars, false);

      if (intersections.length > 0) {
        const hitPaper = intersections[0].object.userData.paper;
        renderer.domElement.style.cursor = 'pointer';
        setTooltip({
          visible: true,
          x: event.clientX - rect.left + 12,
          y: event.clientY - rect.top + 12,
          title: hitPaper.title,
          year: hitPaper.publication_year,
          citations: hitPaper.cited_by_count
        });
      } else {
        renderer.domElement.style.cursor = 'grab';
        setTooltip((current) => (current.visible ? { ...current, visible: false } : current));
      }
    };

    const createGalaxyLayer = (papers, depth, options = {}) => {
      const { paperId = null, initialOpacity = 1 } = options;
      const paperLogs = papers
        .map((paper) => Number(paper?.size))
        .filter((value) => Number.isFinite(value));
      const citationValues = papers
        .map((paper) => Number(paper?.cited_by_count))
        .filter((value) => Number.isFinite(value));
      const minLog = paperLogs.length > 0 ? Math.min(...paperLogs) : 0;
      const maxLog = paperLogs.length > 0 ? Math.max(...paperLogs) : 0;
      const logRange = maxLog - minLog;
      const minCitation = citationValues.length > 0 ? Math.min(...citationValues) : 0;
      const maxCitation = citationValues.length > 0 ? Math.max(...citationValues) : 0;
      const citationRange = maxCitation - minCitation;
      const maxRadius = 50;
      const minRadius = 5;
      const layerIndex = Math.abs(depth) / DEPTH_STEP;
      const spreadScale = Math.pow(0.85, layerIndex);
      const sizeScale = 1 + Math.min(layerIndex * 0.06, 0.5);
      const layerStars = [];
      const generatedStars = [];

      papers.forEach((paper) => {
        const paperLog = Number(paper?.size);
        const safeLog = Number.isFinite(paperLog) ? paperLog : minLog;
        const normalized = logRange > 0 ? (safeLog - minLog) / logRange : 0.5;
        const clampedNormalized = THREE.MathUtils.clamp(normalized, 0, 1);
        const radius = THREE.MathUtils.clamp(
          MIN_STAR_SIZE + clampedNormalized * (MAX_STAR_SIZE - MIN_STAR_SIZE),
          MIN_STAR_SIZE,
          MAX_STAR_SIZE
        ) * sizeScale;

        const paperCitation = Number(paper?.cited_by_count);
        const safeCitation = Number.isFinite(paperCitation) ? paperCitation : minCitation;
        const citationNormalized =
          citationRange > 0 ? (safeCitation - minCitation) / citationRange : 0.5;
        const clampedCitation = THREE.MathUtils.clamp(citationNormalized, 0, 1);
        const orbitalRadius = maxRadius - clampedCitation * (maxRadius - minRadius);
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(THREE.MathUtils.randFloatSpread(2));
        const sinPhi = Math.sin(phi);
        const x = orbitalRadius * sinPhi * Math.cos(theta) * spreadScale;
        const y = orbitalRadius * Math.cos(phi) * spreadScale;
        const z = orbitalRadius * sinPhi * Math.sin(theta) + depth;

        const geometry = new THREE.SphereGeometry(radius, 12, 12);
        const baseColor = getFieldStarColor(selectedField);
        const emissiveBase = THREE.MathUtils.lerp(1.3, 2.05, clampedNormalized);
        const emissiveIntensity = THREE.MathUtils.clamp(
          emissiveBase + Math.min(layerIndex * 0.08, 0.45),
          1.2,
          2.4
        );
        const material = new THREE.MeshStandardMaterial({
          color: baseColor,
          emissive: baseColor,
          emissiveIntensity,
          toneMapped: false,
          transparent: true,
          opacity: initialOpacity
        });

        const star = new THREE.Mesh(geometry, material);
        star.position.set(x, y, z);
        star.userData.paper = paper;
        star.userData.radius = radius;
        star.userData.baseColor = baseColor.clone();
        star.userData.baseEmissiveIntensity = material.emissiveIntensity;

        stars.push(star);
        layerStars.push(star);
        generatedStars.push({
          x,
          y,
          z,
          radius
        });
        scene.add(star);
      });

      const layer = {
        paperId,
        depth,
        depthLevel: Math.abs(depth / DEPTH_STEP),
        stars: layerStars,
        generatedStars
      };
      galaxyLayers.push(layer);
      return layer;
    };

    const removeGalaxyLayer = (layer) => {
      if (!layer || !Array.isArray(layer.stars)) {
        return;
      }

      layer.stars.forEach((star) => {
        const starIndex = stars.indexOf(star);
        if (starIndex >= 0) {
          stars.splice(starIndex, 1);
        }

        scene.remove(star);
        star.geometry.dispose();
        star.material.dispose();
      });
    };

    const snapshotCurrentState = (paperId) => {
      const activeLayer = galaxyLayers[galaxyLayers.length - 1];

      return {
        paperId: paperId || activeLayer?.paperId || null,
        depth: currentDepthRef.current,
        depthLevel: Math.abs(currentDepthRef.current / DEPTH_STEP),
        cameraPosition: camera.position.clone(),
        cameraTarget: controls.target.clone(),
        starPositions: activeLayer
          ? activeLayer.generatedStars.map((starData) => ({ ...starData }))
          : []
      };
    };

    const fetchReferencePapers = async (paper) => {
      if (!paper?.doi) {
        return [];
      }

      const workLookupUrl = new URL('https://api.openalex.org/works');
      workLookupUrl.searchParams.set('filter', `doi:${paper.doi}`);
      workLookupUrl.searchParams.set('per-page', '1');
      workLookupUrl.searchParams.set('select', 'id,referenced_works');

      const workLookupResponse = await fetch(workLookupUrl.toString());
      if (!workLookupResponse.ok) {
        throw new Error('Failed to resolve selected paper references');
      }

      const workLookupPayload = await workLookupResponse.json();
      const sourceWork = Array.isArray(workLookupPayload?.results)
        ? workLookupPayload.results[0]
        : null;

      const referenceIds = Array.isArray(sourceWork?.referenced_works)
        ? sourceWork.referenced_works
          .map((referenceUrl) => {
            if (typeof referenceUrl !== 'string') {
              return null;
            }

            const match = referenceUrl.match(/W\d+$/i);
            return match ? match[0] : null;
          })
          .filter(Boolean)
          .slice(0, REFERENCE_LIMIT)
        : [];

      if (referenceIds.length === 0) {
        return [];
      }

      const detailRequests = referenceIds.map(async (workId) => {
        const referenceWorkUrl = new URL(`https://api.openalex.org/works/${workId}`);
        referenceWorkUrl.searchParams.set(
          'select',
          'display_name,authorships,publication_year,cited_by_count,doi,primary_topic,concepts'
        );

        const referenceResponse = await fetch(referenceWorkUrl.toString());
        if (!referenceResponse.ok) {
          return null;
        }

        const referenceWork = await referenceResponse.json();
        return normalizeWorkToPaper(referenceWork);
      });

      const referencePapers = (await Promise.all(detailRequests))
        .filter(Boolean)
        .sort((a, b) => b.cited_by_count - a.cited_by_count);

      return referencePapers;
    };

    const drillIntoReferences = async (paper) => {
      if (isDrilling || isTransitioning || !paper) {
        return;
      }

      isDrilling = true;
      isTransitioning = true;
      if (mounted) {
        setStatus({ loading: true, error: null });
      }

      const activeLayer = galaxyLayers[galaxyLayers.length - 1];
      const previousState = snapshotCurrentState(paper?.doi || paper?.title || null);

      try {
        const referenceRequest = fetchReferencePapers(paper);
        startCameraTransition(
          camera.position.z - 24,
          controls.target.z - 16,
          PRE_ZOOM_MS
        );
        await wait(PRE_ZOOM_MS);

        const referencePapers = await referenceRequest;
        if (!mounted) {
          return;
        }

        if (referencePapers.length === 0) {
          throw new Error('No references found for this paper');
        }

        navigationStackRef.current.push(previousState);
        setNavigationStackSize(navigationStackRef.current.length);

        if (activeLayer) {
          queueLayerOpacityTransition(activeLayer, 0.24);
        }

        const nextDepth = currentDepthRef.current - DEPTH_STEP;
        currentDepthRef.current = nextDepth;
        setCurrentDepth(nextDepth);

        const nextLayer = createGalaxyLayer(referencePapers, nextDepth, {
          paperId: paper?.doi || paper?.title || null,
          initialOpacity: 0
        });
        queueLayerOpacityTransition(nextLayer, 1);

        clearSelection();
        startCameraTransition(
          nextDepth + CAMERA_LAYER_OFFSET,
          nextDepth,
          CAMERA_TRANSITION_MS
        );
        setStatus({ loading: false, error: null });
      } catch (error) {
        startCameraTransition(
          previousState.cameraPosition.z,
          previousState.cameraTarget.z,
          PRE_ZOOM_MS
        );
        if (mounted) {
          setStatus({
            loading: false,
            error: error.message || 'Failed to fetch references'
          });
        }
      } finally {
        isDrilling = false;
        isTransitioning = false;
      }
    };

    const navigateBack = async () => {
      if (isDrilling || isTransitioning) {
        return;
      }

      if (navigationStackRef.current.length === 0 || galaxyLayers.length < 2) {
        return;
      }

      isTransitioning = true;
      if (mounted) {
        setStatus({ loading: true, error: null });
      }

      const currentLayer = galaxyLayers[galaxyLayers.length - 1];
      const previousLayer = galaxyLayers[galaxyLayers.length - 2];
      const restoreState = navigationStackRef.current[navigationStackRef.current.length - 1];

      try {
        startCameraTransition(
          camera.position.z + 24,
          controls.target.z + 16,
          PRE_ZOOM_MS
        );
        queueLayerOpacityTransition(currentLayer, 0, PRE_ZOOM_MS + 120);
        if (previousLayer) {
          queueLayerOpacityTransition(previousLayer, 1, PRE_ZOOM_MS + 160);
        }

        await wait(PRE_ZOOM_MS);

        removeGalaxyLayer(currentLayer);
        galaxyLayers.pop();

        navigationStackRef.current.pop();
        setNavigationStackSize(navigationStackRef.current.length);

        currentDepthRef.current = restoreState.depth;
        setCurrentDepth(restoreState.depth);

        clearSelection();
        startCameraTransition(
          restoreState.cameraPosition.z,
          restoreState.cameraTarget.z,
          CAMERA_TRANSITION_MS
        );

        if (mounted) {
          setStatus({ loading: false, error: null });
        }
      } catch (error) {
        if (mounted) {
          setStatus({
            loading: false,
            error: error.message || 'Failed to restore previous galaxy'
          });
        }
      } finally {
        isTransitioning = false;
      }
    };

    backActionRef.current = () => {
      void navigateBack();
    };
    exploreActionRef.current = (paper) => {
      void drillIntoReferences(paper);
    };

    const onClick = (event) => {
      if (isTransitioning) {
        return;
      }

      const intersections = getIntersections(event);
      if (intersections.length > 0) {
        const clickedStar = intersections[0].object;
        applyStarSelection(clickedStar);
      } else {
        clearSelection();
      }
    };

    const onPointerLeave = () => {
      setTooltip((current) => (current.visible ? { ...current, visible: false } : current));
      renderer.domElement.style.cursor = 'grab';
    };

    const onResize = () => {
      const width = mountEl.clientWidth;
      const height = mountEl.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      composer.setSize(width, height);
      bloomPass.setSize(width, height);
    };

    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);
    renderer.domElement.addEventListener('click', onClick);
    window.addEventListener('resize', onResize);

    const loadPapers = async () => {
      try {
        const requestUrl = new URL(PAPERS_URL);
        requestUrl.searchParams.set('field', selectedField);
        const response = await fetch(requestUrl);

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const payload = await response.json();
        const papers = Array.isArray(payload?.papers) ? payload.papers : [];
        createGalaxyLayer(papers, 0, {
          paperId: 'root',
          initialOpacity: 1
        });

        if (mounted) {
          setStatus({ loading: false, error: null });
        }
      } catch (error) {
        if (mounted) {
          setStatus({ loading: false, error: error.message || 'Failed to fetch papers' });
        }
      }
    };

    const render = () => {
      const nowMs = performance.now();
      updateCameraTransition(nowMs);
      updateOpacityTransitions(nowMs);
      controls.update();
      composer.render();
      animationFrameId = window.requestAnimationFrame(render);
    };

    loadPapers();
    render();

    return () => {
      mounted = false;
      if (animationFrameId) {
        window.cancelAnimationFrame(animationFrameId);
      }

      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('click', onClick);
      window.removeEventListener('resize', onResize);
      backActionRef.current = () => {};
      exploreActionRef.current = () => {};

      clearSelection();
      controls.dispose();
      stars.forEach((star) => {
        star.geometry.dispose();
        star.material.dispose();
      });
      renderer.dispose();

      if (mountEl.contains(renderer.domElement)) {
        mountEl.removeChild(renderer.domElement);
      }
    };
  }, [selectedField]);

  const selectedPaperUrl = getPaperExternalUrl(selectedPaper);

  return (
    <main className="app-shell" data-depth={currentDepth}>
      <div ref={mountRef} className="galaxy-canvas" />

      <div className="field-control">
        <label htmlFor="field-select" className="field-label">
          Field
        </label>
        <select
          id="field-select"
          className="field-select"
          value={selectedField}
          onChange={(event) => setSelectedField(event.target.value)}
        >
          {FIELD_OPTIONS.map((field) => (
            <option key={field} value={field}>
              {field}
            </option>
          ))}
        </select>
        {navigationStackSize > 0 && (
          <button
            type="button"
            className="back-button"
            onClick={() => backActionRef.current()}
            disabled={status.loading}
          >
            Back
          </button>
        )}
      </div>

      <div className="depth-indicator">Depth: {Math.abs(currentDepth / DEPTH_STEP)}</div>

      {status.loading && <div className="status-banner">Loading papers...</div>}
      {status.error && <div className="status-banner status-error">{status.error}</div>}

      {tooltip.visible && (
        <div
          className="tooltip"
          style={{
            transform: `translate(${tooltip.x}px, ${tooltip.y}px)`
          }}
        >
          <div className="tooltip-title">{tooltip.title}</div>
          <div className="tooltip-meta">Year: {tooltip.year ?? 'N/A'}</div>
          <div className="tooltip-meta">Citations: {tooltip.citations ?? 0}</div>
        </div>
      )}

      {selectedPaper && (
        <aside className="selected-paper-panel">
          <div className="selected-paper-heading">Selected Paper</div>
          <div className="selected-paper-title">{selectedPaper.title}</div>
          <div className="selected-paper-meta">
            Authors: {Array.isArray(selectedPaper.authors) && selectedPaper.authors.length > 0
              ? selectedPaper.authors.join(', ')
              : 'N/A'}
          </div>
          <div className="selected-paper-meta">Citations: {selectedPaper.cited_by_count ?? 0}</div>
          <div className="selected-paper-actions">
            <button
              type="button"
              className="panel-button panel-button-primary"
              onClick={() => exploreActionRef.current(selectedPaper)}
              disabled={status.loading}
            >
              Explore References
            </button>
            <button
              type="button"
              className="panel-button"
              onClick={() => {
                if (selectedPaperUrl) {
                  window.open(selectedPaperUrl, '_blank', 'noopener,noreferrer');
                }
              }}
              disabled={!selectedPaperUrl}
            >
              View Paper
            </button>
          </div>
        </aside>
      )}
    </main>
  );
}
