/* ============================================================
   MWT Installer Order Manager - formSchemas.js

   Defines the fields for each MWT form. This is the single place
   to add/rename/reorder fields - the rest of the app (rendering,
   saving, PDF) reads from these schemas so you never have to
   touch app.js or pdf.js to adjust a form.

   Forms in this build: Blinds & Shades, Drapery, Service /
   Retrofit / Cut-Down. "Measure Request" has been removed
   entirely per Matthew's instruction (dashboard, sidebar, form
   schemas, routing - it no longer exists anywhere in the app).

   NOTE ON SOURCE MATERIAL:
   - Blinds & Shades is rebuilt from Matthew's complete written
     spec (the full 18-column line-item table, per-line photos,
     Ship To phone number, etc.) - this is now the authoritative
     version, superseding the earlier screenshot-only build.
   - Drapery is unchanged, built from the supplied screenshots.
   - Service / Retrofit / Cut-Down is unchanged, assembled from
     the conversation history's written requirements (no final
     screenshot was ever supplied for it) - still flagged for
     review inside the app.
   ============================================================ */

// Shared building blocks -------------------------------------------------

const MWT_SOLD_TO_BILL_TO = {
  title: "Sold To / Bill To",
  fields: [
    { id: "designFirm", label: "Design Firm", type: "text", required: true },
    { id: "contact", label: "Contact", type: "text", required: true },
    { id: "street", label: "Street", type: "text" },
    { id: "cityStateZip", label: "City/State/Zip", type: "text" },
    { id: "phone", label: "Phone", type: "text" },
    { id: "cell", label: "Cell", type: "text" },
    { id: "email", label: "Email", type: "email",
      help: "Designer/Designer's email for a copy of this submission - optional, but you'll be asked to confirm before submitting without one." }
  ]
};

const MWT_PROJECT_INFO = {
  title: "Project Information",
  fields: [
    { id: "sidemark", label: "Sidemark", type: "text", required: true },
    { id: "po", label: "P.O.", type: "text" },
    { id: "projStreet", label: "Street", type: "text", required: true },
    { id: "projCityStateZip", label: "City/State/Zip", type: "text", required: true },
    { id: "projPhone", label: "Phone", type: "text" }
  ]
};

// Ship To is fixed MWT info - rendered read-only from config, not editable per job.

const MWT_INSTALLER_NOTES = {
  title: "Installer Notes Section",
  fields: [
    { id: "tallLadderNeeded", label: "Tall Ladder Needed", type: "text" },
    { id: "tallLadderWndw", label: "# of Wndw (Tall Ladder)", type: "text" },
    { id: "concreteInstall", label: "Concrete Install", type: "text" },
    { id: "concreteWndw", label: "# of Wndw (Concrete)", type: "text" },
    { id: "treatmentsToRemove", label: "No. of treatments to remove", type: "text" },
    { id: "installerNotes", label: "Notes", type: "textarea" }
  ]
};

// Drapery's own screenshot shows a different order/label for this box than
// Blinds & Shades: Tall Ladder, Concrete, then Notes, THEN a separate
// "No. of wndw treatments to be removed" field at the very bottom.
const MWT_INSTALLER_NOTES_DRAPERY = {
  title: "Installer Notes Section",
  fields: [
    { id: "tallLadderNeeded", label: "Tall Ladder Needed", type: "text" },
    { id: "tallLadderWndw", label: "# of Wndw (Tall Ladder)", type: "text" },
    { id: "concreteInstall", label: "Concrete Install", type: "text" },
    { id: "concreteWndw", label: "# of Wndw (Concrete)", type: "text" },
    { id: "installerNotes", label: "Notes", type: "textarea" },
    { id: "wndwTreatmentsRemoved", label: "No. of wndw treatments to be removed", type: "text" }
  ]
};

const MWT_HEADER_TECH = {
  title: "Measure / Service Details",
  fields: [
    { id: "serviceTechnician", label: "Service Technician", type: "text" },
    { id: "measureWriteUpDate", label: "Measure Write Up Date", type: "date" }
  ]
};

// Shared between Blinds & Shades and Drapery so both forms collect the
// exact same Motorization Control Devices data with no risk of the two
// copies drifting apart.
const MWT_MOTORIZATION_CONTROL_DEVICES = {
  title: "Motorization Control Devices",
  fields: [
    { id: "numRemoteControls", label: "No. of remote controls", type: "number" },
    { id: "numChannelsRemote", label: "No. of channels on the remote", type: "number" },
    { id: "numWirelessWallSwitches", label: "No. of wireless wall switches", type: "number" },
    { id: "numChannelsWallSwitch", label: "No. of channels on wall switch", type: "number" },
    { id: "numSmartDevices", label: "No. of Smart Devices", type: "number" },
    { id: "numRepeaters", label: "No. of repeaters", type: "number" },
    { id: "groupedShadeTransformerType", label: "Type of grouped shade power transformer (QTY)", type: "text" }
  ]
};

