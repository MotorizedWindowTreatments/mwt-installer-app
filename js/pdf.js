/* ============================================================
   MWT Installer Order Manager - pdf.js
   Builds a readable PDF from a job + its form schema.
   Labels and answers are always kept on the same line, e.g.
   "Tall Ladder / Concrete / Remove: 12 / 2 / 15" - never split
   across the page the way the old website PDFs were.
   ============================================================ */

async function buildJobPdfBlob(job, schema, opts) {
  opts = opts || {};
  const isLargeMode = !!opts.largePhotoMode;
  const totalImages = opts.totalImageCount || 0;
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  let processedImages = 0;

  const { jsPDF } = window.jspdf;
  const wide = schema.lineItems && schema.lineItems.columns.length > 8;
  const doc = new jsPDF({ orientation: wide ? "landscape" : "portrait", unit: "pt", format: "letter" });

  const marginX = 36;
  let y = 40;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  function ensureSpace(h) {
    if (y + h > pageHeight - 50) {
      doc.addPage();
      y = 40;
    }
  }

  // Renders exactly one photo at position (x, y) - shared by both the
  // per-line PROJECT PHOTOS section and the ATTACHED JOB PHOTOS
  // section below. In large-photo-job mode, a TEMPORARY, in-memory-only
  // resized/recompressed copy of this one image is what actually gets
  // handed to addImage() - the original dataURL (row.photos[].dataUrl
  // or job.attachments[].dataUrl, i.e. the installer's saved data) is
  // only ever read here, never mutated, and the temporary optimized
  // copy is discarded immediately after this single call - no array of
  // optimized copies is ever built up. For a normal (non-large-mode)
  // job, the original dataURL is passed straight through exactly as
  // before, byte-for-byte identical to current production behavior.
  async function renderPhotoImage(dataUrl, x, y, thumbW, thumbH) {
    let toRender = dataUrl;
    if (isLargeMode) {
      try {
        toRender = await compressDataUrlForPdf(dataUrl, LARGE_PHOTO_PDF_MAX_DIM, LARGE_PHOTO_PDF_QUALITY);
      } catch (e) {
        // Optimization failed for this one image only - safely fall
        // back to the original dataURL rather than losing the photo or
        // failing the whole PDF over it. The existing addImage()
        // fallback below still applies on top of this if even that
        // fails.
        toRender = dataUrl;
      }
    }
    try {
      doc.addImage(toRender, undefined, x, y, thumbW, thumbH, undefined, "FAST");
    } catch (e) {
      doc.rect(x, y, thumbW, thumbH);
      doc.setFontSize(8);
      doc.text("Could not preview", x + 8, y + thumbH / 2);
    }
    toRender = null; // release the temporary optimized copy immediately
    processedImages++;
    if (onProgress) onProgress(processedImages, totalImages);
    // Yielding only happens in large-photo mode - a normal job's
    // generation timing/behavior is otherwise unaffected.
    if (isLargeMode) await yieldToEventLoop();
  }

  function drawHeader() {
    doc.setFillColor(22, 35, 63); // navy
    doc.rect(0, 0, pageWidth, 54, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("Motorized Window Treatments", marginX, 22);
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.text(schema.pdfTitle, marginX, 40);

    doc.setFontSize(10);
    const rightLines = [
      "MWT Project #: " + (job.projectNumber || "\u2014"),
      "Status: " + job.status.toUpperCase(),
      "Generated: " + new Date().toLocaleString()
    ];
    rightLines.forEach((line, i) => {
      doc.text(line, pageWidth - marginX, 16 + i * 12, { align: "right" });
    });
    doc.setTextColor(0, 0, 0);
    y = 70;
  }

  function sectionTitle(title) {
    ensureSpace(26);
    doc.setFillColor(22, 35, 63);
    doc.rect(marginX, y, pageWidth - marginX * 2, 18, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.text(title.toUpperCase(), marginX + 6, y + 13);
    doc.setTextColor(0, 0, 0);
    y += 26;
  }

  // Label: value, wrapped, kept together so the answer is never far
  // from its label (this was the #1 complaint about the old PDFs).
  function labelValueLine(label, value) {
    const text = label + ": " + (value && value.toString().trim() ? value : "\u2014");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    const usableWidth = pageWidth - marginX * 2;
    const lines = doc.splitTextToSize(text, usableWidth);
    ensureSpace(lines.length * 12 + 4);
    lines.forEach((line, i) => {
      if (i === 0) {
        // bold the label portion
        const labelPart = label + ": ";
        doc.setFont("helvetica", "bold");
        doc.text(labelPart, marginX, y);
        const labelWidth = doc.getTextWidth(labelPart);
        doc.setFont("helvetica", "normal");
        doc.text(line.slice(labelPart.length), marginX + labelWidth, y);
      } else {
        doc.text(line, marginX, y);
      }
      y += 12;
    });
    y += 2;
  }

  function fieldGridBlock(fieldDefs, valuesObj) {
    fieldDefs.forEach((f) => {
      if (f.type === "textarea") {
        labelValueLine(f.label, valuesObj[f.id]);
      } else {
        labelValueLine(f.label, valuesObj[f.id]);
      }
    });
  }

  // Compact label:value renderer used by the condensed page-1 layout -
  // smaller font, caller-supplied width/position, returns the height used
  // so callers can lay multiple columns/rows side by side.
  function compactLabelValue(x, yPos, maxWidth, label, value) {
    const text = label + ": " + (value && value.toString().trim() ? value : "\u2014");
    const labelPart = label + ": ";
    doc.setFontSize(7.6);
    const lines = doc.splitTextToSize(text, maxWidth);
    lines.forEach((line, i) => {
      const lineY = yPos + i * 9.2;
      if (i === 0) {
        doc.setFont("helvetica", "bold");
        doc.text(labelPart, x, lineY);
        const lw = doc.getTextWidth(labelPart);
        doc.setFont("helvetica", "normal");
        doc.text(line.slice(labelPart.length), x + lw, lineY);
      } else {
        doc.setFont("helvetica", "normal");
        doc.text(line, x, lineY);
      }
    });
    return lines.length * 9.2;
  }

  // Condensed two-per-row layout for short fields (used for Measure/Service
  // Details and Installer Notes on page 1) - textarea fields always get
  // their own full-width row since notes can run long.
  function twoColumnFieldGrid(fieldDefs, valuesObj) {
    const colWidth = (pageWidth - marginX * 2 - 14) / 2;
    let i = 0;
    while (i < fieldDefs.length) {
      const f1 = fieldDefs[i];
      if (f1.type === "textarea") {
        labelValueLine(f1.label, valuesObj[f1.id]);
        i += 1;
        continue;
      }
      const f2 = (i + 1 < fieldDefs.length && fieldDefs[i + 1].type !== "textarea") ? fieldDefs[i + 1] : null;
      ensureSpace(24);
      const h1 = compactLabelValue(marginX, y, colWidth, f1.label, valuesObj[f1.id]);
      const h2 = f2 ? compactLabelValue(marginX + colWidth + 14, y, colWidth, f2.label, valuesObj[f2.id]) : 0;
      y += Math.max(h1, h2) + 3;
      i += f2 ? 2 : 1;
    }
  }

  // Sold To / Bill To, Project Information, and the fixed Ship To Location
  // rendered as three side-by-side columns so all of this introductory
  // information stays together on page 1, per Matthew's request - it never
  // spills onto page 2 even though the line-item table that follows is
  // often very tall.
  function threeColumnIntro(soldToSection, projectInfoSection) {
    const gap = 12;
    const colWidth = (pageWidth - marginX * 2 - gap * 2) / 3;
    const startY = y;
    let maxH = 0;

    function renderColumn(x, title, rows) {
      let cy = startY;
      doc.setFillColor(22, 35, 63);
      doc.rect(x, cy, colWidth, 16, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.text(title.toUpperCase(), x + 4, cy + 11);
      doc.setTextColor(0, 0, 0);
      cy += 24;
      rows.forEach(([label, value]) => {
        const h = compactLabelValue(x + 2, cy, colWidth - 4, label, value);
        cy += h + 2;
      });
      maxH = Math.max(maxH, cy - startY);
    }

    const soldToRows = soldToSection.fields.map((f) => [f.label, job.fields[f.id]]);
    const projRows = projectInfoSection.fields.map((f) => [f.label, job.fields[f.id]]);
    const s = MWT_CONFIG.shipTo;
    const shipRows = [
      ["Company Name", s.companyName],
      ["Contact", s.contact],
      ["Street", s.street],
      ["City/State/Zip", s.cityStateZip],
      ["Phone", s.phone],
      ["Shipping Notes", s.shippingNotes]
    ];

    renderColumn(marginX, soldToSection.title, soldToRows);
    renderColumn(marginX + colWidth + gap, projectInfoSection.title, projRows);
    renderColumn(marginX + (colWidth + gap) * 2, "Ship To Location", shipRows);

    y = startY + maxH + 12;
  }

  drawHeader();

  if (schema.mainHeaderTitle) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(schema.mainHeaderTitle, marginX, y);
    y += 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(MWT_CONFIG.companyPhone + "  \u00b7  " + MWT_CONFIG.shipTo.companyName, marginX, y);
    y += 14;
  }

  // Job identity
  labelValueLine("Job Name", computeDisplayName(job));
  labelValueLine("Created", new Date(job.createdAt).toLocaleString());
  if (job.submittedAt) labelValueLine("Submitted", new Date(job.submittedAt).toLocaleString());
  y += 4;

  // Sections - Sold To/Bill To and Project Information (when present) are
  // pulled out to render together with Ship To as three compact columns
  // below; everything else (Measure/Service Details, Installer Notes, or
  // any form-specific section like Service's Designer & End-User info)
  // renders in reading order first, condensed where it's just short
  // fields, so the whole introductory block fits on page 1.
  const soldToSection = schema.sections.find((s) => s.title === "Sold To / Bill To");
  const projectInfoSection = schema.sections.find((s) => s.title === "Project Information");
  const otherSections = schema.sections.filter((s) => s !== soldToSection && s !== projectInfoSection);

  otherSections.forEach((section) => {
    sectionTitle(section.title);
    if (section.title === "Installer Notes Section" || section.title === "Measure / Service Details") {
      twoColumnFieldGrid(section.fields, job.fields);
    } else {
      fieldGridBlock(section.fields, job.fields);
    }
  });

  if (soldToSection && projectInfoSection) {
    threeColumnIntro(soldToSection, projectInfoSection);
  } else {
    if (soldToSection) { sectionTitle(soldToSection.title); fieldGridBlock(soldToSection.fields, job.fields); }
    if (projectInfoSection) { sectionTitle(projectInfoSection.title); fieldGridBlock(projectInfoSection.fields, job.fields); }
    sectionTitle("Ship To Location");
    const s = MWT_CONFIG.shipTo;
    labelValueLine("Company Name", s.companyName);
    labelValueLine("Contact", s.contact);
    labelValueLine("Street", s.street);
    labelValueLine("City/State/Zip", s.cityStateZip);
    labelValueLine("Phone", s.phone);
    labelValueLine("Shipping Notes", s.shippingNotes);
  }


  // Service-request specific extras
  if (schema.requestTypeField) {
    sectionTitle("Request Type");
    const sel = (job.fields[schema.requestTypeField.id] || "").split("|||").filter(Boolean);
    labelValueLine(schema.requestTypeField.label, sel.length ? sel.join(", ") : "\u2014");
  }
  if (schema.fields) {
    sectionTitle("Service Details");
    schema.fields.forEach((f) => {
      if (f.type === "checkbox-group") {
        const sel = (job.fields[f.id] || "").split("|||").filter(Boolean);
        labelValueLine(f.label, sel.length ? sel.join(", ") : "\u2014");
      } else if (f.type === "yesno-count") {
        const [yn, count] = (job.fields[f.id] || "").split("|||");
        labelValueLine(f.label, yn ? yn + (count ? " (" + count + ")" : "") : "\u2014");
      } else {
        labelValueLine(f.label, job.fields[f.id]);
      }
    });
  }

  // Line items table
  if (schema.lineItems && job.lineItems && job.lineItems.length) {
    sectionTitle(schema.lineItems.title);
    const cols = schema.lineItems.columns;
    const head = [["#", ...cols.map((c) => c.label), ...(schema.lineItems.hasPhotoColumn ? ["Photo"] : [])]];
    const bodyRows = job.lineItems.map((row, i) => [
      String(i + 1),
      ...cols.map((c) => row[c.id] || ""),
      ...(schema.lineItems.hasPhotoColumn
        ? [(row.photos && row.photos.length) ? row.photos.length + " photo" + (row.photos.length === 1 ? "" : "s") : "\u2014"]
        : [])
    ]);
    doc.autoTable({
      startY: y,
      head,
      body: bodyRows,
      margin: { left: marginX, right: marginX },
      styles: { fontSize: 7.5, cellPadding: 3, overflow: "linebreak" },
      headStyles: { fillColor: [192, 57, 43], textColor: 255, fontSize: 7.5 },
      theme: "grid",
      didDrawPage: () => {}
    });
    y = doc.lastAutoTable.finalY + 16;
  }

  // Attachments (general job-level files, unrelated to specific line
  // items) - text listing only. The actual photo/image is intentionally
  // NOT rendered here: any image among these general attachments (and
  // every per-line-item photo) already appears, once, in the dedicated
  // PROJECT PHOTOS section further down. Rendering an image here too
  // used to duplicate it and also left a stray page/cursor position that
  // Motorization Control Devices would then get drawn on top of.
  if (job.attachments && job.attachments.length) {
    sectionTitle("Photos / Files Attached to This Job (" + job.attachments.length + ")");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    job.attachments.forEach((a) => {
      labelValueLine(a.type && a.type.startsWith("image/") ? "Photo" : "File", a.name + " (" + Math.round((a.size || 0) / 1024) + " KB)");
    });
  }

  // Motorization control devices
  if (schema.motorizationControlDevices) {
    sectionTitle(schema.motorizationControlDevices.title);
    fieldGridBlock(schema.motorizationControlDevices.fields, job.motorization || {});
  }

  // Additional notes
  sectionTitle(schema.additionalNotesLabel || "Additional Notes");
  const notesText = job.fields.__additionalNotes && job.fields.__additionalNotes.trim() ? job.fields.__additionalNotes : "\u2014";
  const noteLines = doc.splitTextToSize(notesText, pageWidth - marginX * 2);
  ensureSpace(noteLines.length * 12 + 6);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.text(noteLines, marginX, y);
  y += noteLines.length * 12 + 10;

  // Project Photos - per-line-item photos, clearly labeled by line/room/product
  // so the designer immediately knows which window each photo belongs to.
  if (schema.lineItems && schema.lineItems.hasPhotoColumn) {
    const rowsWithPhotos = (job.lineItems || []).filter((r) => r.photos && r.photos.length);
    if (rowsWithPhotos.length) {
      doc.addPage(wide ? "landscape" : "portrait");
      y = 40;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.text("PROJECT PHOTOS", marginX, y);
      y += 20;

      const thumbW = wide ? 220 : 170;
      const thumbH = wide ? 165 : 130;
      const gap = 14;

      for (let idx = 0; idx < job.lineItems.length; idx++) {
        const row = job.lineItems[idx];
        const photos = row.photos || [];
        if (!photos.length) continue;

        ensureSpace(thumbH + 40);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        const heading = "LINE " + (idx + 1) + " \u2014 " + (row.room || "\u2014") + (row.productName ? " \u2014 " + row.productName : "");
        doc.text(heading, marginX, y);
        y += 16;

        let x = marginX;
        for (const p of photos) {
          if (x + thumbW > pageWidth - marginX) { x = marginX; y += thumbH + 22; }
          if (y + thumbH + 22 > pageHeight - 30) { doc.addPage(wide ? "landscape" : "portrait"); y = 40; x = marginX; }
          await renderPhotoImage(p.dataUrl, x, y, thumbW, thumbH);
          x += thumbW + gap;
        }
        y += thumbH + 28;
      }
    }
  }

  // ATTACHED JOB PHOTOS - actual images from the general job-level
  // attachments (the "Photos / Files Attached to This Job" list above
  // is text-only by design; this is where any IMAGE among those
  // attachments is actually rendered visually, exactly once). Placed
  // here, after Project Photos and all normal form content, on its own
  // fresh page so it can never overlap Motorization Control Devices,
  // notes, tables, or the per-line Project Photos section above.
  // PDFs/MOV/MP4/other non-image attachments are never embedded here -
  // they remain listed as text only, exactly as before.
  const attachmentImages = (job.attachments || []).filter((a) => a.type && a.type.startsWith("image/"));
  if (attachmentImages.length) {
    doc.addPage(wide ? "landscape" : "portrait");
    y = 40;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("ATTACHED JOB PHOTOS", marginX, y);
    y += 20;

    const thumbW = wide ? 220 : 170;
    const thumbH = wide ? 165 : 130;
    const gap = 14;
    let x = marginX;

    for (const a of attachmentImages) {
      if (x + thumbW > pageWidth - marginX) { x = marginX; y += thumbH + 22; }
      if (y + thumbH + 22 > pageHeight - 30) { doc.addPage(wide ? "landscape" : "portrait"); y = 40; x = marginX; }
      await renderPhotoImage(a.dataUrl, x, y, thumbW, thumbH);
      // Filename caption directly under each thumbnail, where practical
      // (truncated to fit the thumbnail's own width so it never runs
      // into the next photo).
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      const captionLines = doc.splitTextToSize(a.name || "", thumbW);
      doc.text(captionLines[0] || "", x, y + thumbH + 10);
      x += thumbW + gap;
    }
    y += thumbH + 28;
  }

  // Footer note + page numbers on every page
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(7.5);
    doc.setTextColor(110, 110, 110);
    if (schema.footerNote) {
      doc.text(doc.splitTextToSize(schema.footerNote, pageWidth - marginX * 2), marginX, pageHeight - 22);
    }
    doc.text("Page " + i + " of " + pageCount, pageWidth - marginX, pageHeight - 10, { align: "right" });
    doc.setTextColor(0, 0, 0);
  }

  return doc.output("blob");
}

// ---------------------------------------------------------------
// Weekly Itinerary PDF - entirely separate from buildJobPdfBlob() above
// (its own local helpers, does not call or modify anything in that
// function). Professional layout, not a redraw of the Excel sheet.
// ---------------------------------------------------------------
function buildItineraryPdfBlob(itinerary, opts) {
  opts = opts || {};
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });

  const marginX = 36;
  let y = 40;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  function ensureSpace(h) {
    if (y + h > pageHeight - 50) {
      doc.addPage();
      y = 40;
    }
  }

  function sectionTitle(title) {
    ensureSpace(24);
    doc.setFillColor(22, 35, 63);
    doc.rect(marginX, y, pageWidth - marginX * 2, 18, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.text(title.toUpperCase(), marginX + 6, y + 13);
    doc.setTextColor(0, 0, 0);
    // Bar itself is 18pt tall; advancing by 32 (rather than 24) leaves
    // ~14pt of clear space below the bar before the next line (Start /
    // Finish / Hours for a day header, or the summary table) instead of
    // the previous ~6pt, which read as touching/overlapping the header.
    y += 32;
  }

  function labelValueLine(label, value) {
    const text = label + ": " + (value !== undefined && value !== null && String(value).trim() ? value : "\u2014");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    const usableWidth = pageWidth - marginX * 2;
    const lines = doc.splitTextToSize(text, usableWidth);
    ensureSpace(lines.length * 12 + 4);
    lines.forEach((line, i) => {
      if (i === 0) {
        const labelPart = label + ": ";
        doc.setFont("helvetica", "bold");
        doc.text(labelPart, marginX, y);
        const labelWidth = doc.getTextWidth(labelPart);
        doc.setFont("helvetica", "normal");
        doc.text(line.slice(labelPart.length), marginX + labelWidth, y);
      } else {
        doc.text(line, marginX, y);
      }
      y += 12;
    });
    y += 2;
  }

  const installerName = itineraryInstallerName(itinerary) || "\u2014";
  const weekRangeText = itnFormatWeekRangeSpaced(itinerary.weekStart);

  // Header
  doc.setFillColor(22, 35, 63);
  doc.rect(0, 0, pageWidth, 54, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Motorized Window Treatments", marginX, 22);
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.text("Weekly Itinerary", marginX, 40);
  doc.setFontSize(10);
  const rightLines = [
    // The PDF generated specifically for a successful submission passes
    // opts.statusOverride ("SUBMITTED") explicitly, since at PDF-build
    // time the local record's own status is still "draft"/"ready" - it
    // only flips to "submitted" after the backend confirms success,
    // which must happen after the PDF (and therefore the email) is
    // already on its way. Preview PDF (no override) still shows the
    // record's real current status, which is the useful/expected thing
    // there.
    "Status: " + (opts.statusOverride || itinerary.status.toUpperCase()),
    "Generated: " + new Date().toLocaleString()
  ];
  rightLines.forEach((line, i) => {
    doc.text(line, pageWidth - marginX, 16 + i * 12, { align: "right" });
  });
  doc.setTextColor(0, 0, 0);
  y = 70;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Installer: " + installerName, marginX, y);
  y += 18;
  doc.setFontSize(12);
  doc.text("Week: " + weekRangeText, marginX, y);
  y += 20;

  // Each day
  ITINERARY_DAY_KEYS.forEach((dayKey, idx) => {
    const day = itinerary.days[dayKey];
    const dateLabel = itnFormatDayTabLabel(dayKey, itinerary.weekStart);
    sectionTitle(ITINERARY_DAY_FULL_LABELS[dayKey] + " \u00b7 " + dateLabel);

    const hoursResult = itnComputeDayHours(day);
    const hoursText = hoursResult.error ? hoursResult.error : hoursResult.hours.toFixed(2) + " hrs";
    labelValueLine("Start / Finish / Hours", (day.startTime || "\u2014") + "  /  " + (day.finishTime || "\u2014") + "  /  " + hoursText);

    const jobs = (day.jobs || []).filter((j) => j.customer || j.workPerformed || j.product);
    if (jobs.length) {
      const head = [["Customer", "Work Performed", "Product"]];
      const bodyRows = jobs.map((j) => [j.customer || "\u2014", j.workPerformed || "\u2014", j.product || "\u2014"]);
      doc.autoTable({
        startY: y,
        head,
        body: bodyRows,
        margin: { left: marginX, right: marginX },
        styles: { fontSize: 9, cellPadding: 4, overflow: "linebreak" },
        headStyles: { fillColor: [192, 57, 43], textColor: 255, fontSize: 9 },
        theme: "grid"
      });
      y = doc.lastAutoTable.finalY + 8;
    } else {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(9);
      doc.setTextColor(120, 120, 120);
      ensureSpace(14);
      doc.text("No jobs logged for this day.", marginX, y);
      doc.setTextColor(0, 0, 0);
      y += 16;
    }

    const milesResult = itnComputeDayMiles(day);
    const milesText = milesResult.error ? milesResult.error : String(milesResult.miles) + " mi";
    labelValueLine(
      "Mileage",
      "Start " + (day.startMileage || "\u2014") + "  \u00b7  End " + (day.endMileage || "\u2014") + "  \u00b7  Total " + milesText
    );
    labelValueLine("Tolls / Parking & Fuel", "$" + (parseFloat(day.tolls) || 0).toFixed(2) + "  /  $" + (parseFloat(day.parkingFuel) || 0).toFixed(2));
    y += 4;
  });

  // Weekly Summary
  const totals = computeItineraryTotals(itinerary);
  sectionTitle("Weekly Summary");
  const summaryRows = [
    ["Total Hours", totals.totalHours.toFixed(2)],
    ["Installs", String(totals.installs)],
    ["Measures", String(totals.measures)],
    ["Cut-Downs / Retrofits", String(totals.cutDownRetrofits)],
    ["Service Calls", String(totals.serviceCalls)],
    ["Total Miles", totals.totalMiles.toFixed(1)],
    ["Mileage Reimbursement (@ $0.30/mi)", "$" + totals.mileageReimbursement.toFixed(2)],
    ["Parking / Fuel", "$" + totals.parkingFuel.toFixed(2)],
    ["Tolls", "$" + totals.tolls.toFixed(2)],
    ["Total Reimbursable Expenses", "$" + totals.totalReimbursable.toFixed(2)]
  ];
  doc.autoTable({
    startY: y,
    body: summaryRows,
    margin: { left: marginX, right: marginX },
    styles: { fontSize: 10, cellPadding: 5 },
    columnStyles: { 0: { fontStyle: "bold" }, 1: { halign: "right" } },
    theme: "grid"
  });
  y = doc.lastAutoTable.finalY + 10;

  // Footer + page numbers
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(7.5);
    doc.setTextColor(110, 110, 110);
    doc.text("MWT Installer \u2013 Weekly Itinerary \u2013 " + installerName + " \u2013 " + weekRangeText, marginX, pageHeight - 22);
    doc.text("Page " + i + " of " + pageCount, pageWidth - marginX, pageHeight - 10, { align: "right" });
    doc.setTextColor(0, 0, 0);
  }

  return doc.output("blob");
}
