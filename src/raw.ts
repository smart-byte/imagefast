/** MIME types that browsers and operating systems report for camera RAW files. */
export const RAW_MIME_TYPES = new Set([
  'image/x-sony-arw',
  'image/x-canon-cr2',
  'image/x-canon-crw',
  'image/x-kodak-dcr',
  'image/x-adobe-dng',
  'image/x-epson-erf',
  'image/x-kodak-k25',
  'image/x-kodak-kdc',
  'image/x-minolta-mrw',
  'image/x-nikon-nef',
  'image/x-olympus-orf',
  'image/x-pentax-pef',
  'image/x-fujifilm-raf',
  'image/x-panasonic-raw',
  'image/x-sony-sr2',
  'image/x-sony-srf',
  'image/x-sigma-x3f',
]);

/** File extensions (lower case, no dot) treated as camera RAW. */
export const RAW_EXTENSIONS = new Set([
  'cr2',
  'cr3',
  'dng',
  'arw',
  'x3f',
  'crw',
  'dcr',
  'erf',
  'k25',
  'kdc',
  'mrw',
  'nef',
  'nrw',
  'orf',
  'pef',
  'raf',
  'raw',
  'rw2',
  'sr2',
  'srf',
]);

/** Whether a file is camera RAW, by MIME type or extension. The content is not inspected: most RAW formats are TIFF inside. */
export function isRawFile(file: { name?: string; type?: string }): boolean {
  if (file.type && RAW_MIME_TYPES.has(file.type)) return true;
  const ext = file.name?.split('.').pop()?.toLowerCase();
  return ext != null && ext !== file.name && RAW_EXTENSIONS.has(ext);
}
