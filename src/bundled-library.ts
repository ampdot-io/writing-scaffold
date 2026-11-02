import { Corpus } from './corpus.js';
import { Library } from './library.js';
import { loadImportedBytes } from './runtime-assets.js';
export { OPTIONAL_COLLECTION_PATHS } from './runtime-assets.js';

/** Keep separately maintained collections outside provider exports, which can be refreshed. */
export async function loadBundledLibrary(original: Corpus): Promise<Library> {
  return new Library(original, await loadImportedBytes());
}
