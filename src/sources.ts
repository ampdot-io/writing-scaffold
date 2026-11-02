export const SCAFFOLD_SOURCES = ['copypastatext', 'gutenberg', 'wikisource', 'queneau', 'snowclone', 'sec_s1', 'halimedemf', 'rfc', 'press_release', 'common_sense', 'iso_iec', 'ntsb', 'elife', 'spoon_river', 'fantastic_fables', 'proclamation', 'scotus_argument', 'congressional_hearing', 'uspto', 'tumblr', 'fourchan', 'lesswrong'] as const;
export type ScaffoldSource = typeof SCAFFOLD_SOURCES[number];

const SOURCE_LABELS: Record<ScaffoldSource, string> = {
  copypastatext: 'CopypastaText',
  gutenberg: 'Gutenberg letter models',
  wikisource: 'Wikisource works',
  queneau: 'Queneau exercises',
  snowclone: 'snowclone patterns',
  sec_s1: 'SEC S-1 prospectus summaries',
  halimedemf: 'Halimedemf Substack posts',
  rfc: 'RFC documents',
  press_release: 'official press releases',
  common_sense: 'Thomas Paine Common Sense',
  iso_iec: 'ISO/IEC specifications and public drafts',
  ntsb: 'NTSB investigation executive summaries',
  elife: 'eLife public peer reviews and author responses',
  spoon_river: 'Edgar Lee Masters Spoon River Anthology',
  fantastic_fables: 'Ambrose Bierce Fantastic Fables',
  proclamation: 'U.S. presidential proclamations',
  scotus_argument: 'Supreme Court oral-argument excerpts',
  congressional_hearing: 'congressional hearing transcript excerpts',
  uspto: 'U.S. patent abstracts and claims',
  tumblr: 'Tumblr recognized post formats',
  fourchan: '4chan recognized post formats',
  lesswrong: 'LessWrong reusable posts',
};

export const SERVER_DESCRIPTION = `Read-only writing library. Sources: ${SCAFFOLD_SOURCES.map(source => `${source} (${SOURCE_LABELS[source]})`).join(', ')}. Use list_scaffolds with include_sources and/or exclude_sources to filter collections.`;
