/* ============================================================
   MWT Installer Order Manager - config.js
   Edit the values below to change who receives submitted jobs.
   No other file needs to change when these addresses change.
   ============================================================ */

const MWT_CONFIG = {
  // Where Submit & Send actually delivers the finished PDF.
  //
  // The app cannot send real email with an attachment on its own - there
  // is no SMTP capability in a browser, and embedding an email
  // credential directly in this file would expose it to anyone who
  // views the page source. This URL points at a small Google Apps
  // Script "Web App" (see mwt-submit-backend/Code.gs) that receives the
  // PDF and actually emails it - the real recipient addresses live only
  // in that script, never here.
  //
  // CHANGE THIS to your deployed Apps Script Web App URL. It looks like:
  //   https://script.google.com/macros/s/AKfycb.../exec
  submitApiUrl: "https://script.google.com/macros/s/AKfycbxVhAo4XBokM5kkd7LurgDMBdQbbxKWfrYwfiu8t7mNDT4sNRSKeB7O9gIXxMfeZMDu_A/exec",

  // A simple shared value the backend checks before sending anything.
  // This is NOT a real secret (anything in this file is visible to
  // anyone who views the page source) - its only purpose is to stop a
  // stranger who stumbles on the backend URL from spamming Matthew and
  // Katie's inboxes through it. It must match the SHARED_TOKEN constant
  // at the top of Code.gs exactly.
  submitToken: "mwt-installer-2026",

  // The Designer's email is collected on each job (Sold To / Bill To
  // section) but is NOT part of the Submit & Send email recipients -
  // per Matthew's instruction, that email goes only to the two fixed
  // addresses hard-coded server-side in mwt-submit-backend/Code.gs.

  // MWT's fixed shipping/receiving info, printed on every form
  // (matches the current MWT paper/website forms).
  // NOTE: Matthew's 2026 written spec confirms the Ship To phone is
  // 847-710-1172, distinct from the general company/sales phone
  // (847-732-8552) shown in the form header and footer.
  shipTo: {
    companyName: "Motorized Window Treatments",
    contact: "Receiving",
    street: "1521 Bourbon Parkway",
    cityStateZip: "Streamwood, IL 60107",
    phone: "847-710-1172",
    shippingNotes:
      "ORDERS CAN BE RECEIVED at the above address between the hours of 9am - 4pm Monday - Friday. If receiving arrangements need to be made please call the above number."
  },

  companyPhone: "847-732-8552",

  // Roughly how large (in bytes) a job's attachments can get before we
  // warn the installer that offline storage may be getting tight.
  attachmentWarningBytes: 15 * 1024 * 1024, // 15 MB per job

  appVersion: "1.2"
};
