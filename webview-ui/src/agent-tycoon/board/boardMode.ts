import { createContext } from 'react';

/**
 * Where the board is drawn, which decides what fits: the wall's copy has no room to scroll or
 * wrap (`mini`: what does not fit is "+n"), the full view is the same shape (`full`), a phone's
 * stacks its pages and takes all the height it needs (`narrow`).
 */
export type BoardMode = 'mini' | 'full' | 'narrow';
export const BoardModeContext = createContext<BoardMode>('full');
