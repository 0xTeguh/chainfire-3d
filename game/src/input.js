// CHAINFIRE 3D — input: mouse + touch + keyboard.
// Drag draws a powder trail on the terrain (raycast to the ground, refined
// with terrainHeight). 2-finger drag orbits, pinch zooms, wheel zooms.
// Written fresh for the 3D rebuild.

import { THREE } from './three.js';
import { terrainHeight } from './terrain.js';

export function createInput(canvas, renderer, callbacks) {
  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 160),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  groundPlane.rotation.x = -Math.PI / 2;
  groundPlane.position.set(0, 0, 0);
  renderer.scene.add(groundPlane);

  const pointers = new Map();
  let drawing = false;
  let downPos = null;
  let downTime = 0;
  let pinchDist = 0;
  let pinchZoom = 1;
  let twoFingerLast = null;
  let enabled = true;

  function screenToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera({ x: nx, y: ny }, renderer.camera);
    // Intersect the y=0 plane, then refine once with the terrain height.
    const hits = raycaster.intersectObject(groundPlane, false);
    if (hits.length === 0) return null;
    let p = hits[0].point;
    const y1 = terrainHeight(p.x, p.z);
    if (Math.abs(y1) > 0.05) {
      groundPlane.position.y = y1;
      const hits2 = raycaster.intersectObject(groundPlane, false);
      groundPlane.position.y = 0;
      if (hits2.length > 0) p = hits2[0].point;
    }
    return { x: p.x, z: p.z };
  }

  function onPointerDown(e) {
    if (!enabled) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      // Start a two-finger gesture: cancel any trail draw.
      if (drawing) {
        drawing = false;
        callbacks.onTrailCancel();
      }
      const pts = [...pointers.values()];
      pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchZoom = 1;
      twoFingerLast = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      return;
    }
    if (pointers.size !== 1) return;
    downPos = { x: e.clientX, y: e.clientY };
    downTime = performance.now();
    const w = screenToWorld(e.clientX, e.clientY);
    if (w) {
      drawing = true;
      callbacks.onTrailStart(w.x, w.z);
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      if (pinchDist > 0 && dist > 0) {
        const ratio = dist / pinchDist;
        callbacks.onZoom(ratio / pinchZoom);
        pinchZoom = ratio;
      }
      if (twoFingerLast) {
        const dx = mid.x - twoFingerLast.x;
        const dy = mid.y - twoFingerLast.y;
        callbacks.onOrbit(-dx * 0.005, -dy * 0.003);
      }
      twoFingerLast = mid;
      return;
    }
    if (pointers.size !== 1 || !drawing) return;
    const w = screenToWorld(e.clientX, e.clientY);
    if (w) callbacks.onTrailMove(w.x, w.z);
  }

  function onPointerUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size === 1) {
      // Back to one finger: re-anchor the pinch state.
      const pts = [...pointers.values()];
      twoFingerLast = { x: pts[0].x, y: pts[0].y };
      pinchDist = 0;
      return;
    }
    if (pointers.size === 0) {
      twoFingerLast = null;
      pinchDist = 0;
      if (drawing) {
        drawing = false;
        const moved = downPos ? Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) : 999;
        const quick = performance.now() - downTime < 250;
        if (moved < 8 && quick) callbacks.onTap();
        else callbacks.onTrailEnd();
      }
      downPos = null;
    }
  }

  function onWheel(e) {
    if (!enabled) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    callbacks.onZoom(factor);
  }

  function onKeyDown(e) {
    if (!enabled && e.key !== 'p' && e.key !== 'P' && e.key !== 'Escape') return;
    switch (e.key) {
      case '1': callbacks.onPowderType(0); break;
      case '2': callbacks.onPowderType(1); break;
      case '3': callbacks.onPowderType(2); break;
      case 'q': case 'Q': callbacks.onOrbit(0.12, 0); break;
      case 'e': case 'E': callbacks.onOrbit(-0.12, 0); break;
      case ' ': e.preventDefault(); callbacks.onLightFuse(); break;
      case 'p': case 'P': callbacks.onPause(); break;
      case 'm': case 'M': callbacks.onMute(); break;
      case 'r': case 'R': callbacks.onReroll(); break;
      case 'h': case 'H': callbacks.onHelp(); break;
      case 'Escape': callbacks.onEscape(); break;
      default: break;
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);

  return {
    setEnabled(v) { enabled = v; },
    screenToWorld,
    destroy() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      renderer.scene.remove(groundPlane);
    }
  };
}