// -------------------------------------------------------------------------
// 1. BLINDS & SHADES ORDER FORM
//    Rebuilt to the complete operational version per Matthew's written
//    spec (this is the priority form installers use in the field).
//    Every one of the 18 business-data columns below is required - do
//    not remove any to make the table narrower; it scrolls horizontally
//    by design.
// -------------------------------------------------------------------------
const FORM_BLINDS_SHADES = {
  id: "blinds-shades",
  label: "Blinds & Shades Order",
  shortLabel: "Blinds & Shades",
  pdfTitle: "Blinds & Shades Order Form",
  mainHeaderTitle: "Blinds & Shades Order",
  sections: [MWT_HEADER_TECH, MWT_INSTALLER_NOTES, MWT_SOLD_TO_BILL_TO, MWT_PROJECT_INFO],
  instructions:
    "PLEASE FILL IN EACH CELL FOR EACH LINE ITEM. PUT A LINE THROUGH ALL CELLS THAT DO NOT APPLY OR WRITE (DNA).",
  lineItems: {
    title: "Line Items",
    hasPhotoColumn: true,
    columns: [
      { id: "room", label: "Room", hint: "MBR, LR, DR, BR1..." },
      { id: "qty", label: "Qty" },
      { id: "productName", label: "Product Name" },
      { id: "styleOrSize", label: "Style or Size", hint: "Fabric / Cell / Slat or Vane size" },
      { id: "colorName", label: "Color Name" },
      { id: "colorNo", label: "Color No." },
      { id: "liftSystem", label: "Lift System", hint: "Std · UltraGlide · Cordless · Clutch · Motorized AC/DC · PowerView" },
      { id: "powerOptions", label: "Power Options", hint: "Batt Wand · Rechrg · Plug-In · 3-Prong · \"X\" · See Below" },
      { id: "controls", label: "Controls", hint: "Tilt (L/R) · Lift (L/R)" },
      { id: "stack", label: "Stack", hint: "Std · TDBU · TD · L · R · Split" },
      { id: "fasciaVal", label: "Fascia / Val", hint: "Std · Cassette · Round · \"L\" · Exposed Roll · Reverse Roll" },
      { id: "configuration", label: "Single / 2-on-1 / 3-on-1", type: "select",
        options: ["Single", "2-on-1", "3-on-1"] },
      { id: "mountType", label: "IB / OB / Ceiling", type: "select",
        options: ["IB", "OB", "Ceiling"] },
      { id: "returnLength", label: "Return Length" },
      { id: "mountingDepth", label: "Mounting Depth" },
      { id: "width", label: "Width" },
      { id: "length", label: "Length" }
    ],
    minRows: 1
  },
  motorizationControlDevices: MWT_MOTORIZATION_CONTROL_DEVICES,
  additionalNotesLabel: "Additional Notes",
  footerNote:
    "For all your manual or motorized blinds, shades, shutter and drapery needs. We: Measure & Install / Motorize / Cut Down & Fabricate Custom Motorized Drapery Tracks. · All line items represent windows measured from left to right for each room."
};

// -------------------------------------------------------------------------
// 2. DRAPERY ORDER / INSTALLATION FORM (from screenshots 3-7) - unchanged
// -------------------------------------------------------------------------
const FORM_DRAPERY = {
  id: "drapery",
  label: "Drapery Order",
  shortLabel: "Drapery",
  pdfTitle: "Drapery Order Form",
  sections: [MWT_HEADER_TECH, MWT_INSTALLER_NOTES_DRAPERY, MWT_SOLD_TO_BILL_TO, MWT_PROJECT_INFO],
  lineItems: {
    title: "Line Items",
    columns: [
      { id: "room", label: "Room", hint: "MBR, LR, DR, BR1..." },
      { id: "quantity", label: "Quantity" },
      { id: "pinchPleatRipplefold", label: "PinchPleat / Ripplefold", hint: "80|100|120%" },
      { id: "hardwareInfo", label: "Hardware Info", hint: "Rod / Track Info" },
      { id: "ringBracketInfo", label: "Ring & Bracket Info" },
      { id: "stack", label: "Stack", hint: "Left / Right / Split" },
      { id: "operation", label: "Operation", hint: "Cord Draw / Baton Draw / Motorized by MWT / Stationary Drapes" },
      { id: "powerOptions", label: "Power Options", hint: "Battery \"X\"" },
      { id: "rechargeable", label: "Rechargeable / Low Voltage / AC Powered", hint: "/ See Below" },
      { id: "controlSide", label: "Control Side" },
      { id: "trackOrRod", label: "Track or Rod" },
      { id: "faceWidth", label: "Face Width" },
      { id: "mount", label: "Mount", hint: "Wall / Ceiling" },
      { id: "pinSet", label: "Pin Set" },
      { id: "master", label: "Master", hint: "Overlap Length or Butt Master" },
      { id: "returnLength", label: "Return Length" },
      { id: "floorToTopOfRod", label: "Floor to top of Rod or Track" },
      { id: "draperyFinishedLength", label: "Drapery Finished Length" },
      { id: "floorToCeiling", label: "Floor to Ceiling / Crown Height" },
      { id: "spaceTrimToCeiling", label: "Space between Trim to Ceiling / Crown" }
    ],
    minRows: 1
  },
  motorizationControlDevices: MWT_MOTORIZATION_CONTROL_DEVICES,
  additionalNotesLabel: "Additional Notes",
  footerNote:
    "For all your manual or motorized blinds, shades, shutters, and drapery needs call MOTORIZED WINDOW TREATMENTS: 847-732-8552. All line items represent windows measured from left to right for each room…"
};

