// Imported for its effect by every lazily loaded spec module: registers the spec.* strings once.
import { addStrings } from './lazy.js';
import { specEn } from './spec.en.js';
import { specKo } from './spec.ko.js';

addStrings(specEn, specKo);
