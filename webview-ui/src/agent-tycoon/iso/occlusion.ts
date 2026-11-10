/**
 * ISO-OCCLUSION: screen-space decisions for pieces painted over a character.
 * The renderer keeps these four values on each drawable, so this calculation itself creates
 * no frame objects.
 */
export interface IsoScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Strict overlap: touching edges do not cover a pixel of either picture. */
export function screenBoxesOverlap(a: IsoScreenBox, b: IsoScreenBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** An object only fades when the painter draws it after the character it covers. */
export function fadesForCharacter(
  characterOrder: number,
  objectOrder: number,
  character: IsoScreenBox,
  object: IsoScreenBox,
): boolean {
  return objectOrder > characterOrder && screenBoxesOverlap(character, object);
}
