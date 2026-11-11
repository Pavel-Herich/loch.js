const MAX_XML_BYTES = 5 * 1024 * 1024;

/** Detect animation XML before touching the loaded model; large binary files need only a prefix read. */
export async function readPresentationXml(file: Blob): Promise<string | undefined> {
  const prefix = await file.slice(0, 512).text();
  if (!/^\s*</u.test(prefix)) return;
  if (file.size > MAX_XML_BYTES) throw new Error('Animation XML exceeds the 5 MiB size limit.');
  const xml = await file.text();
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid or unsupported animation XML.');
  let document: XMLDocument;
  try { document = new DOMParser().parseFromString(xml, 'application/xml'); }
  catch { throw new Error('Invalid animation XML.'); }
  if (document.getElementsByTagName('parsererror').length) throw new Error('Invalid animation XML.');
  if (document.documentElement?.tagName !== 'LochPresentation') throw new Error('Unsupported XML file. Expected a LochPresentation animation.');
  return xml;
}
