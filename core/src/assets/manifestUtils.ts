/**
 * Manifest flattening utilities — shared between the extension host, Vite build
 * scripts, and future standalone backend.
 *
 * Recursively flattens furniture manifest trees into flat asset arrays.
 */

// ── GFX: optional 2.5D visual metadata (owner 10-25, Part B) ──

/** Where an item's picture stands and how it sorts, apart from the tiles it occupies (its
 *  footprint, which alone decides walking, collision and placement). All optional: a manifest
 *  without it draws exactly as before (the picture's top-left on the footprint's top-left). */
export interface FurnitureVisual {
  /** Sprite px of the point that stands on the footprint's bottom centre (default: the
   *  picture's bottom centre). The picture may be taller or wider than the footprint. */
  footAnchor?: { x: number; y: number };
  /** World px the picture is lifted above that point (a pendant lamp hangs). */
  elevation?: number;
  /** World px added to the depth key (+ draws later, in front). */
  depthOffset?: number;
  /** 'foreground': drawn after everything that stands (characters, pets, furniture). */
  occlusionMode?: 'default' | 'foreground';
  /** A shadow on the floor under it: 'ground'. Unknown ids draw nothing. */
  shadowPreset?: string;
  /** A light pool on the floor under it: 'warm-pool'. Unknown ids draw nothing. */
  lightingPreset?: string;
}

const VISUAL_MAX_PX = 256;
const PRESET_ID = /^[a-z0-9-]{1,32}$/;

/** The valid part of a manifest's `visual` (manifests can be the user's): finite numbers
 *  within ±256 px, known modes, short preset ids. undefined when nothing valid is left. */
export function sanitizeVisual(raw: unknown): FurnitureVisual | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const px = (n: unknown) =>
    typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= VISUAL_MAX_PX ? n : undefined;
  const out: FurnitureVisual = {};
  const a = v.footAnchor as { x?: unknown; y?: unknown } | undefined;
  const ax = px(a?.x);
  const ay = px(a?.y);
  if (ax !== undefined && ay !== undefined) out.footAnchor = { x: ax, y: ay };
  const elevation = px(v.elevation);
  if (elevation !== undefined) out.elevation = elevation;
  const depthOffset = px(v.depthOffset);
  if (depthOffset !== undefined) out.depthOffset = depthOffset;
  if (v.occlusionMode === 'default' || v.occlusionMode === 'foreground')
    out.occlusionMode = v.occlusionMode;
  if (typeof v.shadowPreset === 'string' && PRESET_ID.test(v.shadowPreset))
    out.shadowPreset = v.shadowPreset;
  if (typeof v.lightingPreset === 'string' && PRESET_ID.test(v.lightingPreset))
    out.lightingPreset = v.lightingPreset;
  return Object.keys(out).length ? out : undefined;
}

/** `{ visual }` when the manifest has a valid one, else nothing (old entries stay as they were). */
export function visualOf(raw: unknown): { visual?: FurnitureVisual } {
  const visual = sanitizeVisual(raw);
  return visual ? { visual } : {};
}

// ── Manifest types ──────────────────────────────────────────

export interface ManifestAsset {
  type: 'asset';
  id: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  orientation?: string;
  state?: string;
  frame?: number;
  mirrorSide?: boolean;
  visual?: unknown;
}

export interface ManifestGroup {
  type: 'group';
  groupType: 'rotation' | 'state' | 'animation';
  rotationScheme?: string;
  orientation?: string;
  state?: string;
  members: ManifestNode[];
}

export type ManifestNode = ManifestAsset | ManifestGroup;

export interface FurnitureManifest {
  id: string;
  name: string;
  category: string;
  canPlaceOnWalls: boolean;
  canPlaceOnSurfaces: boolean;
  backgroundTiles: number;
  // If type is 'asset', these fields are present:
  type: 'asset' | 'group';
  file?: string;
  width?: number;
  height?: number;
  footprintW?: number;
  footprintH?: number;
  visual?: unknown;
  // If type is 'group':
  groupType?: string;
  rotationScheme?: string;
  members?: ManifestNode[];
}

export interface InheritedProps {
  groupId: string;
  name: string;
  category: string;
  canPlaceOnWalls: boolean;
  canPlaceOnSurfaces: boolean;
  backgroundTiles: number;
  orientation?: string;
  state?: string;
  rotationScheme?: string;
  animationGroup?: string;
}

export interface FurnitureAsset {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
  visual?: FurnitureVisual;
}

/**
 * Recursively flatten a manifest node into FurnitureAsset[].
 * Inherited properties flow from root to all leaf assets.
 */
export function flattenManifest(node: ManifestNode, inherited: InheritedProps): FurnitureAsset[] {
  if (node.type === 'asset') {
    const asset = node as ManifestAsset;
    // Merge orientation: node-level takes priority, then inherited
    const orientation = asset.orientation ?? inherited.orientation;
    const state = asset.state ?? inherited.state;
    return [
      {
        id: asset.id,
        name: inherited.name,
        label: inherited.name,
        category: inherited.category,
        file: asset.file,
        width: asset.width,
        height: asset.height,
        footprintW: asset.footprintW,
        footprintH: asset.footprintH,
        isDesk: inherited.category === 'desks',
        canPlaceOnWalls: inherited.canPlaceOnWalls,
        canPlaceOnSurfaces: inherited.canPlaceOnSurfaces,
        backgroundTiles: inherited.backgroundTiles,
        groupId: inherited.groupId,
        ...(orientation ? { orientation } : {}),
        ...(state ? { state } : {}),
        ...(asset.mirrorSide ? { mirrorSide: true } : {}),
        ...(inherited.rotationScheme ? { rotationScheme: inherited.rotationScheme } : {}),
        ...(inherited.animationGroup ? { animationGroup: inherited.animationGroup } : {}),
        ...(asset.frame !== undefined ? { frame: asset.frame } : {}),
        ...visualOf(asset.visual),
      },
    ];
  }

  // Group node
  const group = node as ManifestGroup;
  const results: FurnitureAsset[] = [];

  for (const member of group.members) {
    // Build inherited props for children
    const childProps: InheritedProps = { ...inherited };

    if (group.groupType === 'rotation') {
      // Rotation groups set groupId and pass rotationScheme
      if (group.rotationScheme) {
        childProps.rotationScheme = group.rotationScheme;
      }
    }

    if (group.groupType === 'state') {
      // State groups propagate orientation from the group level
      if (group.orientation) {
        childProps.orientation = group.orientation;
      }
      // Propagate state from group level if set (for animation groups nested in state)
      if (group.state) {
        childProps.state = group.state;
      }
    }

    if (group.groupType === 'animation') {
      // Animation groups: create animation group ID and propagate state
      // Use the parent's orientation to build a unique animation group name
      const orient = group.orientation ?? inherited.orientation ?? '';
      const st = group.state ?? inherited.state ?? '';
      childProps.animationGroup = `${inherited.groupId}_${orient}_${st}`.toUpperCase();
      if (group.state) {
        childProps.state = group.state;
      }
    }

    // Propagate orientation from group to children (for state groups that have orientation)
    if (group.orientation && !childProps.orientation) {
      childProps.orientation = group.orientation;
    }

    results.push(...flattenManifest(member, childProps));
  }

  return results;
}