// -------------------------------------------------------------------------
// 3. SERVICE / RETROFIT / CUT-DOWN REQUEST - unchanged
//    Reassembled from the 03/12/2026 and 04/08/2026 written requirements.
//    No final screenshot was supplied. Please review.
// -------------------------------------------------------------------------
const FORM_SERVICE_REQUEST = {
  id: "service-request",
  label: "Service / Retrofit / Cut-Down Request",
  shortLabel: "Service / Retrofit / Cut-Down",
  pdfTitle: "Service Request Form",
  needsReview: true,
  reviewNote:
    "No final screenshot of this form was supplied - it went through many rounds of text-only change requests in the conversation history and the requirements sometimes conflicted between messages. This version follows the most recent written requirements I could find (03/12/2026 and 04/08/2026). Please review closely, especially the 'How Is The Treatment Controlled' options and the service-type order.",
  sections: [
    MWT_HEADER_TECH,
    {
      title: "Designer & End-User Information",
      fields: [
        { id: "designerFirstLast", label: "Designer's First and Last Name", type: "text", required: true },
        { id: "designerCell", label: "Designer's Cell Phone #", type: "text", required: true },
        { id: "designerEmail", label: "Designer's Email Address", type: "email",
          help: "Optional - but you'll be asked to confirm before submitting without one." },
        { id: "designerAddress", label: "Designer's Address", type: "text" },
        { id: "designerCity", label: "City", type: "text" },
        { id: "designerZip", label: "Zip Code", type: "text" },
        { id: "endUserFirstLast", label: "End-User's First & Last Name", type: "text" },
        { id: "endUserCell", label: "End-User's Cell Phone #", type: "text" }
      ]
    },
    MWT_PROJECT_INFO
  ],
  instructions:
    "ALL QUESTIONS must be answered, and pictures provided, to schedule an appointment - this only applies if the request is for Measure and Installation. For other service types, not every question needs to be answered.",
  requestTypeField: {
    id: "requestType",
    label: "What is your request for?",
    type: "checkbox-group",
    options: ["Cut Down", "Service Call", "Measure", "Installation", "Retrofit / Motorization"]
  },
  fields: [
    { id: "products", label: "What is the product(s)?", type: "text", help: "Include drapery here if applicable." },
    { id: "manufacturer", label: "Who is the manufacturer?", type: "text" },
    { id: "treatmentAge", label: "What is the approximate age of the treatment(s)?", type: "text",
      help: "For service calls or motorization retrofits only." },
    { id: "treatmentSize", label: "Approximately how large is the treatment(s)? (Width x Length)", type: "text",
      help: "For service calls or motorization retrofits only." },
    { id: "treatmentDoing", label: "What is the treatment doing and/or not doing?", type: "textarea",
      help: "For service calls or motorization retrofits only." },
    { id: "topTenFeet", label: "Is the top of the treatment 10' or higher off the ground?", type: "yesno-count",
      help: "If yes, how many?" },
    { id: "controlType", label: "How is the treatment controlled?", type: "checkbox-group",
      options: ["Wall Switch", "Remote", "App or Automation Control", "Manual / Cord", "Other"] },
    { id: "customDraperyOther", label: "If 'Other' above, please describe", type: "text" },
    { id: "designerNotes", label: "See Notes (Designer notes - no character limit)", type: "textarea" }
  ],
  attachmentsHint:
    "Upload Photos and files - cut-down, service call, or retrofit motorization as applicable.",
  additionalNotesLabel: "Additional Notes",
  footerNote:
    "For all your manual or motorized blinds, shades, shutters, and drapery needs call MOTORIZED WINDOW TREATMENTS: 847-732-8552."
};

const MWT_FORM_SCHEMAS = [
  FORM_BLINDS_SHADES,
  FORM_DRAPERY,
  FORM_SERVICE_REQUEST
];

function getFormSchema(formId) {
  return MWT_FORM_SCHEMAS.find((f) => f.id === formId) || null;
}
