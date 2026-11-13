import { Color, LineBasicMaterial, PointsMaterial, type Group, type Material, type Object3D, type Scene } from 'three';

function annotationMaterials(centreline: Group) {
  const materials = new Set<LineBasicMaterial | PointsMaterial>();
  centreline.traverse((object: Object3D & { material?: Material | Material[] }) => {
    for (const material of object.material ? Array.isArray(object.material) ? object.material : [object.material] : []) {
      if (material instanceof PointsMaterial || material instanceof LineBasicMaterial) materials.add(material);
    }
  });
  return materials;
}

/** Station dots and an uncoloured centreline dark on a light background, white on a dark one. */
export function setAnnotationContrast(centreline: Group, light: boolean, defaultCentreline: boolean) {
  for (const material of annotationMaterials(centreline)) {
    const hex = light && (material instanceof PointsMaterial || defaultCentreline) ? 0x162531 : 0xffffff;
    if (material.color.getHex() !== hex) material.color.setHex(hex);
  }
}
/** Keep station dots and uncoloured centreline readable against either background. */
export function setSceneBackground(scene: Scene, centreline: Group, white: boolean, defaultCentreline: boolean) {
  if (scene.background instanceof Color) scene.background.setHex(white ? 0xffffff : 0x000000);
  else scene.background = new Color(white ? 0xffffff : 0x000000);
  setAnnotationContrast(centreline, white, defaultCentreline);
}

/**
 * Apply an export background without changing the live scene's background or colours. Without
 * white the export keeps the view's own background and colours.
 */
export function applyImageBackground(scene: Scene, centreline: Group, defaultCentreline: boolean, white: boolean) {
  if (!white) return () => {};
  const background = scene.background;
  const colors = new Map([...annotationMaterials(centreline)].map(material => [material, material.color.clone()]));
  // Keep the original Color object unchanged so it can be restored by identity.
  scene.background = new Color(); setSceneBackground(scene, centreline, white, defaultCentreline);
  return () => {
    scene.background = background;
    for (const [material, color] of colors) material.color.copy(color);
  };
}
export function applyImagePrintTheme(scene: Scene, centreline: Group, defaultCentreline: boolean) {
  return applyImageBackground(scene, centreline, defaultCentreline, true);
}
