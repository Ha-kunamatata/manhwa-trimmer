/**
 * Minimal PDF writer.
 *
 * JPEG bytes are embedded verbatim through /DCTDecode, so no external library
 * is needed — the published single-file build must stay self-contained.
 *
 * @param {{bytes:Uint8Array,w:number,h:number}[]} items one entry per page
 * @returns {Uint8Array} a complete PDF document
 */
export function buildPdf(items) {
  const enc = new TextEncoder();
  const parts = []; let len = 0;
  const put = d => { const a = typeof d === "string" ? enc.encode(d) : d; parts.push(a); len += a.length; };
  const n = items.length, PAGE_PT = 420;
  const objs = []; const kids = [];
  let id = 3;
  const meta = items.map(() => ({ page:id++, content:id++, image:id++ }));
  meta.forEach(m => kids.push(m.page + " 0 R"));
  objs[1] = ["<< /Type /Catalog /Pages 2 0 R >>"];
  objs[2] = ["<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + n + " >>"];
  items.forEach((it, i) => {
    const m = meta[i];
    const wPt = PAGE_PT, hPt = +(PAGE_PT * it.h / it.w).toFixed(2);
    objs[m.page] = ["<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + wPt + " " + hPt + "]"
      + " /Resources << /XObject << /Im0 " + m.image + " 0 R >> >> /Contents " + m.content + " 0 R >>"];
    const cs = "q " + wPt + " 0 0 " + hPt + " 0 0 cm /Im0 Do Q";
    objs[m.content] = ["<< /Length " + cs.length + " >>\nstream\n" + cs + "\nendstream"];
    objs[m.image] = ["<< /Type /XObject /Subtype /Image /Width " + it.w + " /Height " + it.h
      + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length "
      + it.bytes.length + " >>\nstream\n", it.bytes, "\nendstream"];
  });
  put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const offsets = new Array(objs.length).fill(0);
  for(let i=1;i<objs.length;i++){
    if(!objs[i]) continue;
    offsets[i] = len;
    put(i + " 0 obj\n"); objs[i].forEach(put); put("\nendobj\n");
  }
  const xref = len, maxId = objs.length - 1;
  let x = "xref\n0 " + (maxId+1) + "\n0000000000 65535 f \n";
  for(let i=1;i<=maxId;i++) x += String(offsets[i]).padStart(10,"0") + " 00000 n \n";
  put(x);
  put("trailer\n<< /Size " + (maxId+1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
  const out = new Uint8Array(len); let o = 0;
  for(const p of parts){ out.set(p, o); o += p.length; }
  return out;
}
