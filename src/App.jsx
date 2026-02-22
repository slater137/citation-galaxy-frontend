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

function getFieldStarColor(field) {
  return new THREE.Color(FIELD_STAR_COLORS[field] ?? FIELD_STAR_COLORS.physics);
}

function randomSpread(spread) {
  // Weighted random puts more stars toward center, with soft edge scatter.
  const a = Math.random() - 0.5;
  const b = Math.random() - 0.5;
  return (a + b) * spread;
}

export default function App() {
  const mountRef = useRef(null);
  const [selectedField, setSelectedField] = useState('physics');
  const [status, setStatus] = useState({ loading: true, error: null });
  const [selectedPaper, setSelectedPaper] = useState(null);
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
      0.6,
      0.4,
      0.2
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
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let selectedStar = null;

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
      material.emissiveIntensity = 0.95;

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

    const onClick = (event) => {
      const intersections = getIntersections(event);
      if (intersections.length > 0) {
        applyStarSelection(intersections[0].object);
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

        papers.forEach((paper) => {
          const paperLog = Number(paper?.size);
          const safeLog = Number.isFinite(paperLog) ? paperLog : minLog;
          const normalized = logRange > 0 ? (safeLog - minLog) / logRange : 0.5;
          const clampedNormalized = THREE.MathUtils.clamp(normalized, 0, 1);
          const radius = THREE.MathUtils.clamp(
            MIN_STAR_SIZE + clampedNormalized * (MAX_STAR_SIZE - MIN_STAR_SIZE),
            MIN_STAR_SIZE,
            MAX_STAR_SIZE
          );
          const paperCitation = Number(paper?.cited_by_count);
          const safeCitation = Number.isFinite(paperCitation) ? paperCitation : minCitation;
          const citationNormalized =
            citationRange > 0 ? (safeCitation - minCitation) / citationRange : 0.5;
          const clampedCitation = THREE.MathUtils.clamp(citationNormalized, 0, 1);
          const orbitalRadius =
            maxRadius - clampedCitation * (maxRadius - minRadius);
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.acos(THREE.MathUtils.randFloatSpread(2));
          const sinPhi = Math.sin(phi);
          const x = orbitalRadius * sinPhi * Math.cos(theta);
          const y = orbitalRadius * Math.cos(phi);
          const z = orbitalRadius * sinPhi * Math.sin(theta);

          const geometry = new THREE.SphereGeometry(radius, 12, 12);
          const baseColor = getFieldStarColor(selectedField);
          const material = new THREE.MeshStandardMaterial({
            color: baseColor,
            emissive: baseColor,
            emissiveIntensity: 3,
            toneMapped: false
          });

          const star = new THREE.Mesh(geometry, material);
          star.position.set(x, y, z);
          star.userData.paper = paper;
          star.userData.baseColor = baseColor.clone();
          star.userData.baseEmissiveIntensity = material.emissiveIntensity;

          stars.push(star);
          scene.add(star);
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

  return (
    <main className="app-shell">
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
      </div>

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
          <div className="selected-paper-meta">Year: {selectedPaper.publication_year ?? 'N/A'}</div>
          <div className="selected-paper-meta">Citations: {selectedPaper.cited_by_count ?? 0}</div>
          <div className="selected-paper-meta">
            DOI:{' '}
            {selectedPaper.doi ? (
              <a
                className="selected-paper-link"
                href={`https://doi.org/${selectedPaper.doi}`}
                target="_blank"
                rel="noreferrer"
              >
                {selectedPaper.doi}
              </a>
            ) : (
              'N/A'
            )}
          </div>
        </aside>
      )}
    </main>
  );
}
