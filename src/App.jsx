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

  info.store_name = grab([/Store\s*Name\s+(.+?)(?:\s+Reference|\n)/i, /Report\s*On\s+(.+?)(?:\n|$)/i]);
  info.reference_id = grab([/Reference\s*ID\s*[:\-]?\s*([A-Z0-9\-]+)/i, /Reference\s+([A-Z0-9\-]+)/i]);
  info.store_manager = grab([/Store\s*Manager\s*[:\-]?\s*(.+?)(?:\n|Submitted|Area)/i]);
  info.submitted_by = grab([/Submitted\s*By\s*[:\-]?\s*(.+?)(?:\n|Area|Reviewed)/i, /Filled\s*By\s+(.+?)(?:\s*\(|\n)/i]);
  info.area_manager = grab([/Area\s*Manager\s*[:\-]?\s*(.+?)(?:\n|Reviewed|Regional)/i]);
  info.reviewed_by = grab([/Reviewed\s*By\s*[:\-]?\s*(.+?)(?:\n|Regional|Current)/i, /Report\s*By\s+(.+?)(?:\n|$)/i]);
  info.visit_date = grab([/Current\s*Visit\s*Date\s*[:\-]?\s*([\d\-\/]+)/i, /Report\s*Date\s+([\d]+\s+\w+\s+\d{4})/i]);
  info.last_visit_date = grab([/Last\s*Visit\s*Date\s*[:\-]?\s*([\d\-\/]+)/i]);

  // ─── Parse Summary Table ───

  // Strategy 1: "Previous Total Score" + "Current Score" on same header line (6-column format)
  // Must run first — more specific than the generic Summary range scanner.
  for (let i = 0; i < allLines.length - 1; i++) {
    const lt = allLines[i].text;
    if (lt.includes("Previous Total Score") && lt.includes("Current Score")) {
      const valLine = allLines[i + 1].text;
      const nums = valLine.match(/[\d.]+/g);
      if (nums && nums.length >= 4) {
        info.total_score = parseFloat(nums[2]) || parseFloat(nums[0]);
        info.current_score = parseFloat(nums[3]) || 0;
        info.previous_score = parseFloat(nums[1]) || 0;
        const pctM = valLine.match(/([\d.]+)%/);
        if (pctM) info.percentage = parseFloat(pctM[1]);
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

  // Strategy 2: Find "Summary" heading → "Section Summary" range, value line with percentage
  if (info.current_score === 0) {
    let summaryIdx = -1, sectionSummaryIdx = -1;
    for (let i = 0; i < allLines.length; i++) {
      const lt = allLines[i].text.trim();
      if (/^Summary$/i.test(lt) && summaryIdx === -1) summaryIdx = i;
      if (/^Section\s*Summary$/i.test(lt)) { sectionSummaryIdx = i; break; }
    }

    if (summaryIdx >= 0) {
      const endIdx = sectionSummaryIdx > summaryIdx ? sectionSummaryIdx : Math.min(summaryIdx + 15, allLines.length);
      for (let i = summaryIdx + 1; i < endIdx; i++) {
        const lt = allLines[i].text;
        const pctMatch = lt.match(/([\d.]+)%/);
        if (!pctMatch) continue;
        const nums = lt.match(/[\d.]+/g);
        if (nums && nums.length >= 2) {
          info.previous_score = parseFloat(nums[0]) || 0;
          info.current_score = parseFloat(nums[1]) || 0;
          info.percentage = parseFloat(pctMatch[1]) || 0;
          const diffM = lt.match(/(-[\d.]+%)/);
          if (diffM) info.difference = diffM[1];
          else {
            const diffM2 = lt.match(/([\d.]+)%\s*↓/);
            if (diffM2 && parseFloat(diffM2[1]) !== info.percentage) info.difference = "-" + diffM2[1] + "%";
            else {
              const diffM3 = lt.match(/([\d.]+)%\s*↑/);
              if (diffM3 && parseFloat(diffM3[1]) !== info.percentage) info.difference = "+" + diffM3[1] + "%";
            }
          }
          for (let j = summaryIdx + 1; j < endIdx; j++) {
            if (j === i) continue;
            const tl = allLines[j].text;
            const tNums = tl.match(/[\d.]+/g);
            if (tNums && tNums.length >= 2 && !tl.includes("%")) {
              info.total_score = parseFloat(tNums[1]) || parseFloat(tNums[0]) || 0;
              break;
            }
          }
          break;
        }
      }
    }
  }

  // Strategy 3: Inline "Current Score : 189.0"
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

  // Strategy 4: "Points available" / "Percentage" format (Diamond Checklist etc.)
  if (info.current_score === 0) {
    for (let i = 0; i < allLines.length; i++) {
      const lt = allLines[i].text;
      // "Points available" followed by number on same or next line
      if (/Points\s*available/i.test(lt)) {
        const numM = lt.match(/Points\s*available\s*([\d.]+)/i);
        if (numM) info.total_score = parseFloat(numM[1]);
        else if (i + 1 < allLines.length) {
          const n = allLines[i + 1].text.match(/^([\d.]+)$/);
          if (n) info.total_score = parseFloat(n[1]);
        }
      }
      // "Earned Score" near Points available (not section level which has "Earned Score: X")
      if (/^Earned\s*Score\s+([\d.]+)$/i.test(lt)) {
        const m = lt.match(/Earned\s*Score\s+([\d.]+)/i);
        if (m) info.current_score = parseFloat(m[1]);
      }
      // "Percentage" + value
      if (/Percentage/i.test(lt)) {
        const pm = lt.match(/([\d.]+)\s*%/);
        if (pm) info.percentage = parseFloat(pm[1]);
        else if (i + 1 < allLines.length) {
          const pm2 = allLines[i + 1].text.match(/([\d.]+)\s*%/);
          if (pm2) info.percentage = parseFloat(pm2[1]);
        }
      }
    }
  }

  // Calculate percentage if missing
  if (info.percentage === 0 && info.total_score > 0 && info.current_score > 0) {
    info.percentage = Math.round((info.current_score / info.total_score) * 10000) / 100;
  }

  // ─── Build section map ───
  const sectionMap = {}; // questionId -> section name
  let currentSection = "";
  for (let idx = 0; idx < allLines.length; idx++) {
    const line = allLines[idx];
    // Section header: "2. Access Control" or "9. Safety & Security" (NOT "2.1 ...")
    const secM = line.text.match(/^(\d{1,2})\.\s+([A-Za-z].+)/);
    if (secM && !line.text.match(/^\d+\.\d+\s/)) {
      let secName = secM[2]
        .replace(/\s*(Total\s*Score|Obtained|%\s*ACH).*$/i, "")
        .trim();
      // Skip numbered list items (Critical Observations etc.) that aren't real sections.
      // Real section headers have "Total Score", "Obtained", or "% ACH" on the same line or within 3 lines
      let isRealSection = false;
      for (let j = idx; j < Math.min(idx + 3, allLines.length); j++) {
        if (/Total\s*Score|Obtained|%\s*ACH/i.test(allLines[j].text)) {
          isRealSection = true;
          break;
        }
      }
      if (!isRealSection) continue;
      // Check next line for continuation (e.g. "Merchandising", "Performance")
      if (idx + 1 < allLines.length) {
        const nextLine = allLines[idx + 1].text.trim();
        // Continuation if it's a short word not matching score/data patterns
        if (nextLine.length > 2 && nextLine.length < 40 &&
            !/Total\s*Score|Obtained|%\s*ACH|^\d+[\.\s%]|Maximum|Earned|Deducted/i.test(nextLine) &&
            !/^\d{1,2}\.\d{1,2}\s/.test(nextLine) &&
            !/^\d+\s*\/\s*\d+/.test(nextLine)) {
          secName += " " + nextLine;
        }
      }
      // Clean trailing conjunctions
      secName = secName.replace(/\s+(and|&|or)\s*$/i, "").trim();
      currentSection = secName;
    }
    // Map question IDs to section
    const qm = line.text.match(/^(\d{1,2}\.\d{1,2})\s/);
    if (qm) sectionMap[qm[1]] = currentSection;
  }

  // ─── FIND NON-COMPLIANT ITEMS ───
  // Strategy: scan each line starting with X.Y. If obtained < max in score → NC found.
  // Handles: "No 0/3", "Poor 0/10", "Average 2/5", "Good 3/5", "Good 7/10" etc.
  const nonCompliances = [];

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    const lineText = line.text;

    // Check if this line has a question number (X.Y pattern)
    const qMatch = lineText.match(/^(\d{1,2}\.\d{1,2})\s+(.+)/);
    if (!qMatch) continue;

    const qId = qMatch[1];
    const restOfLine = qMatch[2];

    // Find score on this line or next few lines
    let obtainedPts = -1, maxPts = -1, scoreLineIdx = -1;

    // Check this line for score
    const scoreThisLine = lineText.match(/(\d+)\s*\/\s*(\d+)/);
    if (scoreThisLine) {
      obtainedPts = parseInt(scoreThisLine[1]);
      maxPts = parseInt(scoreThisLine[2]);
      scoreLineIdx = i;
    }

    // Check next few lines for score (multi-line questions)
    if (maxPts < 0) {
      for (let j = i + 1; j <= Math.min(i + 4, allLines.length - 1); j++) {
        const nextText = allLines[j].text;
        // Stop if we hit another X.Y question
        if (nextText.match(/^\d{1,2}\.\d{1,2}\s/)) break;
        const scoreNext = nextText.match(/(\d+)\s*\/\s*(\d+)/);
        if (scoreNext) {
          obtainedPts = parseInt(scoreNext[1]);
          maxPts = parseInt(scoreNext[2]);
          scoreLineIdx = j;
          break;
        }
      }
    }

    // Skip if no score found, or full marks (no points lost)
    if (maxPts <= 0 || obtainedPts >= maxPts) continue;

    // Also skip if this is just "No" answer on a Yes/No question but has no score
    // (already handled above since maxPts would be <= 0)

    // Build full question text
    let questionText = restOfLine;
    // Strip rating words, answer words, and score from the question line
    questionText = questionText
      .replace(/\s+(No|Poor|Average|Good|Excellent)\s+\d+\s*\/\s*\d+.*$/i, "")
      .replace(/\s+(No|Poor|Average|Good|Excellent)\s*$/i, "")
      .replace(/\s+No\s+\d+\s*\/\s*\d+.*$/, "")
      .replace(/\s+No\s*$/, "")
      .replace(/\s+\d+\s*\/\s*\d+.*$/, "")
      .trim();

    // Collect continuation lines between question and score line (or after score line)
    const afterIdx = scoreLineIdx > i ? scoreLineIdx : i;
    let contEndIdx = afterIdx;
    for (let j = (scoreLineIdx > i ? i + 1 : afterIdx + 1); j < Math.min(afterIdx + 5, allLines.length); j++) {
      if (j === scoreLineIdx) continue; // skip the score line itself
      const lt = allLines[j].text;
      // Stop if next question, section, answer+score line, score header, or Comments
      if (lt.match(/^\d{1,2}\.\d{1,2}\s/) || lt.match(/^\d{1,2}\.\s+[A-Z]/) ||
          lt.match(/\b(Yes|No|Poor|Average|Good|Excellent)\b.*\d+\s*\/\s*\d+/) || lt.match(/^Total\s*Score/i) ||
          lt.match(/^%\s*ACH/i) || lt.match(/^Obtained/i) || lt.match(/^Comments:/i)) break;
      if (lt.match(/^\d+\s*\/\s*\d+$/) || lt.match(/^\d+\.?\d*%$/)) { contEndIdx = j; continue; }
      if (lt.length > 3 && lt.length < 200 && j <= scoreLineIdx) {
        // Only append pre-score lines as question continuation
        questionText += " " + lt;
        contEndIdx = j;
      }
    }
    // Also grab continuation lines AFTER the score line (for multi-line questions where score is mid-line)
    if (scoreLineIdx > i) {
      // Check lines between question start and score line
      for (let j = i + 1; j < scoreLineIdx; j++) {
        const lt = allLines[j].text;
        if (lt.match(/^\d{1,2}\.\d{1,2}\s/) || lt.match(/^Comments:/i)) break;
        if (lt.match(/\b(Yes|No|Poor|Average|Good|Excellent)\b.*\d+\s*\/\s*\d+/)) break;
        if (lt.length > 3 && lt.length < 200 && !lt.match(/^\d+\s*\/\s*\d+$/)) {
          questionText += " " + lt;
        }
      }
    }
    // Check line right after score for question text continuation (e.g. "Service for OTC and Non-Pharma Products)")
    const lineAfterScore = scoreLineIdx + 1 < allLines.length ? allLines[scoreLineIdx + 1].text : "";
    if (lineAfterScore.length > 3 && lineAfterScore.length < 200 &&
        !lineAfterScore.match(/^\d{1,2}[\.\s]/) && !lineAfterScore.match(/^Comments/i) &&
        !lineAfterScore.match(/^Total\s*Score/i) && !lineAfterScore.match(/\d+\s*\/\s*\d+/) &&
        !lineAfterScore.match(/^\d+\.?\d*%$/) &&
        // Heuristic: continuation lines are short and don't start with "-" (comment bullet)
        !lineAfterScore.startsWith("-") && lineAfterScore.length < 80) {
      questionText += " " + lineAfterScore;
      contEndIdx = scoreLineIdx + 1;
    }
    questionText = questionText.replace(/\s+/g, " ").trim();

    // Collect auditor comments
    const commentStartIdx = Math.max(contEndIdx, scoreLineIdx) + 1;
    const commentParts = [];
    for (let j = commentStartIdx; j < Math.min(commentStartIdx + 20, allLines.length); j++) {
      const lt = allLines[j].text;
      // Stop at next question or section header
      if (lt.match(/^\d{1,2}\.\d{1,2}\s/) || lt.match(/^\d{1,2}\.\s+[A-Z]/) ||
          lt.match(/\b(Yes|No|Poor|Average|Good|Excellent)\b.*\d+\s*\/\s*\d+/) || lt.match(/^Total\s*Score/i) ||
          lt.match(/^%\s*ACH/i) || lt.match(/^Obtained/i)) break;
      // Skip pure score lines
      if (lt.match(/^\d+\s*\/\s*\d+$/) || lt.match(/^\d+\.?\d*%$/)) continue;
      // Handle "Comments:" prefix — strip it
      if (/^Comments:\s*/i.test(lt)) {
        const afterPrefix = lt.replace(/^Comments:\s*/i, "").trim();
        if (afterPrefix.length > 2) commentParts.push(afterPrefix);
        continue;
      }
      if (/Comments:\s*-/i.test(lt)) {
        const afterPrefix = lt.replace(/.*Comments:\s*/i, "").trim();
        if (afterPrefix.length > 2) commentParts.push(afterPrefix);
        continue;
      }
      if (lt.length > 3) commentParts.push(lt);
    }
    let comment = commentParts.join(" ").trim();
    if (comment.length > 300) comment = comment.substring(0, 297) + "...";

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

  // ─── PASS 2: Un-numbered questions (Diamond Checklist format) ───
  // If first pass found nothing, scan for 0/X (X>0) patterns
  if (nonCompliances.length === 0) {
    // Build section map from "Maximum Score:" proximity
    const sections = [];
    for (let i = 0; i < allLines.length; i++) {
      if (/Maximum\s*Score/i.test(allLines[i].text)) {
        // Section name is within +1 to +6 lines AFTER Maximum Score
        for (let j = i + 1; j < Math.min(allLines.length, i + 7); j++) {
          const lt = allLines[j].text.trim();
          // Section name: not a score/stat line, not a question, reasonably short
          if (lt.length > 3 && lt.length < 80 &&
              !/Maximum|Total\s*Score|Earned|Deducted|^\d|^Non$|Compliant|^0%|^\d+%/i.test(lt) &&
              !/Process\s*Name|Overall\s*Report|Reference|Author|Filled|Report/i.test(lt) &&
              !/^(Is |Are |How |Do |Does |Who |Please |If )/i.test(lt) &&
              !/\d+\s*\/\s*\d+/.test(lt)) {
            sections.push({ name: lt, lineIdx: i });
            break;
          }
        }
      }
    }

    // Find current section for a given line index
    const getSectionForLine = (idx) => {
      let best = "";
      for (const s of sections) {
        if (s.lineIdx <= idx) best = s.name;
      }
      return best;
    };

    // Scan for "0/X" where X > 0
    let ncCount = 0;
    for (let i = 0; i < allLines.length; i++) {
      const lt = allLines[i].text;
      const scoreM = lt.match(/\b0\s*\/\s*(\d+)/);
      if (!scoreM) continue;
      const maxPts = parseInt(scoreM[1]);
      if (maxPts === 0) continue; // 0/0 is informational, skip

      // Trace back to find question text
      let questionParts = [];
      let questionStartIdx = i;
      const sectionNames = new Set(sections.map(s => s.name));

      // Check if question is on the same line (before the score)
      const beforeScore = lt.replace(/\b0\s*\/\s*\d+.*$/, "").trim();
      // Remove answer words from end
      const cleaned = beforeScore.replace(/\s+(Yes|No|NA|Occasionally|Fully\s+\w+|Most\s+of\s+the\s+Time|Daily|Bi-weekly|User-Friendly|Meeting\s+Expectations|Highly\s+Effective|Store\s+\S+(\s+\S+)?|Fully\s+Aligned)\s*$/i, "").trim();
      
      if (cleaned.length > 10) {
        questionParts.push(cleaned);
      }

      // Look at previous lines for question continuation (backwards)
      if (questionParts.length === 0 || cleaned.length < 30) {
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          const prev = allLines[j].text.trim();
          // Stop at section headers, score headers, other scores, section names
          if (/Maximum\s*Score|Total\s*Score|Earned\s*Score|Deducted\s*Score/i.test(prev)) break;
          if (/^\d+%$|^Non$|^Compliant$|^0%$/i.test(prev)) break;
          if (/\b\d+\s*\/\s*\d+\b/.test(prev) && j < i - 1) break;
          if (sectionNames.has(prev)) break;
          if (/^(If |Comments:)/i.test(prev)) break;
          if (/Comments:/i.test(prev)) break; // Comments anywhere in line
          if (prev.includes("_%")) continue; // Skip sub-question prompts with _%
          if (prev.length > 3 && prev.length < 200) {
            questionParts.unshift(prev);
            questionStartIdx = j;
          }
        }
      }

      // Also check lines after for question continuation
      for (let j = i + 1; j < Math.min(i + 6, allLines.length); j++) {
        const next = allLines[j].text.trim();
        if (/^\d{1,2}\.\d|Maximum\s*Score|Total\s*Score|Earned\s*Score/i.test(next)) break;
        if (/^Comments:/i.test(next)) break;
        // Skip sub-question prompts ("If no, ...", "If yes, ...")
        if (/^If\s+(no|yes)/i.test(next)) continue;
        // Skip lines with their own scores (but not the one we found)
        if (/\b\d+\s*\/\s*\d+\b/.test(next) && j > i) continue;
        // Question continuation: short text, often ends with ? or is a wrap
        if (next.length > 2 && next.length < 100 && !next.includes("_%")) {
          // Check it looks like question text (starts lowercase or ends with ?)
          if (next.endsWith("?") || /^[a-z]/.test(next)) {
            questionParts.push(next);
          }
        }
      }

      // Clean up: deduplicate overlapping words at boundaries
      let question = questionParts.join(" ").replace(/\s+/g, " ").trim();
      // Remove duplicated word sequences at join boundaries
      question = question.replace(/\b(\w+(?:\s+\w+)?)\s+\1\b/gi, "$1");
      // Strip sub-prompts ("If yes, ...", "If no, ...") and everything after
      question = question.replace(/\s*If\s+(yes|no),?\s+.*/i, "").trim();
      // Strip inline answer content after ::
      question = question.replace(/\s*::.*$/i, "").trim();
      // Extract and strip any "Comments: ..." that leaked into question text
      const commentInQ = question.match(/\s*Comments?:\s*(.+)/i);
      if (commentInQ) {
        question = question.replace(/\s*Comments?:\s*.+/i, "").trim();
      }
      if (!question || question.length < 5) continue;

      // Extract comments nearby — scan further (up to 8 lines)
      let comment = commentInQ ? commentInQ[1].trim() : "";
      if (!comment) {
        for (let j = i + 1; j < Math.min(i + 8, allLines.length); j++) {
          const lt2 = allLines[j].text.trim();
          // Inline comment pattern: "...:: Some answer text"
          const inlineM = lt2.match(/::\s*(.+)/);
          if (inlineM) {
            comment = inlineM[1].trim();
            // Check next line for continuation
            if (j + 1 < allLines.length && !allLines[j+1].text.match(/^\d|Maximum|Total|Earned|^Comments|^Are |^Is |^Do |^How |^Who /i)) {
              comment += " " + allLines[j+1].text.trim();
            }
            break;
          }
          if (/^Comments?:\s*(.+)/i.test(lt2)) {
            comment = lt2.replace(/^Comments?:\s*/i, "").trim();
            // Check next line for continuation
            if (j + 1 < allLines.length && !allLines[j+1].text.match(/^\d|Maximum|Total|Earned|^Comments|^Are |^Is |^Do |^How |^Who /i)) {
              comment += " " + allLines[j+1].text.trim();
            }
            break;
          }
          if (/Maximum\s*Score|Total\s*Score/i.test(lt2)) break;
        }
      }

      ncCount++;
      const section = getSectionForLine(i);
      nonCompliances.push({
        id: String(ncCount),
        section,
        question,
        points_lost: maxPts,
        max_points: maxPts,
        section_obtained: 0,
        section_total: 0,
        section_percentage: 0,
        auditor_comments: comment,
        page: allLines[i].page,
        y_position: allLines[i].y,
      });
    }
  }

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
    const hasPrev = info.previous_score > 0;
    const scores = [
      {l:"Current Score",v:`${info.percentage}%`,c:(info.percentage||0)>=90?"#059669":"#dc2626"},
    ];
    if (hasPrev) {
      scores.push({l:"Previous",v:`${info.total_score > 0 ? Math.round((info.previous_score/info.total_score)*10000)/100 : 0}%`,c:"#111827"});
      scores.push({l:"Difference",v:info.difference||"—",c:String(info.difference).startsWith("-")?"#dc2626":"#059669"});
    }

    const cellWidth = Math.floor(100 / scores.length);
    const scoresCells = scores.map(s =>
      `<td style="width:${cellWidth}%;text-align:center;padding:14px 8px;background:#f9fafb;border:1px solid #e5e7eb;">
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
            <div style={{...S.sGrid, gridTemplateColumns:`repeat(${info.previous_score > 0 ? 3 : 1},1fr)`}}>
              {[
                {l:"Current Score",v:`${info.percentage}%`,c:(info.percentage||0)>=90?"#059669":"#dc2626"},
                ...(info.previous_score > 0 ? [
                  {l:"Previous",v:`${info.total_score > 0 ? Math.round((info.previous_score/info.total_score)*10000)/100 : 0}%`,c:"#111827"},
                  {l:"Difference",v:info.difference||"—",c:String(info.difference).startsWith("-")?"#dc2626":"#059669"},
                ] : []),
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

  sGrid:{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,margin:"20px 0 28px"},
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
