import { useState, useRef, useCallback } from "react";

/* ─── PDF.js loader ─── */
const loadPdfJs = () => new Promise((resolve, reject) => {
  if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  s.onload = () => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    resolve(window.pdfjsLib);
  };
  s.onerror = reject;
  document.head.appendChild(s);
});

/* ─── Extract text items with position from a page ─── */
const getPageTextItems = async (page) => {
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1 });
  return tc.items.map(item => {
    const tx = item.transform;
    return {
      text: item.str.trim(),
      x: tx[4],
      y: vp.height - tx[5], // flip Y so top=0
      height: item.height || tx[3] || 10,
      width: item.width || 0,
    };
  }).filter(i => i.text.length > 0);
};

/* ─── Render page to canvas for image cropping ─── */
/* ─── Main parser: extract all structured data from PDF text ─── */
const parseAuditReport = (allPagesText) => {
  // Build lines grouped by Y position per page
  const allLines = [];
  allPagesText.forEach((pageItems, pgIdx) => {
    const lineMap = {};
    pageItems.forEach(item => {
      const yKey = Math.round(item.y / 5) * 5;
      if (!lineMap[yKey]) lineMap[yKey] = [];
      lineMap[yKey].push(item);
    });
    Object.keys(lineMap).map(Number).sort((a,b) => a-b).forEach(y => {
      const items = lineMap[y].sort((a,b) => a.x - b.x);
      const lineText = items.map(i => i.text).join(" ").trim();
      if (lineText) allLines.push({ text: lineText, page: pgIdx, y, items });
    });
  });

  const fullText = allLines.map(l => l.text).join("\n");

  // Extract header info
  const info = {
    store_name: "", reference_id: "", visit_date: "", last_visit_date: "",
    store_manager: "", area_manager: "", submitted_by: "", reviewed_by: "",
    current_score: 0, total_score: 0, previous_score: 0, percentage: 0, difference: "",
  };

  const ft = fullText;
  const grab = (patterns) => {
    for (const p of patterns) { const m = ft.match(p); if (m) return m[1].trim(); }
    return "";
  };

  info.store_name = grab([/Store\s*Name\s+(.+?)(?:\s+Reference|\n)/i]);
  info.reference_id = grab([/Reference\s*ID\s*[:\-]?\s*([A-Z0-9\-]+)/i]);
  info.store_manager = grab([/Store\s*Manager\s*[:\-]?\s*(.+?)(?:\n|Submitted|Area)/i]);
  info.submitted_by = grab([/Submitted\s*By\s*[:\-]?\s*(.+?)(?:\n|Area|Reviewed)/i]);
  info.area_manager = grab([/Area\s*Manager\s*[:\-]?\s*(.+?)(?:\n|Reviewed|Regional)/i]);
  info.reviewed_by = grab([/Reviewed\s*By\s*[:\-]?\s*(.+?)(?:\n|Regional|Current)/i]);
  info.visit_date = grab([/Current\s*Visit\s*Date\s*[:\-]?\s*([\d\-\/]+)/i]);
  info.last_visit_date = grab([/Last\s*Visit\s*Date\s*[:\-]?\s*([\d\-\/]+)/i]);

  // ─── Parse Summary Table (positional) ───
  // Find line with "Previous Total Score" header, then grab values from next line
  for (let i = 0; i < allLines.length - 1; i++) {
    const lt = allLines[i].text;
    if (lt.includes("Previous Total Score") && lt.includes("Current Score")) {
      // Next line has the values in same order
      const valLine = allLines[i + 1].text;
      const nums = valLine.match(/[\d.]+/g);
      if (nums && nums.length >= 4) {
        info.total_score = parseFloat(nums[2]) || parseFloat(nums[0]); // Current Total Score
        info.current_score = parseFloat(nums[3]) || 0;  // Current Score
        info.previous_score = parseFloat(nums[1]) || 0; // Previous Score
        // % ACH
        const pctM = valLine.match(/([\d.]+)%/);
        if (pctM) info.percentage = parseFloat(pctM[1]);
        // Difference
        const diffM = valLine.match(/(-[\d.]+%)/);
        if (diffM) info.difference = diffM[1];
        else {
          const diffM2 = valLine.match(/([\d.]+%)\s*↓/);
          if (diffM2) info.difference = "-" + diffM2[1];
          else {
            const diffM3 = valLine.match(/([\d.]+%)\s*↑/);
            if (diffM3) info.difference = "+" + diffM3[1];
          }
        }
      }
      break;
    }
  }

  // Fallback: try "Current Score" / "Current Total Score" patterns if table not found
  if (info.current_score === 0) {
    const csm = ft.match(/Current\s+Score\s*[:\-]\s*([\d.]+)/i);
    const tsm = ft.match(/Current\s+Total\s+Score\s*[:\-]\s*([\d.]+)/i);
    const psm = ft.match(/Previous\s+Score\s*[:\-]\s*([\d.]+)/i);
    const pcm = ft.match(/Current\s*%\s*ACH\s*[:\-]\s*([\d.]+)/i);
    const dfm = ft.match(/Difference\s*[:\-]\s*(-?[\d.]+%?)/i);
    if (csm) info.current_score = parseFloat(csm[1]);
    if (tsm) info.total_score = parseFloat(tsm[1]);
    if (psm) info.previous_score = parseFloat(psm[1]);
    if (pcm) info.percentage = parseFloat(pcm[1]);
    if (dfm) info.difference = dfm[1];
  }

  // ─── Build section map ───
  const sectionMap = {}; // questionId -> section name
  let currentSection = "";
  for (const line of allLines) {
    // Section header: "2. Access Control" or "9. Safety & Security" (NOT "2.1 ...")
    const secM = line.text.match(/^(\d{1,2})\.\s+([A-Za-z].+)/);
    if (secM && !line.text.match(/^\d+\.\d+\s/)) {
      currentSection = secM[2]
        .replace(/\s*(Total\s*Score|Obtained|%\s*ACH).*$/i, "")
        .trim();
    }
    // Map question IDs to section
    const qm = line.text.match(/^(\d{1,2}\.\d{1,2})\s/);
    if (qm) sectionMap[qm[1]] = currentSection;
  }

  // ─── FIND NON-COMPLIANT ITEMS ───
  // Strategy: scan each line. If it starts with X.Y and contains "No" → NC found.
  // Also handle multi-line questions where "No" is on a continuation line.
  const nonCompliances = [];

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    const lineText = line.text;

    // Check if this line has a question number AND "No" AND a score
    // Pattern: "X.Y question text No 0 / 3"
    const qMatch = lineText.match(/^(\d{1,2}\.\d{1,2})\s+(.+)/);
    if (!qMatch) continue;

    const qId = qMatch[1];
    const restOfLine = qMatch[2];

    // Check if "No" appears in this line (as a standalone word)
    const hasNoThisLine = /\bNo\b/.test(restOfLine) && !/\bNo\.\b/.test(restOfLine);

    // Check if "No" appears on the NEXT line (for multi-line questions)
    let hasNoNextLine = false;
    let noLineIdx = -1;
    if (!hasNoThisLine) {
      for (let j = i + 1; j <= Math.min(i + 3, allLines.length - 1); j++) {
        const nextText = allLines[j].text;
        // Stop if we hit another question
        if (nextText.match(/^\d{1,2}\.\d{1,2}\s/)) break;
        if (/\bNo\b/.test(nextText)) {
          hasNoNextLine = true;
          noLineIdx = j;
          break;
        }
        if (/\b(Yes|NA)\b/.test(nextText)) break; // it's Yes/NA, skip
      }
    }

    if (!hasNoThisLine && !hasNoNextLine) continue;

    // Extract score from line with "No"
    let maxPts = 3, obtainedPts = 0;
    const scoreLine = hasNoThisLine ? lineText : (noLineIdx >= 0 ? allLines[noLineIdx].text : "");
    const scoreM = scoreLine.match(/(\d+)\s*\/\s*(\d+)/);
    if (scoreM) {
      obtainedPts = parseInt(scoreM[1]);
      maxPts = parseInt(scoreM[2]);
    }

    // Build full question text
    let questionText = restOfLine;
    // Strip "No", score from this line
    questionText = questionText
      .replace(/\s+No\s+\d+\s*\/\s*\d+.*$/, "")
      .replace(/\s+No\s*$/, "")
      .replace(/\s+\d+\s*\/\s*\d+.*$/, "")
      .trim();

    // Collect continuation lines (question text that wraps to next line)
    const noIdx = hasNoNextLine ? noLineIdx : i;
    let contEndIdx = noIdx;
    for (let j = noIdx + 1; j < Math.min(noIdx + 5, allLines.length); j++) {
      const lt = allLines[j].text;
      // Stop if next question, section, answer line, or score header
      if (lt.match(/^\d{1,2}\.\d{1,2}\s/) || lt.match(/^\d{1,2}\.\s+[A-Z]/) ||
          lt.match(/\b(Yes|No|NA)\b.*\d+\s*\/\s*\d+/) || lt.match(/^Total\s*Score/i) ||
          lt.match(/^%\s*ACH/i) || lt.match(/^Obtained/i)) break;
      if (lt.match(/^\d+\s*\/\s*\d+$/) || lt.match(/^\d+\.?\d*%$/)) { contEndIdx = j; continue; }
      if (lt.length > 3 && lt.length < 200) {
        questionText += " " + lt;
        contEndIdx = j;
      } else break;
    }
    questionText = questionText.replace(/\s+/g, " ").trim();

    // Collect auditor comments: lines AFTER continuation ends, before next question
    const commentParts = [];
    for (let j = contEndIdx + 1; j < Math.min(contEndIdx + 10, allLines.length); j++) {
      const lt = allLines[j].text;
      // Stop at next question, section header, or answer line
      if (lt.match(/^\d{1,2}\.\d{1,2}\s/) || lt.match(/^\d{1,2}\.\s+[A-Z]/) ||
          lt.match(/\b(Yes|No|NA)\b.*\d+\s*\/\s*\d+/) || lt.match(/^Total\s*Score/i) ||
          lt.match(/^%\s*ACH/i) || lt.match(/^Obtained/i)) break;
      // Skip pure score lines
      if (lt.match(/^\d+\s*\/\s*\d+$/) || lt.match(/^\d+\.?\d*%$/)) continue;
      if (lt.length > 3) commentParts.push(lt);
    }
    const comment = commentParts.join(" ").trim();

    const section = sectionMap[qId] || "";

    nonCompliances.push({
      id: qId,
      section,
      question: questionText,
      points_lost: maxPts - obtainedPts,
      max_points: maxPts,
      section_obtained: 0,
      section_total: 0,
      section_percentage: 0,
      auditor_comments: comment,
      page: line.page,
      y_position: line.y,
    });
  }

  // Sort by ID
  nonCompliances.sort((a,b) => {
    const [aMaj, aMin] = a.id.split(".").map(Number);
    const [bMaj, bMin] = b.id.split(".").map(Number);
    return aMaj - bMaj || aMin - bMin;
  });

  // Try to get section scores from the section summary table
  for (const nc of nonCompliances) {
    for (let i = 0; i < allLines.length; i++) {
      if (allLines[i].text.includes(nc.section) && nc.section.length > 3) {
        // Look nearby for total/obtained patterns
        for (let j = Math.max(0, i-3); j < Math.min(allLines.length, i+5); j++) {
          const sm = allLines[j].text.match(/Total\s*Score\s*:\s*([\d.]+)\s*Obtained\s*:\s*([\d.]+)/i);
          if (sm) {
            nc.section_total = parseFloat(sm[1]);
            nc.section_obtained = parseFloat(sm[2]);
            nc.section_percentage = nc.section_total > 0 ? Math.round((nc.section_obtained/nc.section_total)*10000)/100 : 0;
            break;
          }
          // Also try pattern like "14.0 11.0 11.0"
          const sm2 = allLines[j].text.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
          if (sm2 && j !== i) {
            const vals = [parseFloat(sm2[1]), parseFloat(sm2[2]), parseFloat(sm2[3])];
            if (vals[0] >= vals[1] && vals[0] < 200) {
              nc.section_total = vals[0];
              nc.section_obtained = vals[1];
              nc.section_percentage = vals[0] > 0 ? Math.round((vals[1]/vals[0])*10000)/100 : 0;
              break;
            }
          }
        }
        break;
      }
    }
  }

  return { info, nonCompliances };
};


