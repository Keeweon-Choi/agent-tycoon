import type { ReactNode } from 'react';

/** SPT-P3-FINISH: the numbers of a text in the face the IDs use (.spec-count), the words in the pixel font. */
export function Digits({ text }: { text: string }): ReactNode {
  return text.split(/(\d+)/).map((part, i) =>
    i % 2 ? (
      <span key={i} className="spec-count">
        {part}
      </span>
    ) : (
      part
    ),
  );
}