export default function ComplianceReport() {
  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [emailReady, setEmailReady] = useState(false);
  const inputRef = useRef(null);

  const handleFile = useCallback((f) => {
    if (!f) return;
    if (f.type !== "application/pdf") { setError("Please upload a PDF file."); return; }
    setError(""); setData(null); setFile(f); setFileName(f.name);
  }, []);

  const onDrop = useCallback((e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0]); }, [handleFile]);

  const analyze = async () => {
    if (!file) return;
    setLoading(true); setError(""); setData(null);
    try {
      setProgress("Loading PDF engine...");
      const pdfjsLib = await loadPdfJs();

      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
      const totalPages = pdf.numPages;

      // Extract text from all pages
      const allPagesText = [];

      for (let i = 1; i <= totalPages; i++) {
        setProgress(`Reading page ${i}/${totalPages}...`);
        const page = await pdf.getPage(i);
        const items = await getPageTextItems(page);
        allPagesText.push(items);
      }

      setProgress("Parsing audit data...");
      const { info, nonCompliances } = parseAuditReport(allPagesText);

      setData({ info, nonCompliances });
    } catch (err) {
      console.error(err);
      setError(err.message || "Failed to parse PDF.");
    } finally { setLoading(false); setProgress(""); }
  };

  const reset = () => { setFile(null); setFileName(""); setData(null); setError(""); if (inputRef.current) inputRef.current.value = ""; };

  // ── UPLOAD ──
  if (!data) {
    return (
      <div style={S.root}><style>{CSS}</style><div style={S.gridBg}/>
        <div style={S.upWrap}><div style={{animation:"fadeUp .5s ease both"}}>
          <div style={S.logoRow}>
            <div style={S.logoIcon}><svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#e11d48" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg></div>
            <span style={S.logoText}>Compliance Audit</span>
          </div>
          <h1 style={S.h1}>Non-Compliance<br/>Email Report</h1>
          <p style={S.sub}>Upload your audit PDF — parses directly to extract non-compliances and auditor comments.</p>
          <div onDragOver={e=>{e.preventDefault();setDragOver(true)}} onDragLeave={()=>setDragOver(false)} onDrop={onDrop} onClick={()=>!loading&&inputRef.current?.click()}
            style={{...S.drop,borderColor:dragOver?"#e11d48":file?"#34d399":"#d1d5db",background:dragOver?"rgba(225,29,72,.03)":file?"rgba(52,211,153,.03)":"#fafafa",cursor:loading?"wait":"pointer"}}>
            <input ref={inputRef} type="file" accept=".pdf" style={{display:"none"}} onChange={e=>handleFile(e.target.files?.[0])}/>
            {!file?(
              <><div style={S.upIcon}><svg width="30" height="30" fill="none" viewBox="0 0 24 24" stroke="#e11d48" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16"/></svg></div>
              <div style={{fontSize:".93rem",fontWeight:600,color:"#374151"}}>Drop audit PDF here or click to browse</div></>
            ):(
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="#34d399" strokeWidth="1.5"><path strokeLinecap="round" d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
                <div><div style={{fontSize:".88rem",fontWeight:600,color:"#374151"}}>{fileName}</div><div style={{fontSize:".7rem",color:"#9ca3af"}}>Ready</div></div>
              </div>
            )}
          </div>
          {error&&<div style={S.err}>{error}</div>}
          <div style={{display:"flex",gap:10,marginTop:16,justifyContent:"flex-end"}}>
            {file&&!loading&&<button onClick={reset} style={S.ghost}>Clear</button>}
            <button onClick={analyze} disabled={!file||loading} style={{...S.primary,opacity:!file||loading?.4:1,cursor:!file||loading?"not-allowed":"pointer"}}>
              {loading?<span style={{display:"flex",alignItems:"center",gap:8}}><span style={S.spin}/>Processing...</span>:"Generate Report"}
            </button>
          </div>
          {loading&&progress&&(
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,marginTop:14}}>
              {[0,1,2].map(i=><span key={i} style={{width:5,height:5,borderRadius:"50%",background:"#e11d48",animation:`bp 1.2s ease infinite`,animationDelay:`${i*.2}s`}}/>)}
              <span style={{fontSize:".78rem",color:"#9ca3af"}}>{progress}</span>
            </div>
          )}
        </div></div>
      </div>
    );
  }

  // ── EMAIL REPORT ──
  const { info, nonCompliances: ncs } = data;
  const totalLost = ncs.reduce((s,n) => s + (n.points_lost||0), 0);

  // ── SEND EMAIL ──
  const sendEmail = async () => {
    // Build email-compatible HTML using ONLY tables (no CSS grid/flexbox)
    const scores = [
      {l:"Current Score",v:`${info.current_score}/${info.total_score}`,c:"#111827"},
      {l:"Achievement",v:`${info.percentage}%`,c:(info.percentage||0)>=90?"#059669":"#dc2626"},
      {l:"Previous",v:`${info.previous_score}/${info.total_score}`,c:"#111827"},
      {l:"Difference",v:info.difference||"—",c:String(info.difference).startsWith("-")?"#dc2626":"#059669"},
    ];

    const scoresCells = scores.map(s =>
      `<td style="width:25%;text-align:center;padding:14px 8px;background:#f9fafb;border:1px solid #e5e7eb;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin-bottom:6px;font-family:monospace;">${s.l}</div>
        <div style="font-size:20px;font-weight:bold;color:${s.c};">${s.v}</div>
      </td>`
    ).join("");

    let ncRows = "";
    ncs.forEach((nc, i) => {
      const bg = i % 2 === 0 ? "#ffffff" : "#f9fafb";
      ncRows += `<tr style="background:${bg};">
        <td style="padding:8px 10px;border:1px solid #e5e7eb;font-weight:bold;color:#dc2626;font-size:12px;font-family:monospace;">${nc.id}</td>
        <td style="padding:8px 10px;border:1px solid #e5e7eb;font-weight:600;font-size:12px;">${nc.section}</td>
        <td style="padding:8px 10px;border:1px solid #e5e7eb;font-size:12px;color:#374151;">${nc.question}</td>
        <td style="padding:8px 10px;border:1px solid #e5e7eb;font-size:12px;color:${nc.auditor_comments ? "#78350f" : "#999"};${nc.auditor_comments ? "background:#fffdf7;" : "font-style:italic;"}">${nc.auditor_comments || "No comments"}</td>
        <td style="padding:8px 10px;border:1px solid #e5e7eb;text-align:center;font-weight:bold;color:#dc2626;font-size:13px;font-family:monospace;">-${nc.points_lost}</td>
      </tr>`;
    });

    const totalRow = `<tr style="background:#fef2f2;">
      <td colspan="4" style="padding:8px 10px;border:1px solid #e5e7eb;font-weight:bold;text-align:right;color:#991b1b;font-size:13px;">Total Points Lost</td>
      <td style="padding:8px 10px;border:1px solid #e5e7eb;text-align:center;font-weight:bold;color:#dc2626;font-size:15px;font-family:monospace;">-${totalLost}</td>
    </tr>`;

    const emailHtml = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;max-width:700px;">
      <p style="font-size:15px;color:#374151;">Dear Team,</p>
      <p style="font-size:14px;color:#4b5563;line-height:1.6;">Please find below the non-compliance findings from the audit at <strong>${info.store_name || "the store"}</strong>${info.reference_id ? ` (${info.reference_id})` : ""}${info.visit_date ? ` on ${info.visit_date}` : ""}. A total of <strong style="color:#dc2626;">${ncs.length} item${ncs.length !== 1 ? "s" : ""}</strong> failed with <strong style="color:#b45309;">${totalLost} points lost</strong>.</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:16px 0 24px;"><tr>${scoresCells}</tr></table>

      <div style="text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#e11d48;font-weight:bold;margin:20px 0 12px;">Non-Compliance Summary</div>

      ${ncs.length === 0 ? `<p style="text-align:center;color:#059669;font-weight:bold;">All Clear — No non-compliance items found.</p>` : `
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:#f8fafc;">
          <th style="padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;border:1px solid #e5e7eb;">Ref</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;border:1px solid #e5e7eb;">Section</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;border:1px solid #e5e7eb;">Question</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;border:1px solid #e5e7eb;">Comments</th>
          <th style="padding:8px 10px;text-align:center;font-size:11px;text-transform:uppercase;color:#6b7280;border:1px solid #e5e7eb;">Lost</th>
        </tr></thead>
        <tbody>${ncRows}${totalRow}</tbody>
      </table>`}

      <div style="border-top:2px solid #e5e7eb;margin-top:24px;padding-top:16px;">
        <p style="font-size:14px;color:#4b5563;line-height:1.6;">Please address the above findings and implement corrective actions before the next audit. Respond with your action plan within <strong>5 working days</strong>.</p>
        <p style="font-size:14px;color:#4b5563;margin-top:12px;">Best regards,<br/><strong>Compliance & Loss Prevention Team</strong></p>
      </div>
    </div>`;

    // Copy to clipboard as rich HTML
    try {
      const blob = new Blob([emailHtml], { type: "text/html" });
      const textBlob = new Blob([document.getElementById("email-report-body")?.innerText || ""], { type: "text/plain" });
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": blob, "text/plain": textBlob }),
      ]);
    } catch (e) {
      // Fallback
      const tmp = document.createElement("div");
      tmp.innerHTML = emailHtml;
      tmp.style.position = "fixed";
      tmp.style.left = "-9999px";
      document.body.appendChild(tmp);
      const range = document.createRange();
      range.selectNodeContents(tmp);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("copy");
      sel.removeAllRanges();
      document.body.removeChild(tmp);
    }

    setEmailReady(true);
    setTimeout(() => setEmailReady(false), 6000);

    // Open default email client
    const subject = `Non-Compliance Report - ${info.store_name || "Store"}${info.reference_id ? ` (${info.reference_id})` : ""}${info.visit_date ? ` - ${info.visit_date}` : ""}`;
    setTimeout(() => {
      window.open(`mailto:?subject=${encodeURIComponent(subject)}`, "_self");
    }, 300);
  };

  return (
    <div style={S.root}><style>{CSS}</style>
      {/* Floating toast */}
      {emailReady && (
        <div style={{position:"fixed",top:20,left:"50%",transform:"translateX(-50%)",zIndex:9999,background:"#059669",color:"#fff",padding:"12px 24px",borderRadius:10,fontSize:".88rem",fontWeight:600,boxShadow:"0 8px 32px rgba(0,0,0,.2)",display:"flex",alignItems:"center",gap:8,animation:"fadeUp .3s ease both"}}>
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
          Report copied! Paste in your email body (Cmd+V)
        </div>
      )}
      <div style={S.outer}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 0",marginBottom:8}}>
          <button onClick={reset} style={S.backBtn}><svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" d="M15 19l-7-7 7-7"/></svg> New Report</button>
          <button onClick={sendEmail} style={{...S.primary,display:"flex",alignItems:"center",gap:8,fontSize:".82rem",padding:"9px 18px",background:emailReady?"#059669":"linear-gradient(135deg,#e11d48,#be123c)"}}>
            {emailReady ? (
              <><svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg> Copied! Paste in email body (Cmd+V)</>
            ) : (
              <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 4L12 13 2 4"/></svg> Send Email</>
            )}
          </button>
        </div>

        <div style={S.email}>
          <div id="email-report-body" style={S.eBody}>
            <p style={S.greet}>Dear Team,</p>
            <p style={S.bTxt}>Please find below the non-compliance findings from the audit at <strong>{info.store_name || "the store"}</strong>{info.reference_id ? ` (${info.reference_id})` : ""}{info.visit_date ? ` on ${info.visit_date}` : ""}. A total of <strong style={{color:"#dc2626"}}>{ncs.length} item{ncs.length!==1?"s":""}</strong> failed with <strong style={{color:"#b45309"}}>{totalLost} points lost</strong>.</p>

            {/* Scores */}
            <div style={S.sGrid}>
              {[
                {l:"Current Score",v:`${info.current_score}/${info.total_score}`},
                {l:"Achievement",v:`${info.percentage}%`,c:(info.percentage||0)>=90?"#059669":"#dc2626"},
                {l:"Previous",v:`${info.previous_score}/${info.total_score}`},
                {l:"Difference",v:info.difference||"—",c:String(info.difference).startsWith("-")?"#dc2626":"#059669"},
              ].map((s,i)=><div key={i} style={S.sBox}><div style={S.sLbl}>{s.l}</div><div style={{...S.sVal,color:s.c||"#111"}}>{s.v}</div></div>)}
            </div>

            {/* SUMMARY TABLE */}
            <div style={S.secHead}><div style={S.secLine}/><span style={S.secTag}>NON-COMPLIANCE SUMMARY</span><div style={S.secLine}/></div>

            {ncs.length === 0 ? (
              <div style={{textAlign:"center",padding:"2rem",color:"#059669",fontWeight:600,fontSize:".9rem"}}>
                <svg width="36" height="36" fill="none" viewBox="0 0 24 24" stroke="#059669" strokeWidth="1.5" style={{margin:"0 auto 8px",display:"block"}}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                All Clear — No non-compliance items found.
              </div>
            ) : (
              <div style={{overflowX:"auto",marginBottom:32}}>
                <table style={S.table}>
                  <thead><tr>
                    {["Ref","Section","Question","Comments","Lost"].map((h,i)=>(
                      <th key={i} style={{...S.th,textAlign:i>=4?"center":"left",width:i===0?"48px":i===4?"52px":i===3?"25%":"auto"}}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {ncs.map((nc,i)=>{
                      return (
                        <tr key={i} style={{background:i%2===0?"#fff":"#fafbfc"}}>
                          <td style={{...S.td,fontWeight:700,color:"#dc2626",fontFamily:"'JetBrains Mono',monospace",fontSize:".74rem"}}>{nc.id}</td>
                          <td style={{...S.td,fontWeight:600,fontSize:".79rem",whiteSpace:"nowrap"}}>{nc.section}</td>
                          <td style={{...S.td,fontSize:".78rem",color:"#374151",lineHeight:1.5}}>{nc.question}</td>
                          <td style={{...S.td,fontSize:".77rem",color:nc.auditor_comments?"#78350f":"#9ca3af",lineHeight:1.5,fontStyle:nc.auditor_comments?"normal":"italic",background:nc.auditor_comments?"#fffdf7":"transparent"}}>
                            {nc.auditor_comments || "No comments"}
                          </td>
                          <td style={{...S.td,textAlign:"center",fontWeight:700,color:"#dc2626",fontFamily:"'JetBrains Mono',monospace",fontSize:".82rem"}}>−{nc.points_lost}</td>
                        </tr>
                      );
                    })}
                    <tr style={{background:"#fef2f2"}}>
                      <td colSpan={4} style={{...S.td,fontWeight:700,textAlign:"right",color:"#991b1b",fontSize:".82rem"}}>Total Points Lost</td>
                      <td style={{...S.td,textAlign:"center",fontWeight:700,color:"#dc2626",fontSize:"1rem",fontFamily:"'JetBrains Mono',monospace"}}>−{totalLost}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {/* Closing */}
            <div style={{borderTop:"2px solid #e5e7eb",marginTop:32,paddingTop:20}}>
              <p style={S.bTxt}>Please address the above findings and implement corrective actions before the next audit. Respond with your action plan within <strong>5 working days</strong>.</p>
              <p style={{...S.bTxt,marginTop:16}}>Best regards,<br/><strong>Compliance & Loss Prevention Team</strong></p>
            </div>
            <div style={S.foot}>
              <div>Auto-generated report{info.visit_date ? ` | Visit: ${info.visit_date}` : ""}{info.reference_id ? ` | Ref: ${info.reference_id}` : ""}</div>
              <div>{info.store_name ? `Store: ${info.store_name}` : ""}{info.submitted_by ? ` | Submitted: ${info.submitted_by}` : ""}{info.reviewed_by ? ` | Reviewed: ${info.reviewed_by}` : ""}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const CSS=`
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Outfit:wght@300;400;500;600;700&display=swap');
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
@keyframes bp{0%,100%{opacity:.3}50%{opacity:1}}
@keyframes spin{to{transform:rotate(360deg)}}
`;

const S={
  root:{fontFamily:"'Outfit',sans-serif",background:"#ffffff",color:"#1f2937",minHeight:"100vh"},
  gridBg:{position:"fixed",inset:0,backgroundImage:"linear-gradient(rgba(225,29,72,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(225,29,72,.03) 1px,transparent 1px)",backgroundSize:"56px 56px",pointerEvents:"none"},
  upWrap:{maxWidth:620,margin:"0 auto",padding:"4rem 1.5rem"},
  logoRow:{display:"flex",alignItems:"center",gap:10,marginBottom:"1.5rem"},
  logoIcon:{width:38,height:38,borderRadius:10,background:"rgba(225,29,72,.1)",border:"1px solid rgba(225,29,72,.2)",display:"flex",alignItems:"center",justifyContent:"center"},
  logoText:{fontFamily:"'JetBrains Mono',monospace",fontSize:".68rem",fontWeight:600,letterSpacing:".1em",textTransform:"uppercase",color:"#e11d48"},
  h1:{fontSize:"2.3rem",fontWeight:700,lineHeight:1.1,letterSpacing:"-.03em",marginBottom:".7rem",background:"linear-gradient(135deg,#1f2937 30%,#e11d48)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"},
  sub:{fontSize:".85rem",color:"#6b7280",lineHeight:1.6,maxWidth:500},
  drop:{border:"1.5px dashed #d1d5db",borderRadius:16,padding:"2.2rem 2rem",textAlign:"center",transition:"all .25s",marginTop:"2rem"},
  upIcon:{width:52,height:52,borderRadius:14,background:"rgba(225,29,72,.07)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px"},
  err:{display:"flex",alignItems:"center",gap:8,marginTop:12,padding:"10px 14px",background:"rgba(239,68,68,.06)",border:"1px solid rgba(239,68,68,.15)",borderRadius:10,fontSize:".8rem",color:"#ef4444"},
  primary:{fontFamily:"'Outfit',sans-serif",fontSize:".86rem",fontWeight:600,color:"#fff",background:"linear-gradient(135deg,#e11d48,#be123c)",border:"none",borderRadius:10,padding:"12px 24px",cursor:"pointer"},
  ghost:{fontFamily:"'Outfit',sans-serif",fontSize:".86rem",fontWeight:500,color:"#6b7280",background:"transparent",border:"1px solid #d1d5db",borderRadius:10,padding:"12px 18px",cursor:"pointer"},
  spin:{width:14,height:14,border:"2px solid rgba(225,29,72,.2)",borderTopColor:"#e11d48",borderRadius:"50%",animation:"spin .7s linear infinite",display:"inline-block"},

  outer:{maxWidth:880,margin:"0 auto",padding:"1rem 1rem 3rem"},
  bar:{display:"flex",padding:"12px 0",marginBottom:8},
  backBtn:{fontFamily:"'Outfit',sans-serif",display:"flex",alignItems:"center",gap:6,fontSize:".82rem",fontWeight:500,color:"#e11d48",background:"none",border:"1px solid rgba(225,29,72,.2)",borderRadius:8,padding:"7px 14px",cursor:"pointer"},
  email:{background:"#fff",borderRadius:14,overflow:"hidden",boxShadow:"0 2px 20px rgba(0,0,0,.08)",border:"1px solid #e5e7eb"},
  eBody:{padding:"28px 28px 20px",color:"#1f2937"},
  greet:{fontSize:".92rem",marginBottom:14,color:"#374151"},
  bTxt:{fontSize:".86rem",lineHeight:1.65,color:"#4b5563"},

  sGrid:{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,margin:"20px 0 28px"},
  sBox:{background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:10,padding:"14px 10px",textAlign:"center"},
  sLbl:{fontFamily:"'JetBrains Mono',monospace",fontSize:".55rem",fontWeight:600,letterSpacing:".08em",textTransform:"uppercase",color:"#9ca3af",marginBottom:6},
  sVal:{fontSize:"1.15rem",fontWeight:700},

  secHead:{display:"flex",alignItems:"center",gap:12,margin:"8px 0 18px"},
  secLine:{flex:1,height:1,background:"#e5e7eb"},
  secTag:{fontFamily:"'JetBrains Mono',monospace",fontSize:".6rem",fontWeight:700,letterSpacing:".12em",color:"#dc2626",whiteSpace:"nowrap"},

  table:{width:"100%",borderCollapse:"collapse",border:"1px solid #e5e7eb",fontSize:".84rem"},
  th:{fontFamily:"'JetBrains Mono',monospace",fontSize:".58rem",fontWeight:700,letterSpacing:".06em",textTransform:"uppercase",color:"#6b7280",background:"#f3f4f6",padding:"10px 12px",borderBottom:"2px solid #e5e7eb"},
  td:{padding:"10px 12px",borderBottom:"1px solid #f0f0f3",color:"#374151",verticalAlign:"top"},

  foot:{marginTop:24,paddingTop:14,borderTop:"1px solid #e5e7eb",fontSize:".63rem",color:"#9ca3af",textAlign:"center",fontFamily:"'JetBrains Mono',monospace",lineHeight:1.7},
};
